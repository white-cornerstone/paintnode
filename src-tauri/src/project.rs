//! Project folders: manifest, assets, documents, thumbnails, and their commands.

use std::collections::hash_map::DefaultHasher;
#[cfg(unix)]
use std::ffi::CString;
use std::fs;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::io::Write;
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::time::SystemTime;

use base64::Engine;
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
const ASSET_HASH_BUFFER_BYTES: usize = 64 * 1024;
const MAX_HASHABLE_ASSET_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ASSET_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_hash_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_hash_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_hash_modified_at: Option<u128>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_hash_relative_path: Option<String>,
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
            content_hash: None,
            content_hash_state: None,
            content_hash_size: None,
            content_hash_modified_at: None,
            content_hash_relative_path: None,
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
    let nonce = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let temporary = project_path.join(format!(
        ".{PROJECT_MANIFEST}.{}.{}.tmp",
        std::process::id(),
        nonce
    ));
    let result = (|| -> Result<(), String> {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("Failed to create project manifest update: {error}"))?;
        file.write_all(&json)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Failed to write project manifest update: {error}"))?;
        fs::rename(&temporary, &path).map_err(|error| {
            format!(
                "Failed to replace project manifest at {}: {error}",
                path.display()
            )
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn sha256_content_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

fn is_canonical_sha256_content_hash(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

#[cfg(test)]
fn hash_project_asset_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Failed to open project asset for hashing: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; ASSET_HASH_BUFFER_BYTES];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read project asset for hashing: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

enum ProjectAssetFileProbe {
    Missing,
    Unsafe,
    File {
        path: PathBuf,
        size: u64,
        modified_at: u128,
    },
}

fn probe_project_asset_file(project_path: &Path, relative_path: &str) -> ProjectAssetFileProbe {
    let Ok(relative) = safe_project_relative_path(relative_path) else {
        return ProjectAssetFileProbe::Unsafe;
    };
    let Ok(root) = fs::canonicalize(project_path) else {
        return ProjectAssetFileProbe::Unsafe;
    };
    let mut candidate = root.clone();
    for component in relative.components() {
        let std::path::Component::Normal(part) = component else {
            return ProjectAssetFileProbe::Unsafe;
        };
        candidate.push(part);
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return ProjectAssetFileProbe::Unsafe
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return ProjectAssetFileProbe::Missing;
            }
            Err(_) => return ProjectAssetFileProbe::Unsafe,
        }
    }
    let Ok(canonical) = fs::canonicalize(&candidate) else {
        return ProjectAssetFileProbe::Unsafe;
    };
    if !canonical.starts_with(&root) {
        return ProjectAssetFileProbe::Unsafe;
    }
    let Ok(metadata) = fs::metadata(&canonical) else {
        return ProjectAssetFileProbe::Unsafe;
    };
    if !metadata.is_file() || metadata.len() > MAX_HASHABLE_ASSET_BYTES {
        return ProjectAssetFileProbe::Unsafe;
    }
    ProjectAssetFileProbe::File {
        path: canonical.clone(),
        size: metadata.len(),
        modified_at: modified_millis(&canonical),
    }
}

fn replace_asset_hash_state(
    asset: &mut ProjectAsset,
    state: &str,
    hash: Option<String>,
    size: Option<u64>,
    modified_at: Option<u128>,
) -> bool {
    let changed = asset.content_hash_state.as_deref() != Some(state)
        || asset.content_hash != hash
        || asset.content_hash_size != size
        || asset.content_hash_modified_at != modified_at
        || asset.content_hash_relative_path.as_deref() != Some(asset.relative_path.as_str());
    if changed {
        asset.content_hash_state = Some(state.into());
        asset.content_hash = hash;
        asset.content_hash_size = size;
        asset.content_hash_modified_at = modified_at;
        asset.content_hash_relative_path = Some(asset.relative_path.clone());
    }
    changed
}

fn refresh_project_asset_content_hash(project_path: &Path, asset: &mut ProjectAsset) -> bool {
    match probe_project_asset_file(project_path, &asset.relative_path) {
        ProjectAssetFileProbe::Missing => {
            replace_asset_hash_state(asset, "missing", None, None, None)
        }
        ProjectAssetFileProbe::Unsafe => {
            replace_asset_hash_state(asset, "unsafe", None, None, None)
        }
        ProjectAssetFileProbe::File {
            size, modified_at, ..
        } => {
            if asset.content_hash_state.as_deref() == Some("verified")
                && asset
                    .content_hash
                    .as_deref()
                    .is_some_and(is_canonical_sha256_content_hash)
                && asset.content_hash_size == Some(size)
                && asset.content_hash_modified_at == Some(modified_at)
                && asset.content_hash_relative_path.as_deref() == Some(asset.relative_path.as_str())
            {
                return false;
            }
            match hash_confined_project_file(
                project_path,
                &asset.relative_path,
                MAX_HASHABLE_ASSET_BYTES,
            ) {
                Ok((hash, identity)) => replace_asset_hash_state(
                    asset,
                    "verified",
                    Some(hash),
                    Some(identity.size),
                    Some(identity.modified_millis()),
                ),
                Err(_) => replace_asset_hash_state(asset, "unsafe", None, None, None),
            }
        }
    }
}

fn refresh_project_asset_content_hashes(
    project_path: &Path,
    manifest: &mut ProjectManifest,
) -> bool {
    let mut changed = false;
    for asset in &mut manifest.assets {
        changed |= refresh_project_asset_content_hash(project_path, asset);
    }
    changed
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

fn data_url_for_bytes(bytes: &[u8], mime: Option<&str>, relative_path: &str) -> Option<String> {
    let mime = mime
        .map(str::to_string)
        .or_else(|| mime_for_path(Path::new(relative_path)))
        .filter(|mime| mime.starts_with("image/"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

fn thumbnail_data_url_for_asset_bytes(bytes: &[u8], mime: Option<&str>) -> Option<String> {
    let mime = mime?.to_ascii_lowercase();
    if !mime.starts_with("image/") {
        return None;
    }
    if mime == "image/openraster" {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
        for entry_name in ["Thumbnails/thumbnail.png", "mergedimage.png"] {
            let Ok(mut entry) = archive.by_name(entry_name) else {
                continue;
            };
            let mut thumbnail = Vec::new();
            entry.read_to_end(&mut thumbnail).ok()?;
            if is_png(&thumbnail) {
                return png_data_url_from_bytes(&thumbnail);
            }
        }
        return None;
    }
    let image = image::load_from_memory(bytes).ok()?;
    let thumbnail = image
        .thumbnail(PROJECT_THUMBNAIL_MAX_EDGE, PROJECT_THUMBNAIL_MAX_EDGE)
        .to_rgba8();
    let png = encode_rgba_png(thumbnail, "project asset preview").ok()?;
    png_data_url_from_bytes(&png)
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
    let exists = open_confined_project_file(project_path, &asset.relative_path).is_ok();
    let preview_data_url = exists
        .then(|| {
            read_confined_project_file(project_path, &asset.relative_path, MAX_ASSET_PREVIEW_BYTES)
                .ok()
                .and_then(|read| {
                    thumbnail_data_url_for_asset_bytes(&read.bytes, asset.mime.as_deref())
                })
        })
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
            if entry
                .file_type()
                .map(|kind| !kind.is_file() || kind.is_symlink())
                .unwrap_or(true)
            {
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
    let mut manifest = load_manifest(project_path)?;
    if refresh_project_asset_content_hashes(project_path, &mut manifest) {
        save_manifest(project_path, &manifest)?;
    }
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

#[derive(Clone, Debug, Eq, PartialEq)]
struct ConfinedFileIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    size: u64,
    modified_seconds: i64,
    modified_nanoseconds: i64,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanoseconds: i64,
}

impl ConfinedFileIdentity {
    #[cfg(unix)]
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            size: metadata.len(),
            modified_seconds: metadata.mtime(),
            modified_nanoseconds: metadata.mtime_nsec(),
            changed_seconds: metadata.ctime(),
            changed_nanoseconds: metadata.ctime_nsec(),
        }
    }

    #[cfg(not(unix))]
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok());
        Self {
            size: metadata.len(),
            modified_seconds: modified
                .as_ref()
                .map(|duration| duration.as_secs() as i64)
                .unwrap_or_default(),
            modified_nanoseconds: modified
                .map(|duration| duration.subsec_nanos() as i64)
                .unwrap_or_default(),
        }
    }

    fn modified_millis(&self) -> u128 {
        if self.modified_seconds < 0 || self.modified_nanoseconds < 0 {
            return 0;
        }
        (self.modified_seconds as u128) * 1_000 + (self.modified_nanoseconds as u128) / 1_000_000
    }
}

#[cfg(unix)]
fn open_confined_project_file(project_path: &Path, relative_path: &str) -> Result<File, String> {
    let relative = safe_project_relative_path(relative_path)?;
    let root = fs::canonicalize(project_path)
        .map_err(|error| format!("Project folder is unavailable: {error}"))?;
    let root_name = CString::new(root.as_os_str().as_bytes())
        .map_err(|_| "Project folder path is invalid.".to_string())?;
    let root_fd = unsafe {
        libc::open(
            root_name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if root_fd < 0 {
        return Err(format!(
            "Project folder could not be opened safely: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut current = unsafe { File::from_raw_fd(root_fd) };
    let components = relative.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let std::path::Component::Normal(part) = component else {
            return Err("Project file path is invalid.".into());
        };
        let name = CString::new(part.as_bytes())
            .map_err(|_| "Project file path is invalid.".to_string())?;
        let final_component = index + 1 == components.len();
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | if final_component {
                0
            } else {
                libc::O_DIRECTORY
            };
        let next_fd = unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), flags) };
        if next_fd < 0 {
            return Err(format!(
                "Project file could not be opened safely: {}",
                std::io::Error::last_os_error()
            ));
        }
        current = unsafe { File::from_raw_fd(next_fd) };
    }
    let metadata = current
        .metadata()
        .map_err(|error| format!("Project file metadata is unavailable: {error}"))?;
    if !metadata.is_file() {
        return Err("Project file path does not identify a regular file.".into());
    }
    Ok(current)
}

#[cfg(not(unix))]
fn open_confined_project_file(project_path: &Path, relative_path: &str) -> Result<File, String> {
    match probe_project_asset_file(project_path, relative_path) {
        ProjectAssetFileProbe::File { path, .. } => File::open(path)
            .map_err(|error| format!("Project file could not be opened safely: {error}")),
        ProjectAssetFileProbe::Missing => Err("Project file is missing.".into()),
        ProjectAssetFileProbe::Unsafe => Err("Project file path is unsafe.".into()),
    }
}

struct ConfinedFileRead {
    bytes: Vec<u8>,
    identity: ConfinedFileIdentity,
}

fn confined_file_identity_is_stable(
    project_path: &Path,
    relative_path: &str,
    file: &File,
    before: &ConfinedFileIdentity,
    bytes_read: u64,
) -> Result<bool, String> {
    let after = ConfinedFileIdentity::from_metadata(
        &file
            .metadata()
            .map_err(|error| format!("Project file metadata is unavailable: {error}"))?,
    );
    let current_path_file = open_confined_project_file(project_path, relative_path)?;
    let current_path = ConfinedFileIdentity::from_metadata(
        &current_path_file
            .metadata()
            .map_err(|error| format!("Project file metadata is unavailable: {error}"))?,
    );
    Ok(*before == after && *before == current_path && before.size == bytes_read)
}

fn hash_confined_project_file(
    project_path: &Path,
    relative_path: &str,
    byte_limit: u64,
) -> Result<(String, ConfinedFileIdentity), String> {
    let mut file = open_confined_project_file(project_path, relative_path)?;
    let before = ConfinedFileIdentity::from_metadata(
        &file
            .metadata()
            .map_err(|error| format!("Project file metadata is unavailable: {error}"))?,
    );
    if before.size > byte_limit {
        return Err(format!(
            "Project file exceeds the safe read limit of {byte_limit} bytes."
        ));
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; ASSET_HASH_BUFFER_BYTES];
    let mut total = 0_u64;
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read project file safely: {error}"))?;
        if count == 0 {
            break;
        }
        total = total.saturating_add(count as u64);
        if total > byte_limit {
            return Err(format!(
                "Project file exceeds the safe read limit of {byte_limit} bytes."
            ));
        }
        hasher.update(&buffer[..count]);
    }
    if !confined_file_identity_is_stable(project_path, relative_path, &file, &before, total)? {
        return Err(
            "Project file changed while it was being hashed; refresh and try again.".into(),
        );
    }
    Ok((format!("sha256:{:x}", hasher.finalize()), before))
}

fn read_confined_project_file(
    project_path: &Path,
    relative_path: &str,
    byte_limit: u64,
) -> Result<ConfinedFileRead, String> {
    let mut file = open_confined_project_file(project_path, relative_path)?;
    let before_metadata = file
        .metadata()
        .map_err(|error| format!("Project file metadata is unavailable: {error}"))?;
    let before = ConfinedFileIdentity::from_metadata(&before_metadata);
    if before.size > byte_limit {
        return Err(format!(
            "Project file exceeds the safe read limit of {byte_limit} bytes."
        ));
    }
    let mut bytes = Vec::with_capacity(before.size.min(16 * 1024 * 1024) as usize);
    std::io::Read::by_ref(&mut file)
        .take(byte_limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read project file safely: {error}"))?;
    if bytes.len() as u64 > byte_limit {
        return Err(format!(
            "Project file exceeds the safe read limit of {byte_limit} bytes."
        ));
    }
    if !confined_file_identity_is_stable(
        project_path,
        relative_path,
        &file,
        &before,
        bytes.len() as u64,
    )? {
        return Err("Project file changed while it was being read; refresh and try again.".into());
    }
    Ok(ConfinedFileRead {
        bytes,
        identity: before,
    })
}

pub(crate) fn add_asset(
    project_path: &Path,
    mut asset: ProjectAsset,
) -> Result<ProjectAssetView, String> {
    refresh_project_asset_content_hash(project_path, &mut asset);
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
        let content_hash_modified_at = modified_millis(&project_dir.join(&relative_path));
        let content_hash_relative_path = relative_path.clone();
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
            content_hash: Some(sha256_content_hash(&bytes)),
            content_hash_state: Some("verified".into()),
            content_hash_size: Some(bytes.len() as u64),
            content_hash_modified_at: Some(content_hash_modified_at),
            content_hash_relative_path: Some(content_hash_relative_path),
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
    tauri::async_runtime::spawn_blocking(move || {
        read_project_asset(Path::new(project_path.trim()), &asset_id)
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

fn read_project_asset(project_path: &Path, asset_id: &str) -> Result<StoredAssetResult, String> {
    let mut manifest = load_manifest(project_path)?;
    let index = manifest
        .assets
        .iter()
        .position(|asset| asset.id == asset_id)
        .ok_or_else(|| "Asset is not in this project.".to_string())?;
    let relative_path = manifest.assets[index].relative_path.clone();
    let read =
        match read_confined_project_file(project_path, &relative_path, MAX_HASHABLE_ASSET_BYTES) {
            Ok(read) => read,
            Err(error) => {
                let changed = match probe_project_asset_file(project_path, &relative_path) {
                    ProjectAssetFileProbe::Missing => replace_asset_hash_state(
                        &mut manifest.assets[index],
                        "missing",
                        None,
                        None,
                        None,
                    ),
                    ProjectAssetFileProbe::Unsafe | ProjectAssetFileProbe::File { .. } => {
                        replace_asset_hash_state(
                            &mut manifest.assets[index],
                            "unsafe",
                            None,
                            None,
                            None,
                        )
                    }
                };
                if changed {
                    save_manifest(project_path, &manifest)?;
                }
                return Err(format!("Asset could not be read safely: {error}"));
            }
        };
    let hash = sha256_content_hash(&read.bytes);
    if replace_asset_hash_state(
        &mut manifest.assets[index],
        "verified",
        Some(hash),
        Some(read.identity.size),
        Some(read.identity.modified_millis()),
    ) {
        save_manifest(project_path, &manifest)?;
    }
    let asset = manifest.assets[index].clone();
    let data_url = data_url_for_bytes(&read.bytes, asset.mime.as_deref(), &asset.relative_path)
        .ok_or_else(|| "Asset is not a previewable image or is missing.".to_string())?;
    let preview_data_url = thumbnail_data_url_for_asset_bytes(&read.bytes, asset.mime.as_deref());
    Ok(StoredAssetResult {
        data_url,
        asset: ProjectAssetView {
            asset,
            preview_data_url,
            exists: true,
        },
    })
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
            match probe_project_asset_file(&project_dir, &asset.relative_path) {
                ProjectAssetFileProbe::File { path, .. } => reveal_path(&path),
                ProjectAssetFileProbe::Missing => Err("Asset file is missing.".into()),
                ProjectAssetFileProbe::Unsafe => {
                    Err("Asset path is unsafe and cannot be revealed.".into())
                }
            }
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
        match probe_project_asset_file(&project_dir, &relative_path) {
            ProjectAssetFileProbe::File { path, .. } => reveal_path(&path),
            ProjectAssetFileProbe::Missing => Err("Project file is missing.".into()),
            ProjectAssetFileProbe::Unsafe => {
                Err("Project file path is unsafe and cannot be revealed.".into())
            }
        }
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
        read_confined_project_file(&project_dir, &relative_path, MAX_HASHABLE_ASSET_BYTES)
            .map(|read| read.bytes)
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
        match probe_project_asset_file(&project_dir, &asset.relative_path) {
            ProjectAssetFileProbe::File { path, .. } => {
                trash::delete(&path)
                    .map_err(|e| format!("Failed to move asset to system trash: {e}"))?;
            }
            ProjectAssetFileProbe::Missing => {}
            ProjectAssetFileProbe::Unsafe => {
                return Err("Asset path is unsafe and cannot be deleted.".into());
            }
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

    fn test_asset(relative_path: &str) -> ProjectAsset {
        ProjectAsset {
            id: "legacy".into(),
            kind: "imported".into(),
            name: "Legacy.png".into(),
            relative_path: relative_path.into(),
            created_at: 1,
            prompt: None,
            source_file_name: Some("Legacy.png".into()),
            width: Some(1),
            height: Some(1),
            mime: Some("image/png".into()),
            content_hash: None,
            content_hash_state: None,
            content_hash_size: None,
            content_hash_modified_at: None,
            content_hash_relative_path: None,
        }
    }

    #[test]
    fn project_asset_content_hash_is_stable_sha256() {
        assert_eq!(
            sha256_content_hash(b"abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_ne!(sha256_content_hash(b"abc"), sha256_content_hash(b"abd"));
        assert!(is_canonical_sha256_content_hash(
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        ));
        assert!(!is_canonical_sha256_content_hash("sha256:abc"));
        assert!(!is_canonical_sha256_content_hash(
            "sha256:BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"
        ));
    }

    #[test]
    fn project_state_backfills_missing_asset_hash_once() {
        let project = TempJobDir::new("paintnode-project-hash-backfill").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let relative_path = "assets/imported/legacy.png";
        fs::write(project.path().join(relative_path), ONE_PIXEL_PNG).expect("legacy asset");
        let mut manifest = new_manifest(project.path());
        manifest.assets.push(test_asset(relative_path));
        save_manifest(project.path(), &manifest).expect("legacy manifest");

        let mut first = load_manifest(project.path()).expect("legacy manifest");
        assert!(refresh_project_asset_content_hashes(
            project.path(),
            &mut first
        ));
        save_manifest(project.path(), &first).expect("persist backfill");
        let expected = sha256_content_hash(ONE_PIXEL_PNG);
        assert_eq!(
            first.assets[0].content_hash.as_deref(),
            Some(expected.as_str())
        );
        assert_eq!(
            first.assets[0].content_hash_state.as_deref(),
            Some("verified")
        );
        let persisted = load_manifest(project.path()).expect("persisted manifest");
        assert_eq!(
            persisted.assets[0].content_hash.as_deref(),
            Some(expected.as_str())
        );
        let updated_at = persisted.updated_at;

        let mut second = load_manifest(project.path()).expect("already backfilled project");
        assert!(!refresh_project_asset_content_hashes(
            project.path(),
            &mut second
        ));
        assert_eq!(
            second.assets[0].content_hash.as_deref(),
            Some(expected.as_str())
        );
        assert_eq!(
            load_manifest(project.path()).expect("manifest").updated_at,
            updated_at
        );
    }

    #[test]
    fn project_asset_hash_revalidates_malformed_and_tampered_files() {
        let project = TempJobDir::new("paintnode-project-hash-revalidate").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let relative = "assets/imported/source.png";
        fs::write(project.path().join(relative), b"original").expect("source");
        let mut manifest = new_manifest(project.path());
        let mut asset = test_asset(relative);
        asset.content_hash = Some("sha256:not-canonical".into());
        asset.content_hash_state = Some("verified".into());
        asset.content_hash_size = Some(8);
        asset.content_hash_modified_at = Some(modified_millis(&project.path().join(relative)));
        manifest.assets.push(asset);

        assert!(refresh_project_asset_content_hashes(
            project.path(),
            &mut manifest
        ));
        let original_hash = sha256_content_hash(b"original");
        assert_eq!(
            manifest.assets[0].content_hash.as_deref(),
            Some(original_hash.as_str())
        );

        fs::write(project.path().join(relative), b"tampered-content").expect("tamper");
        assert!(refresh_project_asset_content_hashes(
            project.path(),
            &mut manifest
        ));
        assert_eq!(
            manifest.assets[0].content_hash.as_deref(),
            Some(sha256_content_hash(b"tampered-content").as_str())
        );
        assert_ne!(
            manifest.assets[0].content_hash.as_deref(),
            Some(original_hash.as_str())
        );
    }

    #[test]
    fn project_asset_hash_tracks_missing_reappeared_and_moved_files_without_retrying() {
        let project = TempJobDir::new("paintnode-project-hash-missing").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let mut manifest = new_manifest(project.path());
        manifest
            .assets
            .push(test_asset("assets/imported/missing.png"));

        assert!(refresh_project_asset_content_hashes(
            project.path(),
            &mut manifest
        ));
        assert_eq!(
            manifest.assets[0].content_hash_state.as_deref(),
            Some("missing")
        );
        assert!(manifest.assets[0].content_hash.is_none());
        assert!(!refresh_project_asset_content_hashes(
            project.path(),
            &mut manifest
        ));

        fs::write(
            project.path().join("assets/imported/missing.png"),
            b"reappeared",
        )
        .expect("reappear");
        assert!(refresh_project_asset_content_hashes(
            project.path(),
            &mut manifest
        ));
        assert_eq!(
            manifest.assets[0].content_hash_state.as_deref(),
            Some("verified")
        );
        assert_eq!(
            manifest.assets[0].content_hash.as_deref(),
            Some(sha256_content_hash(b"reappeared").as_str())
        );

        fs::write(project.path().join("assets/imported/moved.png"), b"moved").expect("moved");
        manifest.assets[0].relative_path = "assets/imported/moved.png".into();
        assert!(refresh_project_asset_content_hashes(
            project.path(),
            &mut manifest
        ));
        assert_eq!(
            manifest.assets[0].content_hash.as_deref(),
            Some(sha256_content_hash(b"moved").as_str())
        );
    }

    #[test]
    fn project_asset_hash_rejects_absolute_and_traversal_paths() {
        let project = TempJobDir::new("paintnode-project-hash-paths").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let outside = project
            .path()
            .parent()
            .expect("parent")
            .join("paintnode-outside-hash-secret");
        fs::write(&outside, b"outside-secret").expect("outside");
        let mut manifest = new_manifest(project.path());
        manifest
            .assets
            .push(test_asset("../paintnode-outside-hash-secret"));
        manifest
            .assets
            .push(test_asset(outside.to_string_lossy().as_ref()));

        assert!(refresh_project_asset_content_hashes(
            project.path(),
            &mut manifest
        ));
        for asset in &manifest.assets {
            assert_eq!(asset.content_hash_state.as_deref(), Some("unsafe"));
            assert!(asset.content_hash.is_none());
        }
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn unsafe_asset_paths_are_refused_by_view_and_read_boundaries() {
        let project = TempJobDir::new("paintnode-project-unsafe-read").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let outside = project
            .path()
            .parent()
            .expect("project parent")
            .join("paintnode-project-unsafe-read-secret.png");
        fs::write(&outside, ONE_PIXEL_PNG).expect("outside secret");
        let mut manifest = new_manifest(project.path());
        manifest.assets.push(test_asset(
            outside
                .strip_prefix(project.path())
                .unwrap_or(Path::new("../paintnode-project-unsafe-read-secret.png"))
                .to_string_lossy()
                .as_ref(),
        ));
        manifest.assets[0].relative_path = "../paintnode-project-unsafe-read-secret.png".into();
        save_manifest(project.path(), &manifest).expect("unsafe manifest");

        let state = project_state(project.path()).expect("project state");
        assert!(!state.assets[0].exists);
        assert!(state.assets[0].preview_data_url.is_none());
        assert_eq!(
            state.assets[0].asset.content_hash_state.as_deref(),
            Some("unsafe")
        );
        let error = read_project_asset(project.path(), "legacy").expect_err("unsafe read");
        assert!(error.contains("safely"));
        assert!(!error.contains("outside-secret"));
        let _ = fs::remove_file(outside);
    }

    #[test]
    fn asset_read_rehashes_same_size_replacement_with_preserved_mtime() {
        let project = TempJobDir::new("paintnode-project-read-rehash").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let relative = "assets/imported/source.png";
        let path = project.path().join(relative);
        fs::write(&path, ONE_PIXEL_PNG).expect("source");
        let mut manifest = new_manifest(project.path());
        manifest.assets.push(test_asset(relative));
        assert!(refresh_project_asset_content_hashes(
            project.path(),
            &mut manifest
        ));
        let original_hash = manifest.assets[0].content_hash.clone();
        save_manifest(project.path(), &manifest).expect("verified manifest");
        let original_modified = fs::metadata(&path)
            .and_then(|metadata| metadata.modified())
            .expect("original modified time");

        let mut replacement = ONE_PIXEL_PNG.to_vec();
        let last = replacement.last_mut().expect("PNG byte");
        *last ^= 0x01;
        fs::write(&path, &replacement).expect("same-size replacement");
        File::open(&path)
            .expect("replacement file")
            .set_times(fs::FileTimes::new().set_modified(original_modified))
            .expect("restore modified time");
        assert_eq!(
            fs::metadata(&path).expect("replacement metadata").len(),
            ONE_PIXEL_PNG.len() as u64
        );
        assert_eq!(
            modified_millis(&path),
            manifest.assets[0]
                .content_hash_modified_at
                .unwrap_or_default()
        );

        read_project_asset(project.path(), "legacy").expect("safe asset read");
        let persisted = load_manifest(project.path()).expect("rehash manifest");
        assert_eq!(
            persisted.assets[0].content_hash.as_deref(),
            Some(sha256_content_hash(&replacement).as_str())
        );
        assert_ne!(persisted.assets[0].content_hash, original_hash);
        assert_eq!(
            persisted.assets[0].content_hash_state.as_deref(),
            Some("verified")
        );
    }

    #[test]
    fn asset_read_refuses_sparse_files_above_the_byte_cap() {
        let project = TempJobDir::new("paintnode-project-read-cap").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let relative = "assets/imported/oversized.png";
        let path = project.path().join(relative);
        File::create(&path)
            .and_then(|file| file.set_len(MAX_HASHABLE_ASSET_BYTES + 1))
            .expect("sparse oversized asset");
        let mut manifest = new_manifest(project.path());
        manifest.assets.push(test_asset(relative));
        save_manifest(project.path(), &manifest).expect("oversized manifest");

        let error = read_project_asset(project.path(), "legacy").expect_err("oversized read");
        assert!(error.contains("safe read limit"));
        let persisted = load_manifest(project.path()).expect("unsafe manifest");
        assert_eq!(
            persisted.assets[0].content_hash_state.as_deref(),
            Some("unsafe")
        );
        assert!(persisted.assets[0].content_hash.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn project_asset_hash_rejects_symlinks_even_when_the_target_is_inside_the_project() {
        use std::os::unix::fs::symlink;
        let project = TempJobDir::new("paintnode-project-hash-symlink").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let target = project.path().join("assets/imported/target.png");
        let link = project.path().join("assets/imported/link.png");
        fs::write(&target, b"target").expect("target");
        symlink(&target, &link).expect("symlink");
        let mut manifest = new_manifest(project.path());
        manifest.assets.push(test_asset("assets/imported/link.png"));

        assert!(refresh_project_asset_content_hashes(
            project.path(),
            &mut manifest
        ));
        assert_eq!(
            manifest.assets[0].content_hash_state.as_deref(),
            Some("unsafe")
        );
        assert!(manifest.assets[0].content_hash.is_none());
        let view = asset_view(project.path(), manifest.assets[0].clone());
        assert!(!view.exists);
        assert!(view.preview_data_url.is_none());
        save_manifest(project.path(), &manifest).expect("unsafe symlink manifest");
        assert!(read_project_asset(project.path(), "legacy").is_err());
    }

    #[test]
    fn project_asset_hash_streams_large_files_and_add_asset_covers_imported_and_generated() {
        let project = TempJobDir::new("paintnode-project-hash-stream").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let large = vec![42_u8; 2 * 1024 * 1024 + 123];
        let large_path = project.path().join("assets/imported/large.bin");
        fs::write(&large_path, &large).expect("large file");
        assert_eq!(
            hash_project_asset_file(&large_path).expect("streaming hash"),
            sha256_content_hash(&large)
        );

        let mut large_asset = test_asset("assets/imported/large.bin");
        large_asset.mime = Some("application/octet-stream".into());
        let imported = add_asset(project.path(), large_asset).expect("imported");
        assert_eq!(
            imported.asset.content_hash_state.as_deref(),
            Some("verified")
        );
        let generated_path = "assets/generated/generated.bin";
        fs::write(project.path().join(generated_path), ONE_PIXEL_PNG).expect("generated file");
        let mut generated_asset = ProjectAsset::generated_png(
            "generated".into(),
            generated_path.into(),
            "Generated.png".into(),
            Some("fixture".into()),
            None,
        );
        generated_asset.mime = Some("application/octet-stream".into());
        let generated = add_asset(project.path(), generated_asset).expect("generated");
        assert_eq!(
            generated.asset.content_hash_state.as_deref(),
            Some("verified")
        );

        let api = serde_json::to_value(generated).expect("API JSON");
        assert!(api["contentHash"].as_str().is_some());
        assert_eq!(api["contentHashState"], "verified");
        assert!(api.get("content_hash").is_none());
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
