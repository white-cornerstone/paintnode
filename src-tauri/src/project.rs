//! Project folders: manifest, assets, documents, thumbnails, and their commands.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::time::SystemTime;

use base64::Engine;
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use serde::Deserialize;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri::Manager;

use crate::ai::{ensure_agent_run_dirs, now_id, TempJobDir, PAINTNODE_WORK_DIR};
use crate::png::{encode_rgba_png, is_png, png_data_url_from_bytes};

const PROJECT_MANIFEST: &str = "paintnode.project.json";

const DEFAULT_PROJECT_DIR_NAME: &str = "PaintNode";

const PROJECT_THUMBNAIL_MAX_EDGE: u32 = 160;
const PROJECT_MATERIAL_MAX_BYTES: u64 = 64 * 1024 * 1024;
const PROJECT_MANIFEST_MAX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ProjectManifest {
    version: u32,
    name: String,
    created_at: u128,
    updated_at: u128,
    document_path: String,
    assets: Vec<ProjectAsset>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectAsset {
    id: String,
    kind: String,
    name: String,
    relative_path: String,
    created_at: u128,
    prompt: Option<String>,
    source_file_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    mime: Option<String>,
}

impl ProjectAsset {
    pub(crate) fn generated_png(
        id: String,
        relative_path: String,
        name: String,
        prompt: Option<String>,
        source_file_name: Option<String>,
    ) -> Self {
        Self {
            id,
            kind: "generated".into(),
            name,
            relative_path,
            created_at: now_id(),
            prompt,
            source_file_name,
            width: None,
            height: None,
            mime: Some("image/png".into()),
        }
    }

    pub(crate) fn with_dimensions(mut self, width: u32, height: u32) -> Self {
        self.width = Some(width);
        self.height = Some(height);
        self
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectState {
    path: String,
    name: String,
    document_path: String,
    assets: Vec<ProjectAssetView>,
    files: Vec<ProjectFileView>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectAssetView {
    #[serde(flatten)]
    asset: ProjectAsset,
    preview_data_url: Option<String>,
    exists: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectFileView {
    kind: String,
    name: String,
    relative_path: String,
    created_at: u128,
    modified_at: u128,
    size: u64,
    mime: Option<String>,
    preview_data_url: Option<String>,
    exists: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredAssetResult {
    data_url: String,
    asset: ProjectAssetView,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectAssetMaterialResult {
    bytes: Vec<u8>,
    content_hash: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedDocumentResult {
    relative_path: String,
    name: String,
}

fn project_manifest_path(project_path: &Path) -> PathBuf {
    project_path.join(PROJECT_MANIFEST)
}

pub(crate) fn ensure_project_dirs(project_path: &Path) -> Result<(), String> {
    fs::create_dir_all(project_path.join("documents"))
        .map_err(|e| format!("Failed to create documents folder: {e}"))?;
    fs::create_dir_all(project_path.join("storyboards"))
        .map_err(|e| format!("Failed to create storyboards folder: {e}"))?;
    fs::create_dir_all(project_path.join("autosave"))
        .map_err(|e| format!("Failed to create autosave folder: {e}"))?;
    fs::create_dir_all(project_path.join("assets").join("generated"))
        .map_err(|e| format!("Failed to create generated assets folder: {e}"))?;
    fs::create_dir_all(project_path.join("assets").join("imported"))
        .map_err(|e| format!("Failed to create imported assets folder: {e}"))?;
    ensure_agent_run_dirs(project_path)?;
    fs::create_dir_all(project_path.join(PAINTNODE_WORK_DIR).join("thumbnails"))
        .map_err(|e| format!("Failed to create project thumbnail cache folder: {e}"))?;
    Ok(())
}

pub(crate) fn default_documents_project_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|e| format!("Failed to locate the Documents folder: {e}"))?;
    Ok(documents.join(DEFAULT_PROJECT_DIR_NAME))
}

fn default_project_name(path: &Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("PaintNode Project")
        .to_string()
}

fn new_manifest(project_path: &Path) -> ProjectManifest {
    let now = now_id();
    ProjectManifest {
        version: 1,
        name: default_project_name(project_path),
        created_at: now,
        updated_at: now,
        document_path: "document.ora".into(),
        assets: vec![],
    }
}

fn load_manifest(project_path: &Path) -> Result<ProjectManifest, String> {
    ensure_project_dirs(project_path)?;
    let path = project_manifest_path(project_path);
    if !path.exists() {
        let manifest = new_manifest(project_path);
        save_manifest(project_path, &manifest)?;
        return Ok(manifest);
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read project manifest at {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("Project manifest is invalid JSON: {e}"))
}

fn save_manifest(project_path: &Path, manifest: &ProjectManifest) -> Result<(), String> {
    ensure_project_dirs(project_path)?;
    let mut next = manifest.clone();
    next.updated_at = now_id();
    let json = serde_json::to_vec_pretty(&next)
        .map_err(|e| format!("Failed to serialize project manifest: {e}"))?;
    let path = project_manifest_path(project_path);
    fs::write(&path, json).map_err(|e| {
        format!(
            "Failed to write project manifest at {}: {e}",
            path.display()
        )
    })
}

pub(crate) fn safe_stem(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars().flat_map(|c| c.to_lowercase()) {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
        } else if matches!(ch, ' ' | '-' | '_' | '.') && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 48 {
            break;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "asset".into()
    } else {
        out
    }
}

fn file_ext_for_mime(name: &str, mime: Option<&str>) -> String {
    if let Some(ext) = Path::new(name).extension().and_then(|s| s.to_str()) {
        let ext = ext.to_ascii_lowercase();
        if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif") {
            return ext;
        }
    }
    match mime.unwrap_or("") {
        "image/jpeg" => "jpg".into(),
        "image/webp" => "webp".into(),
        "image/gif" => "gif".into(),
        _ => "png".into(),
    }
}

pub(crate) fn mime_for_path(path: &Path) -> Option<String> {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Some("image/png".into()),
        "jpg" | "jpeg" => Some("image/jpeg".into()),
        "webp" => Some("image/webp".into()),
        "gif" => Some("image/gif".into()),
        "psd" => Some("image/vnd.adobe.photoshop".into()),
        _ => None,
    }
}

fn data_url_for_file(path: &Path, mime: Option<&str>) -> Option<String> {
    let mime = mime
        .map(str::to_string)
        .or_else(|| mime_for_path(path))
        .filter(|m| m.starts_with("image/"))?;
    let bytes = fs::read(path).ok()?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

fn project_thumbnail_cache_dir(project_path: &Path) -> PathBuf {
    project_path.join(PAINTNODE_WORK_DIR).join("thumbnails")
}

fn project_thumbnail_cache_path(
    project_path: &Path,
    source_path: &Path,
    max_edge: u32,
) -> Option<PathBuf> {
    let mut hasher = DefaultHasher::new();
    source_path.to_string_lossy().hash(&mut hasher);
    path_size(source_path).hash(&mut hasher);
    modified_millis(source_path).hash(&mut hasher);
    max_edge.hash(&mut hasher);
    Some(
        project_thumbnail_cache_dir(project_path)
            .join(format!("thumb-{:016x}.png", hasher.finish())),
    )
}

#[cfg(target_os = "macos")]
fn write_os_thumbnail(source_path: &Path, output_path: &Path, max_edge: u32) -> bool {
    let Ok(temp) = TempJobDir::new("paintnode-quicklook-thumb") else {
        return false;
    };
    let Ok(status) = Command::new("/usr/bin/qlmanage")
        .arg("-t")
        .arg("-s")
        .arg(max_edge.to_string())
        .arg("-o")
        .arg(temp.path())
        .arg(source_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    else {
        return false;
    };
    if !status.success() {
        return false;
    }
    let Ok(entries) = fs::read_dir(temp.path()) else {
        return false;
    };
    let mut newest: Option<(SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file()
            || !path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
        {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        if newest
            .as_ref()
            .map(|(current, _)| modified > *current)
            .unwrap_or(true)
        {
            newest = Some((modified, path));
        }
    }
    let Some((_, thumbnail_path)) = newest else {
        return false;
    };
    fs::copy(&thumbnail_path, output_path).is_ok()
}

#[cfg(not(target_os = "macos"))]
fn write_os_thumbnail(_source_path: &Path, _output_path: &Path, _max_edge: u32) -> bool {
    false
}

fn write_resized_thumbnail(source_path: &Path, output_path: &Path, max_edge: u32) -> bool {
    let Ok(bytes) = fs::read(source_path) else {
        return false;
    };
    let Ok(image) = image::load_from_memory(&bytes) else {
        return false;
    };
    let thumbnail = image.thumbnail(max_edge, max_edge).to_rgba8();
    let Ok(bytes) = encode_rgba_png(thumbnail, "project thumbnail") else {
        return false;
    };
    fs::write(output_path, bytes).is_ok()
}

fn thumbnail_data_url_for_file(
    project_path: &Path,
    path: &Path,
    mime: Option<&str>,
) -> Option<String> {
    let mime = mime
        .map(str::to_string)
        .or_else(|| mime_for_path(path))
        .filter(|m| m.starts_with("image/"))?;
    if mime == "image/openraster" || is_openraster_path(path) {
        return ora_thumbnail_data_url(path);
    }
    let cache_path = project_thumbnail_cache_path(project_path, path, PROJECT_THUMBNAIL_MAX_EDGE)?;
    if let Ok(bytes) = fs::read(&cache_path) {
        if let Some(data_url) = png_data_url_from_bytes(&bytes) {
            return Some(data_url);
        }
    }
    let _ = fs::create_dir_all(project_thumbnail_cache_dir(project_path));
    if !write_os_thumbnail(path, &cache_path, PROJECT_THUMBNAIL_MAX_EDGE)
        && !write_resized_thumbnail(path, &cache_path, PROJECT_THUMBNAIL_MAX_EDGE)
    {
        return None;
    }
    fs::read(cache_path)
        .ok()
        .and_then(|bytes| png_data_url_from_bytes(&bytes))
}

fn is_openraster_path(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("ora"))
}

fn is_workflow_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|name| name.to_ascii_lowercase().ends_with(".cxflow.json"))
}

fn ora_thumbnail_data_url(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;

    for entry_name in ["Thumbnails/thumbnail.png", "mergedimage.png"] {
        let Ok(mut entry) = archive.by_name(entry_name) else {
            continue;
        };
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).ok()?;
        if !is_png(&bytes) {
            continue;
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Some(format!("data:image/png;base64,{b64}"));
    }

    None
}

fn preview_data_url_for_project_file(
    project_path: &Path,
    path: &Path,
    mime: Option<&str>,
) -> Option<String> {
    if is_openraster_path(path) || mime == Some("image/openraster") {
        return ora_thumbnail_data_url(path);
    }
    thumbnail_data_url_for_file(project_path, path, mime)
}

fn modified_millis(path: &Path) -> u128 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn created_millis(path: &Path) -> u128 {
    fs::metadata(path)
        .and_then(|m| m.created().or_else(|_| m.modified()))
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn path_size(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn asset_view(project_path: &Path, asset: ProjectAsset) -> ProjectAssetView {
    let path = project_path.join(&asset.relative_path);
    let exists = path.exists();
    let preview_data_url = exists
        .then(|| thumbnail_data_url_for_file(project_path, &path, asset.mime.as_deref()))
        .flatten();
    ProjectAssetView {
        asset,
        preview_data_url,
        exists,
    }
}

fn is_hidden_project_file_name(name: &str) -> bool {
    name.starts_with('.')
}

fn scan_project_files(project_path: &Path) -> Vec<ProjectFileView> {
    let folders = [
        ("document", PathBuf::from("documents")),
        ("storyboard", PathBuf::from("storyboards")),
        ("autosave", PathBuf::from("autosave")),
        ("generated", PathBuf::from("assets").join("generated")),
        ("imported", PathBuf::from("assets").join("imported")),
    ];
    let mut files = Vec::new();

    for (kind, relative_dir) in folders {
        let absolute_dir = project_path.join(&relative_dir);
        let Ok(entries) = fs::read_dir(&absolute_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("file")
                .to_string();
            if is_hidden_project_file_name(&name) {
                continue;
            }
            let relative = relative_dir.join(&name);
            let is_workflow = is_workflow_path(&path);
            let mime = mime_for_path(&path)
                .or_else(|| is_openraster_path(&path).then(|| "image/openraster".to_string()))
                .or_else(|| {
                    is_workflow.then(|| "application/vnd.paintnode.workflow+json".to_string())
                });
            files.push(ProjectFileView {
                kind: if is_workflow {
                    "workflow".into()
                } else {
                    kind.to_string()
                },
                name,
                relative_path: relative.to_string_lossy().replace('\\', "/"),
                created_at: created_millis(&path),
                modified_at: modified_millis(&path),
                size: path_size(&path),
                preview_data_url: preview_data_url_for_project_file(
                    project_path,
                    &path,
                    mime.as_deref(),
                ),
                mime,
                exists: true,
            });
        }
    }

    files.sort_by_key(|file| std::cmp::Reverse(file.modified_at));
    files
}

fn project_state(project_path: &Path) -> Result<ProjectState, String> {
    let manifest = load_manifest(project_path)?;
    let mut assets = manifest
        .assets
        .into_iter()
        .map(|asset| asset_view(project_path, asset))
        .collect::<Vec<_>>();
    assets.sort_by_key(|asset| std::cmp::Reverse(asset.asset.created_at));
    Ok(ProjectState {
        path: project_path.to_string_lossy().to_string(),
        name: manifest.name,
        document_path: project_path
            .join("document.ora")
            .to_string_lossy()
            .to_string(),
        assets,
        files: scan_project_files(project_path),
    })
}

pub(crate) fn write_asset_file(
    project_path: &Path,
    kind: &str,
    name: &str,
    ext: &str,
    bytes: &[u8],
) -> Result<(String, String), String> {
    ensure_project_dirs(project_path)?;
    let id = format!("asset-{}", now_id());
    let rel_dir = match kind {
        "generated" => PathBuf::from("assets").join("generated"),
        _ => PathBuf::from("assets").join("imported"),
    };
    let file_name = format!(
        "{}-{}.{}",
        safe_stem(name),
        id.trim_start_matches("asset-"),
        ext
    );
    let relative = rel_dir.join(file_name);
    let absolute = project_path.join(&relative);
    let mut file = fs::File::create(&absolute)
        .map_err(|e| format!("Failed to create asset file at {}: {e}", absolute.display()))?;
    file.write_all(bytes)
        .map_err(|e| format!("Failed to write asset file at {}: {e}", absolute.display()))?;
    Ok((id, relative.to_string_lossy().replace('\\', "/")))
}

pub(crate) fn safe_file_name(file_name: &str) -> Option<String> {
    let path = Path::new(file_name);
    let name = path.file_name()?.to_str()?.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || !matches!(
            Path::new(name)
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s.to_ascii_lowercase())
                .as_deref(),
            Some("png")
        )
    {
        return None;
    }
    Some(name.to_string())
}

pub(crate) fn write_asset_file_with_file_name(
    project_path: &Path,
    kind: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<(String, String), String> {
    ensure_project_dirs(project_path)?;
    let id = format!("asset-{}", now_id());
    let rel_dir = match kind {
        "generated" => PathBuf::from("assets").join("generated"),
        _ => PathBuf::from("assets").join("imported"),
    };
    let file_name = safe_file_name(file_name)
        .ok_or_else(|| "Generated asset filename is invalid.".to_string())?;
    let relative = rel_dir.join(file_name);
    let absolute = project_path.join(&relative);
    fs::write(&absolute, bytes)
        .map_err(|e| format!("Failed to write asset file at {}: {e}", absolute.display()))?;
    Ok((id, relative.to_string_lossy().replace('\\', "/")))
}

fn safe_document_file_name(name: &str) -> String {
    let path = Path::new(name.trim());
    if path
        .file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|file_name| file_name.to_ascii_lowercase().ends_with(".cxflow.json"))
    {
        let stem = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("workflow.cxflow.json")
            .trim_end_matches(".json")
            .trim_end_matches(".cxflow");
        return format!("{}.cxflow.json", safe_stem(stem));
    }
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(name);
    format!("{}.ora", safe_stem(stem))
}

fn saved_document_display_name(path: &Path, fallback_name: &str, is_workflow: bool) -> String {
    let Some(file_name) = path
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
    else {
        return fallback_name.to_string();
    };
    if is_workflow {
        return file_name.to_string();
    }
    path.file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(fallback_name)
        .to_string()
}

fn save_as_extension_for_name(name: &str) -> &'static str {
    let lower = name.trim().to_ascii_lowercase();
    if lower.ends_with(".cxflow.json") {
        "cxflow.json"
    } else if lower.ends_with(".psd") {
        "psd"
    } else {
        "ora"
    }
}

fn save_as_path_has_expected_extension(path: &Path, extension: &str) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|file_name| {
            let lower = file_name.to_ascii_lowercase();
            if extension == "cxflow.json" {
                lower.ends_with(".cxflow.json")
            } else {
                lower.ends_with(&format!(".{extension}"))
            }
        })
}

fn remove_autosave_for_name(project_path: &Path, name: &str) {
    let file_name = safe_document_file_name(name);
    let stem = Path::new(&file_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled");
    let autosave_dir = project_path.join("autosave");
    let _ = fs::remove_file(autosave_dir.join(&file_name));
    if let Ok(entries) = fs::read_dir(&autosave_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(existing_stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let is_ora = path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("ora"));
            if is_ora && existing_stem.starts_with(&format!("{stem}-")) {
                let _ = fs::remove_file(path);
            }
        }
    }
}

fn write_document_file(
    project_path: &Path,
    name: &str,
    bytes: &[u8],
    autosave: bool,
) -> Result<String, String> {
    ensure_project_dirs(project_path)?;
    let file_name = safe_document_file_name(name);
    let relative = if autosave {
        remove_autosave_for_name(project_path, name);
        PathBuf::from("autosave").join(file_name)
    } else {
        PathBuf::from("documents").join(file_name)
    };
    let absolute = project_path.join(&relative);
    if let Some(parent) = absolute.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create document folder: {e}"))?;
    }
    fs::write(&absolute, bytes)
        .map_err(|e| format!("Failed to write document at {}: {e}", absolute.display()))?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn safe_project_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative_path.trim());
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err("Project file path is invalid.".into());
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(part) => clean.push(part),
            _ => return Err("Project file path is invalid.".into()),
        }
    }
    Ok(clean)
}

fn ensure_no_project_symlink(dir: &Dir, relative: &Path) -> Result<(), String> {
    let mut prefix = PathBuf::new();
    for component in relative.components() {
        let std::path::Component::Normal(part) = component else {
            return Err("Project material path is invalid.".into());
        };
        prefix.push(part);
        let metadata = dir
            .symlink_metadata(&prefix)
            .map_err(|error| format!("Project material is unavailable: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Project material cannot be read through a symbolic link.".into());
        }
    }
    Ok(())
}

fn read_capability_file_once(
    dir: &Dir,
    relative: &Path,
    byte_limit: u64,
) -> Result<Vec<u8>, String> {
    ensure_no_project_symlink(dir, relative)?;
    let mut file = dir
        .open(relative)
        .map_err(|error| format!("Project material could not be opened safely: {error}"))?;
    ensure_no_project_symlink(dir, relative)?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Project material metadata is unavailable: {error}"))?;
    if !metadata.is_file() {
        return Err("Project material is not a regular file.".into());
    }
    if metadata.len() > byte_limit {
        return Err(format!(
            "Project material exceeds the safe read limit of {byte_limit} bytes."
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len().min(8 * 1024 * 1024) as usize);
    std::io::Read::by_ref(&mut file)
        .take(byte_limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Project material could not be read safely: {error}"))?;
    if bytes.len() as u64 > byte_limit {
        return Err(format!(
            "Project material exceeds the safe read limit of {byte_limit} bytes."
        ));
    }
    ensure_no_project_symlink(dir, relative)?;
    Ok(bytes)
}

fn read_stable_capability_file(
    dir: &Dir,
    relative: &Path,
    byte_limit: u64,
) -> Result<Vec<u8>, String> {
    let bytes = read_capability_file_once(dir, relative, byte_limit)?;
    ensure_no_project_symlink(dir, relative)?;
    let mut file = dir
        .open(relative)
        .map_err(|error| format!("Project material could not be reopened safely: {error}"))?;
    ensure_no_project_symlink(dir, relative)?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Project material metadata is unavailable: {error}"))?;
    if !metadata.is_file() || metadata.len() > byte_limit {
        return Err(
            "Project material changed while it was being read; refresh and try again.".into(),
        );
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut length = 0_u64;
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Project material could not be verified safely: {error}"))?;
        if count == 0 {
            break;
        }
        length = length.saturating_add(count as u64);
        if length > byte_limit {
            return Err(format!(
                "Project material exceeds the safe read limit of {byte_limit} bytes."
            ));
        }
        hasher.update(&buffer[..count]);
    }
    ensure_no_project_symlink(dir, relative)?;
    if bytes.len() as u64 != length
        || format!("{:x}", Sha256::digest(&bytes)) != format!("{:x}", hasher.finalize())
    {
        return Err(
            "Project material changed while it was being read; refresh and try again.".into(),
        );
    }
    Ok(bytes)
}

fn resolve_project_asset_material(
    project_path: &Path,
    asset_id: &str,
) -> Result<ProjectAssetMaterialResult, String> {
    let trimmed_asset_id = asset_id.trim();
    if trimmed_asset_id.is_empty()
        || trimmed_asset_id != asset_id
        || trimmed_asset_id.len() > 160
        || trimmed_asset_id.contains("..")
        || !trimmed_asset_id.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b':' | b'-'))
        })
    {
        return Err("Project asset ID is invalid.".into());
    }
    let dir = Dir::open_ambient_dir(project_path, ambient_authority())
        .map_err(|error| format!("Project folder could not be opened safely: {error}"))?;
    let manifest_bytes = read_stable_capability_file(
        &dir,
        Path::new(PROJECT_MANIFEST),
        PROJECT_MANIFEST_MAX_BYTES,
    )?;
    let manifest: ProjectManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("Project manifest is invalid JSON: {error}"))?;
    let mut matches = manifest
        .assets
        .into_iter()
        .filter(|asset| asset.id == trimmed_asset_id);
    let asset = matches
        .next()
        .ok_or_else(|| "Asset is not in this project.".to_string())?;
    if matches.next().is_some() {
        return Err("Project asset ID is ambiguous.".into());
    }
    let relative = safe_project_relative_path(&asset.relative_path)?;
    let bytes = read_stable_capability_file(&dir, &relative, PROJECT_MATERIAL_MAX_BYTES)?;
    let content_hash = format!("sha256:{:x}", Sha256::digest(&bytes));
    Ok(ProjectAssetMaterialResult {
        bytes,
        content_hash,
    })
}

pub(crate) fn add_asset(
    project_path: &Path,
    asset: ProjectAsset,
) -> Result<ProjectAssetView, String> {
    let mut manifest = load_manifest(project_path)?;
    manifest.assets.retain(|existing| existing.id != asset.id);
    manifest.assets.push(asset.clone());
    save_manifest(project_path, &manifest)?;
    Ok(asset_view(project_path, asset))
}

pub(crate) fn store_generated_png_asset(
    project_dir: &Path,
    bytes: &[u8],
    name: String,
    prompt: Option<String>,
    source_file_name: Option<String>,
) -> Result<ProjectAssetView, String> {
    let (id, relative_path) = write_asset_file(project_dir, "generated", &name, "png", bytes)?;
    add_asset(
        project_dir,
        ProjectAsset::generated_png(id, relative_path, name, prompt, source_file_name),
    )
}

#[tauri::command]
pub(crate) async fn project_open_folder(project_path: String) -> Result<ProjectState, String> {
    let path = PathBuf::from(project_path.trim());
    tauri::async_runtime::spawn_blocking(move || project_state(&path))
        .await
        .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub(crate) async fn project_refresh(project_path: String) -> Result<ProjectState, String> {
    tauri::async_runtime::spawn_blocking(move || project_state(Path::new(project_path.trim())))
        .await
        .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
// The arguments are the existing Tauri IPC payload; changing their shape is an API migration.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn project_store_asset_bytes(
    project_path: String,
    name: String,
    bytes: Vec<u8>,
    kind: String,
    prompt: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    mime: Option<String>,
) -> Result<StoredAssetResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<StoredAssetResult, String> {
        let project_dir = PathBuf::from(project_path.trim());
        let kind = if kind == "generated" {
            "generated"
        } else {
            "imported"
        };
        let ext = file_ext_for_mime(&name, mime.as_deref());
        let (id, relative_path) = write_asset_file(&project_dir, kind, &name, &ext, &bytes)?;
        let asset = ProjectAsset {
            id,
            kind: kind.into(),
            name: name.clone(),
            relative_path,
            created_at: now_id(),
            prompt,
            source_file_name: Some(name),
            width,
            height,
            mime: mime.or_else(|| mime_for_path(Path::new(&format!("asset.{ext}")))),
        };
        let asset = add_asset(&project_dir, asset)?;
        let path = project_dir.join(&asset.asset.relative_path);
        let data_url = data_url_for_file(&path, asset.asset.mime.as_deref())
            .ok_or_else(|| "Stored asset is not a previewable image.".to_string())?;
        Ok(StoredAssetResult { data_url, asset })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub(crate) async fn project_read_asset(
    project_path: String,
    asset_id: String,
) -> Result<StoredAssetResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<StoredAssetResult, String> {
        let project_dir = PathBuf::from(project_path.trim());
        let manifest = load_manifest(&project_dir)?;
        let asset = manifest
            .assets
            .into_iter()
            .find(|asset| asset.id == asset_id)
            .ok_or_else(|| "Asset is not in this project.".to_string())?;
        let view = asset_view(&project_dir, asset);
        let path = project_dir.join(&view.asset.relative_path);
        let data_url = data_url_for_file(&path, view.asset.mime.as_deref())
            .ok_or_else(|| "Asset is not a previewable image or is missing.".to_string())?;
        Ok(StoredAssetResult {
            data_url,
            asset: view,
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub(crate) async fn project_resolve_asset_material(
    project_path: String,
    asset_id: String,
) -> Result<ProjectAssetMaterialResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_project_asset_material(Path::new(project_path.trim()), &asset_id)
    })
    .await
    .map_err(|error| format!("Task error: {error}"))?
}

fn reveal_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = Command::new("open");
        c.arg("-R").arg(path);
        c
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = Command::new("explorer");
        c.arg("/select,").arg(path);
        c
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut c = Command::new("xdg-open");
        c.arg(path.parent().unwrap_or(path));
        c
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to reveal {}: {e}", path.display()))
}

#[tauri::command]
pub(crate) async fn project_reveal(
    project_path: String,
    asset_id: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let project_dir = PathBuf::from(project_path.trim());
        if let Some(asset_id) = asset_id {
            let manifest = load_manifest(&project_dir)?;
            let asset = manifest
                .assets
                .into_iter()
                .find(|asset| asset.id == asset_id)
                .ok_or_else(|| "Asset is not in this project.".to_string())?;
            reveal_path(&project_dir.join(asset.relative_path))
        } else {
            reveal_path(&project_dir)
        }
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub(crate) async fn project_reveal_file(
    project_path: String,
    relative_path: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let project_dir = PathBuf::from(project_path.trim());
        let relative = safe_project_relative_path(&relative_path)?;
        reveal_path(&project_dir.join(relative))
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub(crate) async fn project_read_file(
    project_path: String,
    relative_path: String,
) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let project_dir = PathBuf::from(project_path.trim());
        let relative = safe_project_relative_path(&relative_path)?;
        let path = project_dir.join(relative);
        fs::read(&path)
            .map_err(|e| format!("Failed to read project file at {}: {e}", path.display()))
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub(crate) async fn project_delete_asset(
    project_path: String,
    asset_id: String,
) -> Result<ProjectState, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<ProjectState, String> {
        let project_dir = PathBuf::from(project_path.trim());
        let mut manifest = load_manifest(&project_dir)?;
        let Some(index) = manifest
            .assets
            .iter()
            .position(|asset| asset.id == asset_id)
        else {
            return project_state(&project_dir);
        };
        let asset = manifest.assets[index].clone();
        let source = project_dir.join(&asset.relative_path);
        if source.exists() {
            trash::delete(&source)
                .map_err(|e| format!("Failed to move asset to system trash: {e}"))?;
        }
        manifest.assets.remove(index);
        save_manifest(&project_dir, &manifest)?;
        project_state(&project_dir)
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub(crate) async fn project_write_document(
    project_path: String,
    name: String,
    bytes: Vec<u8>,
    autosave: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let project_dir = PathBuf::from(project_path.trim());
        write_document_file(&project_dir, &name, &bytes, autosave)
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub(crate) async fn project_write_document_path(
    project_path: Option<String>,
    path: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err("Saved document path is empty.".into());
        }

        let project_dir = project_path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from);
        let absolute = if Path::new(trimmed).is_absolute() {
            PathBuf::from(trimmed)
        } else if let Some(project_dir) = &project_dir {
            project_dir.join(safe_project_relative_path(trimmed)?)
        } else {
            return Err("Saved document path is relative but no project is open.".into());
        };

        if let Some(parent) = absolute.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create document folder: {e}"))?;
        }
        fs::write(&absolute, bytes)
            .map_err(|e| format!("Failed to write document at {}: {e}", absolute.display()))?;

        let display_path = if let Some(project_dir) = &project_dir {
            absolute
                .strip_prefix(project_dir)
                .map(|relative| relative.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| absolute.to_string_lossy().to_string())
        } else {
            absolute.to_string_lossy().to_string()
        };
        Ok(display_path)
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub(crate) async fn project_save_document_as(
    project_path: Option<String>,
    target_path: String,
    name: String,
    previous_name: Option<String>,
    bytes: Vec<u8>,
) -> Result<SavedDocumentResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<SavedDocumentResult, String> {
        let project_dir = project_path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from);
        let mut path = PathBuf::from(target_path.trim());
        if path.as_os_str().is_empty() {
            return Err("No save path was selected.".into());
        }
        let extension = save_as_extension_for_name(&name);
        let is_workflow = extension == "cxflow.json";
        let has_expected_extension = save_as_path_has_expected_extension(&path, extension);
        if !has_expected_extension {
            path.set_extension(extension);
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create document folder: {e}"))?;
        }
        fs::write(&path, bytes)
            .map_err(|e| format!("Failed to write document at {}: {e}", path.display()))?;

        if let (Some(project_dir), Some(previous_name)) = (&project_dir, previous_name.as_deref()) {
            let previous_file_name = safe_document_file_name(previous_name);
            let current_file_name = path
                .file_name()
                .and_then(|s| s.to_str())
                .map(safe_document_file_name)
                .unwrap_or_else(|| safe_document_file_name(&name));
            if previous_file_name != current_file_name {
                remove_autosave_for_name(project_dir, previous_name);
            }
        }

        let display_path = if let Some(project_dir) = &project_dir {
            path.strip_prefix(project_dir)
                .map(|relative| relative.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| path.to_string_lossy().to_string())
        } else {
            path.to_string_lossy().to_string()
        };
        let name = saved_document_display_name(&path, "Untitled", is_workflow);
        Ok(SavedDocumentResult {
            relative_path: display_path,
            name,
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::png::file_has_png_signature;
    use crate::test_util::{png_dimensions_from_data_url, ONE_PIXEL_PNG};

    fn material_asset(id: &str, relative_path: &str) -> ProjectAsset {
        ProjectAsset {
            id: id.into(),
            kind: "imported".into(),
            name: "Material.png".into(),
            relative_path: relative_path.into(),
            created_at: 1,
            prompt: None,
            source_file_name: Some("Material.png".into()),
            width: Some(1),
            height: Some(1),
            mime: Some("image/png".into()),
        }
    }

    #[test]
    fn project_asset_material_returns_exact_bytes_and_hash_without_manifest_writes() {
        let project = TempJobDir::new("paintnode-material-read").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let relative = "assets/imported/material.png";
        fs::write(project.path().join(relative), ONE_PIXEL_PNG).expect("asset bytes");
        let mut manifest = new_manifest(project.path());
        manifest.assets.push(material_asset("material", relative));
        save_manifest(project.path(), &manifest).expect("manifest");
        let before = fs::read(project_manifest_path(project.path())).expect("manifest before");

        let result = resolve_project_asset_material(project.path(), "material").expect("material");

        assert_eq!(result.bytes, ONE_PIXEL_PNG);
        assert_eq!(
            result.content_hash,
            format!("sha256:{:x}", Sha256::digest(ONE_PIXEL_PNG))
        );
        assert_eq!(
            fs::read(project_manifest_path(project.path())).expect("manifest after"),
            before
        );
    }

    #[test]
    fn project_asset_material_rejects_traversal_absolute_and_duplicate_ids() {
        let project = TempJobDir::new("paintnode-material-invalid").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let outside = project
            .path()
            .parent()
            .expect("parent")
            .join("material-secret.png");
        fs::write(&outside, b"outside-secret").expect("outside");
        let mut manifest = new_manifest(project.path());
        manifest
            .assets
            .push(material_asset("traversal", "../material-secret.png"));
        manifest.assets.push(material_asset(
            "absolute",
            outside.to_string_lossy().as_ref(),
        ));
        manifest
            .assets
            .push(material_asset("duplicate", "assets/imported/one.png"));
        manifest
            .assets
            .push(material_asset("duplicate", "assets/imported/two.png"));
        save_manifest(project.path(), &manifest).expect("manifest");

        for id in ["traversal", "absolute", "duplicate"] {
            assert!(
                resolve_project_asset_material(project.path(), id).is_err(),
                "{id}"
            );
        }
        assert!(resolve_project_asset_material(project.path(), "../traversal").is_err());
        let _ = fs::remove_file(outside);
    }

    #[cfg(unix)]
    #[test]
    fn project_asset_material_rejects_final_and_intermediate_symlinks() {
        use std::os::unix::fs::symlink;
        let project = TempJobDir::new("paintnode-material-symlink").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let outside = TempJobDir::new("paintnode-material-outside").expect("outside dir");
        fs::write(outside.path().join("secret.png"), ONE_PIXEL_PNG).expect("outside asset");
        symlink(
            outside.path().join("secret.png"),
            project.path().join("assets/imported/final-link.png"),
        )
        .expect("final symlink");
        symlink(
            outside.path(),
            project.path().join("assets/intermediate-link"),
        )
        .expect("intermediate symlink");
        let mut manifest = new_manifest(project.path());
        manifest.assets.push(material_asset(
            "final-link",
            "assets/imported/final-link.png",
        ));
        manifest.assets.push(material_asset(
            "intermediate-link",
            "assets/intermediate-link/secret.png",
        ));
        save_manifest(project.path(), &manifest).expect("manifest");

        for id in ["final-link", "intermediate-link"] {
            let error = resolve_project_asset_material(project.path(), id).expect_err("symlink");
            assert!(error.contains("symbolic link"), "{error}");
        }
    }

    #[test]
    fn project_asset_material_enforces_conservative_read_cap() {
        let project = TempJobDir::new("paintnode-material-cap").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let relative = "assets/imported/oversized.png";
        fs::File::create(project.path().join(relative))
            .and_then(|file| file.set_len(PROJECT_MATERIAL_MAX_BYTES + 1))
            .expect("sparse oversized asset");
        let mut manifest = new_manifest(project.path());
        manifest.assets.push(material_asset("oversized", relative));
        save_manifest(project.path(), &manifest).expect("manifest");

        let error = resolve_project_asset_material(project.path(), "oversized")
            .expect_err("oversized asset");
        assert!(error.contains("safe read limit"));
    }

    #[test]
    fn project_file_preview_uses_cached_thumbnail() {
        let project = TempJobDir::new("paintnode-project-thumbnail-test").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let image = image::RgbaImage::from_fn(400, 200, |x, y| {
            image::Rgba([x as u8, y as u8, (x / 2) as u8, 255])
        });
        let bytes = encode_rgba_png(image, "large preview source").expect("source png");
        let path = project
            .path()
            .join("assets")
            .join("generated")
            .join("large.png");
        fs::write(&path, bytes).expect("write source");

        let preview = preview_data_url_for_project_file(project.path(), &path, Some("image/png"))
            .expect("preview thumbnail");
        assert!(preview.starts_with("data:image/png;base64,"));
        let (width, height) = png_dimensions_from_data_url(&preview);
        assert_eq!(width.max(height), PROJECT_THUMBNAIL_MAX_EDGE);

        let cache_path =
            project_thumbnail_cache_path(project.path(), &path, PROJECT_THUMBNAIL_MAX_EDGE)
                .expect("cache path");
        assert!(cache_path.exists(), "thumbnail should be cached");
    }

    #[test]
    fn psd_project_file_preview_enters_thumbnail_pipeline() {
        let project = TempJobDir::new("paintnode-psd-thumbnail-test").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let image =
            image::RgbaImage::from_fn(240, 120, |x, y| image::Rgba([x as u8, y as u8, 180, 255]));
        let bytes = encode_rgba_png(image, "psd extension preview source").expect("source png");
        let path = project.path().join("documents").join("mock.psd");
        fs::write(&path, bytes).expect("write source");

        assert_eq!(
            mime_for_path(&path).as_deref(),
            Some("image/vnd.adobe.photoshop")
        );
        let preview = preview_data_url_for_project_file(project.path(), &path, None)
            .expect("psd extension should not be rejected before thumbnail generation");
        assert!(preview.starts_with("data:image/png;base64,"));
        let (width, height) = png_dimensions_from_data_url(&preview);
        assert_eq!(width.max(height), PROJECT_THUMBNAIL_MAX_EDGE);
    }

    #[test]
    fn ora_thumbnail_data_url_reads_embedded_thumbnail() {
        let job = TempJobDir::new("paintnode-ora-thumb-test").expect("temp dir");
        let path = job.path().join("document.ora");
        let file = fs::File::create(&path).expect("ora file");
        let mut archive = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        archive.start_file("mimetype", options).expect("mimetype");
        archive
            .write_all(b"image/openraster")
            .expect("mimetype bytes");
        archive
            .start_file("Thumbnails/thumbnail.png", options)
            .expect("thumbnail");
        archive.write_all(ONE_PIXEL_PNG).expect("thumbnail bytes");
        archive.finish().expect("finish archive");

        let data_url = ora_thumbnail_data_url(&path).expect("thumbnail data url");
        assert!(data_url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn ora_thumbnail_data_url_falls_back_to_merged_image() {
        let job = TempJobDir::new("paintnode-ora-merged-test").expect("temp dir");
        let path = job.path().join("document.ora");
        let file = fs::File::create(&path).expect("ora file");
        let mut archive = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        archive.start_file("mimetype", options).expect("mimetype");
        archive
            .write_all(b"image/openraster")
            .expect("mimetype bytes");
        archive
            .start_file("mergedimage.png", options)
            .expect("merged image");
        archive.write_all(ONE_PIXEL_PNG).expect("merged bytes");
        archive.finish().expect("finish archive");

        let data_url = ora_thumbnail_data_url(&path).expect("merged data url");
        assert!(data_url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn safe_document_file_name_preserves_workflow_extension() {
        assert_eq!(
            safe_document_file_name("Beach Board.cxflow.json"),
            "beach-board.cxflow.json"
        );
        assert_eq!(safe_document_file_name("demo.ora"), "demo.ora");
    }

    #[test]
    fn write_asset_file_with_file_name_preserves_codex_file_name() {
        let project = TempJobDir::new("paintnode-project-name-test").expect("project dir");
        let file_name = "ig_0f6db9989b73e69c016a3b96d9b9fc819582dae7e57bdcbc48.png";

        let (_id, relative_path) =
            write_asset_file_with_file_name(project.path(), "generated", file_name, ONE_PIXEL_PNG)
                .expect("write asset");

        assert_eq!(relative_path, format!("assets/generated/{file_name}"));
        assert!(file_has_png_signature(
            &project
                .path()
                .join("assets")
                .join("generated")
                .join(file_name)
        ));
    }

    #[test]
    fn scan_project_files_excludes_hidden_metadata_files() {
        let project = TempJobDir::new("paintnode-hidden-files-test").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        fs::write(
            project.path().join("documents").join("tram-2.ora"),
            ONE_PIXEL_PNG,
        )
        .expect("document");
        fs::write(project.path().join("documents").join(".DS_Store"), b"meta").expect("metadata");
        fs::write(project.path().join("autosave").join(".DS_Store"), b"meta")
            .expect("autosave metadata");

        let files = scan_project_files(project.path());
        let names = files
            .iter()
            .map(|file| file.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["tram-2.ora"]);
    }

    #[test]
    fn saved_document_display_name_preserves_workflow_suffix() {
        assert_eq!(
            saved_document_display_name(Path::new("/tmp/sketch.ora"), "Untitled", false),
            "sketch"
        );
        assert_eq!(
            saved_document_display_name(Path::new("/tmp/board.cxflow.json"), "Untitled", true),
            "board.cxflow.json"
        );
    }

    #[test]
    fn save_as_extension_for_name_supports_psd_exports() {
        assert_eq!(save_as_extension_for_name("sketch.psd"), "psd");
        assert_eq!(save_as_extension_for_name("sketch.PSD"), "psd");
        assert_eq!(save_as_extension_for_name("sketch.ora"), "ora");
        assert_eq!(
            save_as_extension_for_name("board.cxflow.json"),
            "cxflow.json"
        );
    }

    #[test]
    fn ensure_project_dirs_does_not_create_project_trash() {
        let project = TempJobDir::new("paintnode-no-project-trash-test").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");

        assert!(!project
            .path()
            .join(PAINTNODE_WORK_DIR)
            .join("trash")
            .exists());
        assert!(project
            .path()
            .join(PAINTNODE_WORK_DIR)
            .join("thumbnails")
            .exists());
    }

    #[test]
    fn save_as_path_has_expected_extension_supports_psd_exports() {
        assert!(save_as_path_has_expected_extension(
            Path::new("/tmp/sketch.psd"),
            "psd"
        ));
        assert!(!save_as_path_has_expected_extension(
            Path::new("/tmp/sketch.ora"),
            "psd"
        ));
        assert!(save_as_path_has_expected_extension(
            Path::new("/tmp/board.cxflow.json"),
            "cxflow.json"
        ));
    }

    #[test]
    fn autosave_document_overwrites_same_file_and_cleans_timestamped_versions() {
        let project = TempJobDir::new("paintnode-autosave-overwrite-test").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let old_timestamped = project
            .path()
            .join("autosave")
            .join("untitled-123456789.ora");
        fs::write(&old_timestamped, b"old").expect("old autosave");

        let first =
            write_document_file(project.path(), "untitled.ora", b"first", true).expect("first");
        let second =
            write_document_file(project.path(), "untitled.ora", b"second", true).expect("second");

        assert_eq!(first, "autosave/untitled.ora");
        assert_eq!(second, "autosave/untitled.ora");
        assert_eq!(
            fs::read(project.path().join("autosave").join("untitled.ora")).expect("autosave"),
            b"second"
        );
        assert!(!old_timestamped.exists());
    }
}
