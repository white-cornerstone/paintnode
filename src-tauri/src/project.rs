//! Project folders: manifest, assets, documents, thumbnails, and their commands.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

use base64::Engine;
use cap_fs_ext::{FollowSymlinks, OpenOptions, OpenOptionsFollowExt, OpenOptionsSyncExt};
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
const PROJECT_MATERIAL_MAX_BYTES: u64 = 32 * 1024 * 1024;
const PROJECT_MANIFEST_MAX_BYTES: u64 = 4 * 1024 * 1024;
const PROJECT_MATERIAL_ENVELOPE_MAGIC: &[u8; 8] = b"PNMATRAW";
const PROJECT_MATERIAL_ENVELOPE_VERSION: u16 = 1;
const PROJECT_MATERIAL_METADATA_MAX_BYTES: usize = 4 * 1024;

// Strong ownership is intentional: transaction poison must remain durable after
// the last active operation drops its Arc. The registry grows by one small mutex
// per canonical project opened during the process lifetime.
static PROJECT_TRANSACTIONS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

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
pub(crate) struct WorkflowEditorDocumentResult {
    relative_path: String,
    content_hash: String,
    mime: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowEditorReturnResult {
    document: WorkflowEditorDocumentResult,
    output: ProjectAssetView,
    output_content_hash: String,
    cleanup_token: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowEditorReturnReceipt {
    revision_id: String,
    asset_id: String,
    document_relative_path: String,
    output_relative_path: String,
    document_content_hash: String,
    output_content_hash: String,
    #[serde(default)]
    committed: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct ProjectAssetMaterialResult {
    asset_id: String,
    relative_path: String,
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

fn project_transaction(project_path: &Path) -> Result<Arc<Mutex<()>>, String> {
    ensure_project_dirs(project_path)?;
    let canonical_path = fs::canonicalize(project_path).map_err(|error| {
        format!(
            "Failed to identify the project transaction boundary at {}: {error}",
            project_path.display()
        )
    })?;
    let transactions = PROJECT_TRANSACTIONS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut transactions = transactions
        .lock()
        .map_err(|_| "Project transaction registry is unavailable.".to_string())?;
    if let Some(transaction) = transactions.get(&canonical_path) {
        return Ok(Arc::clone(transaction));
    }
    let transaction = Arc::new(Mutex::new(()));
    transactions.insert(canonical_path, Arc::clone(&transaction));
    Ok(transaction)
}

fn with_project_transaction<T>(
    project_path: &Path,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    with_project_transaction_observed(project_path, || {}, operation)
}

fn with_project_transaction_observed<T>(
    project_path: &Path,
    on_contention: impl FnOnce(),
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let transaction = project_transaction(project_path)?;
    let _guard = match transaction.try_lock() {
        Ok(guard) => guard,
        Err(std::sync::TryLockError::WouldBlock) => {
            on_contention();
            transaction.lock().map_err(|_| {
                "Project transaction was interrupted and cannot continue safely.".to_string()
            })?
        }
        Err(std::sync::TryLockError::Poisoned(_)) => {
            return Err(
                "Project transaction was interrupted and cannot continue safely.".to_string(),
            );
        }
    };
    operation()
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
    load_manifest_observed(project_path, || {})
}

fn load_manifest_observed(
    project_path: &Path,
    before_initialize: impl FnOnce(),
) -> Result<ProjectManifest, String> {
    ensure_project_dirs(project_path)?;
    let path = project_manifest_path(project_path);
    if path.exists() {
        return read_manifest(&path);
    }
    before_initialize();
    with_project_transaction(project_path, || load_manifest_unlocked(project_path))
}

fn load_manifest_unlocked(project_path: &Path) -> Result<ProjectManifest, String> {
    ensure_project_dirs(project_path)?;
    let path = project_manifest_path(project_path);
    if !path.exists() {
        save_manifest_atomic(project_path, &new_manifest(project_path))?;
    }
    read_manifest(&path)
}

fn read_manifest(path: &Path) -> Result<ProjectManifest, String> {
    let text = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read project manifest at {}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("Project manifest is invalid JSON: {e}"))
}

#[cfg(test)]
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

fn save_manifest_atomic(project_path: &Path, manifest: &ProjectManifest) -> Result<(), String> {
    ensure_project_dirs(project_path)?;
    let mut next = manifest.clone();
    next.updated_at = now_id();
    let json = serde_json::to_vec_pretty(&next)
        .map_err(|e| format!("Failed to serialize project manifest: {e}"))?;
    let path = project_manifest_path(project_path);
    let temporary = path.with_extension(format!("json.{}.tmp", now_id()));
    write_new_synced(&temporary, &json)?;
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Failed to commit project manifest atomically: {error}"
        ));
    }
    Ok(())
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

fn open_project_material_file(dir: &Dir, relative: &Path) -> Result<cap_std::fs::File, String> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    dir.open_with(relative, &options)
        .map_err(|error| format!("Project material could not be opened safely: {error}"))
}

fn read_capability_file_once(
    dir: &Dir,
    relative: &Path,
    byte_limit: u64,
) -> Result<Vec<u8>, String> {
    ensure_no_project_symlink(dir, relative)?;
    let mut file = open_project_material_file(dir, relative)?;
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
    let mut file = open_project_material_file(dir, relative)?;
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
        asset_id: asset.id,
        relative_path: asset.relative_path,
        bytes,
        content_hash,
    })
}

fn encode_project_asset_material(material: ProjectAssetMaterialResult) -> Result<Vec<u8>, String> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Metadata<'a> {
        asset_id: &'a str,
        relative_path: &'a str,
        content_hash: &'a str,
    }
    let metadata = serde_json::to_vec(&Metadata {
        asset_id: &material.asset_id,
        relative_path: &material.relative_path,
        content_hash: &material.content_hash,
    })
    .map_err(|error| format!("Project material metadata could not be encoded: {error}"))?;
    if metadata.len() > PROJECT_MATERIAL_METADATA_MAX_BYTES {
        return Err("Project material metadata exceeds the safe envelope limit.".into());
    }
    if material.bytes.len() as u64 > PROJECT_MATERIAL_MAX_BYTES {
        return Err("Project material exceeds the safe envelope limit.".into());
    }
    let metadata_len = u32::try_from(metadata.len())
        .map_err(|_| "Project material metadata is too large.".to_string())?;
    let material_len = u32::try_from(material.bytes.len())
        .map_err(|_| "Project material is too large.".to_string())?;
    let mut envelope = Vec::with_capacity(18 + metadata.len() + material.bytes.len());
    envelope.extend_from_slice(PROJECT_MATERIAL_ENVELOPE_MAGIC);
    envelope.extend_from_slice(&PROJECT_MATERIAL_ENVELOPE_VERSION.to_be_bytes());
    envelope.extend_from_slice(&metadata_len.to_be_bytes());
    envelope.extend_from_slice(&material_len.to_be_bytes());
    envelope.extend_from_slice(&metadata);
    envelope.extend_from_slice(&material.bytes);
    Ok(envelope)
}

pub(crate) fn add_asset(
    project_path: &Path,
    asset: ProjectAsset,
) -> Result<ProjectAssetView, String> {
    add_asset_with_transaction_observer(project_path, asset, || {})
}

fn add_asset_with_transaction_observer(
    project_path: &Path,
    asset: ProjectAsset,
    on_contention: impl FnOnce(),
) -> Result<ProjectAssetView, String> {
    with_project_transaction_observed(project_path, on_contention, || {
        let mut manifest = load_manifest_unlocked(project_path)?;
        manifest.assets.retain(|existing| existing.id != asset.id);
        manifest.assets.push(asset.clone());
        save_manifest_atomic(project_path, &manifest)
    })?;
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

fn valid_editor_revision_id(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 160
        && !value.contains("..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn write_new_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = options.open(path).map_err(|error| {
        format!(
            "Workflow editor return could not create {}: {error}",
            path.display()
        )
    })?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| {
            format!(
                "Workflow editor return could not write {}: {error}",
                path.display()
            )
        })
}

fn promote_new_file(staged: &Path, destination: &Path) -> Result<(), String> {
    fs::hard_link(staged, destination).map_err(|error| {
        format!(
            "Workflow editor return could not commit new file {}: {error}",
            destination.display()
        )
    })?;
    fs::remove_file(staged).map_err(|error| {
        let _ = fs::remove_file(destination);
        format!(
            "Workflow editor return could not finish committing {}: {error}",
            destination.display()
        )
    })
}

fn workflow_editor_receipt_path(project_dir: &Path, cleanup_token: &str) -> PathBuf {
    project_dir
        .join(PAINTNODE_WORK_DIR)
        .join("workflow-editor-returns")
        .join("receipts")
        .join(format!("{cleanup_token}.json"))
}

fn workflow_editor_cleanup_token() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| {
        format!("Workflow editor cleanup capability could not be generated: {error}")
    })?;
    Ok(format!(
        "return-{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn rollback_workflow_editor_return_unlocked(
    project_dir: &Path,
    cleanup_token: &str,
    persist_manifest: &dyn Fn(&Path, &ProjectManifest) -> Result<(), String>,
) -> Result<(), String> {
    let receipt_path = workflow_editor_receipt_path(project_dir, cleanup_token);
    if !receipt_path.exists() {
        return Ok(());
    }
    let receipt_metadata = fs::symlink_metadata(&receipt_path).map_err(|error| {
        format!("Workflow editor cleanup receipt metadata could not be read: {error}")
    })?;
    if receipt_metadata.file_type().is_symlink() || !receipt_metadata.is_file() {
        return Err("Workflow editor cleanup receipt must be a regular non-symlink file.".into());
    }
    let receipt: WorkflowEditorReturnReceipt =
        serde_json::from_slice(&fs::read(&receipt_path).map_err(|error| {
            format!("Workflow editor cleanup receipt could not be read: {error}")
        })?)
        .map_err(|error| format!("Workflow editor cleanup receipt is invalid: {error}"))?;
    if receipt.committed {
        return Err(
            "Workflow editor return is already committed and cannot be rolled back.".into(),
        );
    }
    if !valid_editor_revision_id(&receipt.revision_id) {
        return Err("Workflow editor cleanup receipt revision identity is invalid.".into());
    }
    let document_relative = safe_project_relative_path(&receipt.document_relative_path)?;
    let output_relative = safe_project_relative_path(&receipt.output_relative_path)?;
    let document_path = project_dir.join(document_relative);
    let output_path = project_dir.join(output_relative);
    let mut manifest = load_manifest_unlocked(project_dir)?;
    let matching_assets = manifest
        .assets
        .iter()
        .filter(|asset| {
            asset.id == receipt.asset_id
                && asset.relative_path == receipt.output_relative_path
                && asset.source_file_name.as_deref()
                    == Some(receipt.document_relative_path.as_str())
        })
        .count();
    let conflicting_assets = manifest
        .assets
        .iter()
        .filter(|asset| {
            asset.id == receipt.asset_id || asset.relative_path == receipt.output_relative_path
        })
        .count();
    if matching_assets > 1 || conflicting_assets != matching_assets {
        return Err("Workflow editor cleanup receipt no longer matches the manifest.".into());
    }

    for (path, expected_hash) in [
        (&document_path, receipt.document_content_hash.as_str()),
        (&output_path, receipt.output_content_hash.as_str()),
    ] {
        match fs::read(path) {
            Ok(bytes) if format!("sha256:{:x}", Sha256::digest(&bytes)) == expected_hash => {}
            Ok(_) => {
                return Err(
                    "Workflow editor cleanup receipt no longer matches the stored artifact hashes."
                        .into(),
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // A missing artifact is an already-completed destructive step
                // from an interrupted rollback. Every artifact that remains is
                // still authenticated before cleanup continues.
            }
            Err(error) => {
                return Err(format!(
                    "Workflow editor cleanup could not verify {}: {error}",
                    path.display()
                ));
            }
        }
    }

    if matching_assets == 1 {
        manifest.assets.retain(|asset| {
            !(asset.id == receipt.asset_id && asset.relative_path == receipt.output_relative_path)
        });
        persist_manifest(project_dir, &manifest)?;
    }

    for path in [&document_path, &output_path] {
        if let Err(error) = fs::remove_file(path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(format!(
                    "Workflow editor cleanup could not remove {}: {error}",
                    path.display()
                ));
            }
        }
    }
    fs::remove_file(receipt_path).map_err(|error| {
        format!("Workflow editor cleanup receipt could not be removed: {error}")
    })?;
    Ok(())
}

fn rollback_workflow_editor_return_with(
    project_dir: &Path,
    cleanup_token: &str,
    persist_manifest: &dyn Fn(&Path, &ProjectManifest) -> Result<(), String>,
) -> Result<(), String> {
    if !valid_editor_revision_id(cleanup_token) {
        return Err("Workflow editor cleanup token is invalid.".into());
    }
    with_project_transaction(project_dir, || {
        rollback_workflow_editor_return_unlocked(project_dir, cleanup_token, persist_manifest)
    })
}

fn rollback_workflow_editor_return(project_dir: &Path, cleanup_token: &str) -> Result<(), String> {
    rollback_workflow_editor_return_with(project_dir, cleanup_token, &save_manifest_atomic)
}

fn finalize_workflow_editor_return(
    project_dir: &Path,
    cleanup_token: &str,
) -> Result<bool, String> {
    finalize_workflow_editor_return_observed(project_dir, cleanup_token, || {})
}

fn finalize_workflow_editor_return_observed(
    project_dir: &Path,
    cleanup_token: &str,
    on_contention: impl FnOnce(),
) -> Result<bool, String> {
    if !valid_editor_revision_id(cleanup_token) {
        return Err("Workflow editor cleanup token is invalid.".into());
    }
    with_project_transaction_observed(project_dir, on_contention, || {
        finalize_workflow_editor_return_unlocked(project_dir, cleanup_token)
    })
}

fn finalize_workflow_editor_return_unlocked(
    project_dir: &Path,
    cleanup_token: &str,
) -> Result<bool, String> {
    let receipt_path = workflow_editor_receipt_path(project_dir, cleanup_token);
    if !receipt_path.exists() {
        return Ok(true);
    }
    let receipt_metadata = fs::symlink_metadata(&receipt_path).map_err(|error| {
        format!("Workflow editor finalization receipt metadata could not be read: {error}")
    })?;
    if receipt_metadata.file_type().is_symlink() || !receipt_metadata.is_file() {
        return Err(
            "Workflow editor finalization receipt must be a regular non-symlink file.".into(),
        );
    }
    let mut receipt: WorkflowEditorReturnReceipt =
        serde_json::from_slice(&fs::read(&receipt_path).map_err(|error| {
            format!("Workflow editor finalization receipt could not be read: {error}")
        })?)
        .map_err(|error| format!("Workflow editor finalization receipt is invalid: {error}"))?;
    receipt.committed = true;
    let committed_bytes = serde_json::to_vec(&receipt).map_err(|error| {
        format!("Workflow editor finalization receipt could not be serialized: {error}")
    })?;
    let mut marked = false;
    for _ in 0..3 {
        if fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&receipt_path)
            .and_then(|mut file| {
                file.write_all(&committed_bytes)
                    .and_then(|_| file.sync_all())
            })
            .is_ok()
        {
            marked = true;
            break;
        }
    }
    if !marked {
        return Err("Workflow editor cleanup capability could not be durably finalized.".into());
    }
    match fs::remove_file(&receipt_path) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}

struct WorkflowEditorReturnCommit<'a> {
    revision_id: &'a str,
    name: &'a str,
    document_bytes: &'a [u8],
    output_bytes: &'a [u8],
    width: u32,
    height: u32,
}

fn commit_workflow_editor_return_with(
    project_dir: &Path,
    input: WorkflowEditorReturnCommit<'_>,
    persist_manifest: &dyn Fn(&Path, &ProjectManifest) -> Result<(), String>,
) -> Result<WorkflowEditorReturnResult, String> {
    if !valid_editor_revision_id(input.revision_id) {
        return Err("Workflow editor revision ID is invalid.".into());
    }
    if input.document_bytes.is_empty()
        || !is_png(input.output_bytes)
        || input.width == 0
        || input.height == 0
    {
        return Err(
            "Workflow editor return requires a valid OpenRaster document and PNG output.".into(),
        );
    }
    with_project_transaction(project_dir, || {
        commit_workflow_editor_return_unlocked(project_dir, input, persist_manifest)
    })
}

fn commit_workflow_editor_return_unlocked(
    project_dir: &Path,
    input: WorkflowEditorReturnCommit<'_>,
    persist_manifest: &dyn Fn(&Path, &ProjectManifest) -> Result<(), String>,
) -> Result<WorkflowEditorReturnResult, String> {
    let WorkflowEditorReturnCommit {
        revision_id,
        name,
        document_bytes,
        output_bytes,
        width,
        height,
    } = input;
    ensure_project_dirs(project_dir)?;
    let mut manifest = load_manifest_unlocked(project_dir)?;
    let nonce = now_id();
    let cleanup_token = workflow_editor_cleanup_token()?;
    let asset_id = format!("asset-{nonce}");
    if manifest
        .assets
        .iter()
        .any(|existing| existing.id == asset_id)
    {
        return Err("Workflow editor output asset identity already exists.".into());
    }
    let stage_dir = project_dir
        .join(PAINTNODE_WORK_DIR)
        .join("workflow-editor-returns")
        .join(format!("{}-{nonce}", safe_stem(revision_id)));
    fs::create_dir_all(&stage_dir)
        .map_err(|error| format!("Workflow editor return staging failed: {error}"))?;
    let staged_document = stage_dir.join("document.ora");
    let staged_output = stage_dir.join("output.png");
    let cleanup_stage = || {
        let _ = fs::remove_dir_all(&stage_dir);
    };
    if let Err(error) = write_new_synced(&staged_document, document_bytes)
        .and_then(|_| write_new_synced(&staged_output, output_bytes))
    {
        cleanup_stage();
        return Err(error);
    }
    if ora_thumbnail_data_url(&staged_document).is_none()
        || fs::read(&staged_document).ok().as_deref() != Some(document_bytes)
        || fs::read(&staged_output).ok().as_deref() != Some(output_bytes)
    {
        cleanup_stage();
        return Err("Workflow editor return staging verification failed.".into());
    }
    let safe_revision = safe_stem(revision_id);
    let document_relative = PathBuf::from("documents")
        .join("workflow-edits")
        .join(format!("{safe_revision}-{nonce}.ora"));
    let output_relative = PathBuf::from("assets")
        .join("generated")
        .join(format!("{safe_revision}-{nonce}.png"));
    let document_path = project_dir.join(&document_relative);
    let output_path = project_dir.join(&output_relative);
    if let Some(parent) = document_path.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            cleanup_stage();
            return Err(format!("Workflow editor document folder failed: {error}"));
        }
    }
    if let Some(parent) = output_path.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            cleanup_stage();
            return Err(format!("Workflow editor output folder failed: {error}"));
        }
    }
    if let Err(error) = promote_new_file(&staged_document, &document_path) {
        cleanup_stage();
        return Err(error);
    }
    if let Err(error) = promote_new_file(&staged_output, &output_path) {
        let _ = fs::remove_file(&document_path);
        cleanup_stage();
        return Err(error);
    }
    cleanup_stage();
    let document_hash = format!("sha256:{:x}", Sha256::digest(document_bytes));
    let output_hash = format!("sha256:{:x}", Sha256::digest(output_bytes));
    let asset = ProjectAsset {
        id: asset_id,
        kind: "edited".into(),
        name: if name.trim().is_empty() {
            "Workflow edit".into()
        } else {
            name.trim().to_string()
        },
        relative_path: output_relative.to_string_lossy().replace('\\', "/"),
        created_at: nonce,
        prompt: None,
        source_file_name: Some(document_relative.to_string_lossy().replace('\\', "/")),
        width: Some(width),
        height: Some(height),
        mime: Some("image/png".into()),
    };
    manifest.assets.push(asset.clone());
    if let Err(error) = persist_manifest(project_dir, &manifest) {
        let _ = fs::remove_file(&document_path);
        let _ = fs::remove_file(&output_path);
        return Err(error);
    }
    let receipt = WorkflowEditorReturnReceipt {
        revision_id: revision_id.to_string(),
        asset_id: asset.id.clone(),
        document_relative_path: document_relative.to_string_lossy().replace('\\', "/"),
        output_relative_path: output_relative.to_string_lossy().replace('\\', "/"),
        document_content_hash: document_hash.clone(),
        output_content_hash: output_hash.clone(),
        committed: false,
    };
    let receipt_path = workflow_editor_receipt_path(project_dir, &cleanup_token);
    if let Some(parent) = receipt_path.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            manifest.assets.retain(|existing| existing.id != asset.id);
            let _ = persist_manifest(project_dir, &manifest);
            let _ = fs::remove_file(&document_path);
            let _ = fs::remove_file(&output_path);
            return Err(format!(
                "Workflow editor cleanup receipt folder failed: {error}"
            ));
        }
    }
    let receipt_bytes = match serde_json::to_vec(&receipt) {
        Ok(bytes) => bytes,
        Err(error) => {
            manifest.assets.retain(|existing| existing.id != asset.id);
            let _ = persist_manifest(project_dir, &manifest);
            let _ = fs::remove_file(&document_path);
            let _ = fs::remove_file(&output_path);
            return Err(format!(
                "Workflow editor cleanup receipt could not be serialized: {error}"
            ));
        }
    };
    if let Err(error) = write_new_synced(&receipt_path, &receipt_bytes) {
        manifest.assets.retain(|existing| existing.id != asset.id);
        let _ = persist_manifest(project_dir, &manifest);
        let _ = fs::remove_file(&document_path);
        let _ = fs::remove_file(&output_path);
        return Err(error);
    }
    Ok(WorkflowEditorReturnResult {
        document: WorkflowEditorDocumentResult {
            relative_path: document_relative.to_string_lossy().replace('\\', "/"),
            content_hash: document_hash,
            mime: "image/openraster".into(),
        },
        output: ProjectAssetView {
            asset,
            preview_data_url: png_data_url_from_bytes(output_bytes),
            exists: true,
        },
        output_content_hash: output_hash,
        cleanup_token,
    })
}

#[tauri::command]
pub(crate) async fn project_commit_workflow_editor_return(
    project_path: String,
    revision_id: String,
    name: String,
    document_bytes: Vec<u8>,
    output_bytes: Vec<u8>,
    width: u32,
    height: u32,
) -> Result<WorkflowEditorReturnResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        commit_workflow_editor_return_with(
            Path::new(project_path.trim()),
            WorkflowEditorReturnCommit {
                revision_id: &revision_id,
                name: &name,
                document_bytes: &document_bytes,
                output_bytes: &output_bytes,
                width,
                height,
            },
            &save_manifest_atomic,
        )
    })
    .await
    .map_err(|error| format!("Task error: {error}"))?
}

#[tauri::command]
pub(crate) async fn project_rollback_workflow_editor_return(
    project_path: String,
    cleanup_token: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        rollback_workflow_editor_return(Path::new(project_path.trim()), &cleanup_token)
    })
    .await
    .map_err(|error| format!("Task error: {error}"))?
}

#[tauri::command]
pub(crate) async fn project_finalize_workflow_editor_return(
    project_path: String,
    cleanup_token: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        finalize_workflow_editor_return(Path::new(project_path.trim()), &cleanup_token)
    })
    .await
    .map_err(|error| format!("Task error: {error}"))?
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
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_project_asset_material(Path::new(project_path.trim()), &asset_id)
            .and_then(encode_project_asset_material)
            .map(tauri::ipc::Response::new)
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
        with_project_transaction(&project_dir, || {
            let mut manifest = load_manifest_unlocked(&project_dir)?;
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
            save_manifest_atomic(&project_dir, &manifest)?;
            project_state(&project_dir)
        })
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

    fn workflow_editor_ora_bytes() -> Vec<u8> {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut archive = zip::ZipWriter::new(cursor);
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
        archive.finish().expect("finish archive").into_inner()
    }

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
    fn manifest_initialization_cannot_overwrite_concurrent_asset_addition() {
        let project =
            TempJobDir::new("paintnode-project-concurrent-initialize").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        assert!(!project_manifest_path(project.path()).exists());
        let relative = "assets/imported/concurrent-initialize.bin";
        fs::write(project.path().join(relative), b"concurrent material")
            .expect("candidate asset file");
        let mut asset = material_asset("concurrent-initialize", relative);
        asset.mime = None;

        std::thread::scope(|scope| {
            let project_path = project.path();
            let (initialization_observed_tx, initialization_observed_rx) =
                std::sync::mpsc::channel();
            let (release_initialization_tx, release_initialization_rx) = std::sync::mpsc::channel();
            let initialize = scope.spawn(move || {
                load_manifest_observed(project_path, || {
                    initialization_observed_tx
                        .send(())
                        .expect("signal missing manifest observation");
                    release_initialization_rx
                        .recv()
                        .expect("release manifest initialization");
                })
            });
            initialization_observed_rx
                .recv()
                .expect("read-oriented initialization observed missing manifest");

            add_asset(project.path(), asset).expect("concurrent asset addition");
            release_initialization_tx
                .send(())
                .expect("release read-oriented initialization");
            let initialized = initialize
                .join()
                .expect("initialization thread")
                .expect("initialization result");
            assert_eq!(initialized.assets.len(), 1);
            assert_eq!(initialized.assets[0].id, "concurrent-initialize");
        });

        let manifest = load_manifest(project.path()).expect("final manifest");
        assert_eq!(manifest.assets.len(), 1);
        assert_eq!(manifest.assets[0].id, "concurrent-initialize");
    }

    #[test]
    fn project_transaction_poison_survives_idle_and_fails_closed() {
        let project = TempJobDir::new("paintnode-project-transaction-poison").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");

        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = with_project_transaction(project.path(), || -> Result<(), String> {
                panic!("adversarial interruption while project transaction is held")
            });
        }));
        assert!(panic.is_err(), "adversarial transaction must panic");

        let relative = "assets/imported/after-poison.bin";
        fs::write(project.path().join(relative), b"must not be committed")
            .expect("candidate asset file");
        let mut asset = material_asset("after-poison", relative);
        asset.mime = None;
        let error = add_asset(project.path(), asset)
            .expect_err("poisoned project transaction must remain fail closed while idle");

        assert!(error.contains("interrupted"));
        assert!(!project_manifest_path(project.path()).exists());
    }

    #[test]
    fn workflow_editor_return_commits_unique_document_png_and_edited_manifest_asset() {
        let project = TempJobDir::new("paintnode-workflow-editor-return").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let ora = workflow_editor_ora_bytes();
        let result = commit_workflow_editor_return_with(
            project.path(),
            WorkflowEditorReturnCommit {
                revision_id: "edit-one",
                name: "Edited concept",
                document_bytes: &ora,
                output_bytes: ONE_PIXEL_PNG,
                width: 1,
                height: 1,
            },
            &save_manifest,
        )
        .expect("editor return");

        assert!(project.path().join(&result.document.relative_path).exists());
        assert!(project
            .path()
            .join(&result.output.asset.relative_path)
            .exists());
        assert_eq!(result.output.asset.kind, "edited");
        assert_eq!(result.cleanup_token.len(), 39);
        assert!(result.cleanup_token.starts_with("return-"));
        assert!(result.cleanup_token[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(
            result.cleanup_token,
            workflow_editor_cleanup_token().expect("random token")
        );
        assert_eq!(
            result.document.content_hash,
            format!("sha256:{:x}", Sha256::digest(&ora))
        );
        assert_eq!(
            result.output_content_hash,
            format!("sha256:{:x}", Sha256::digest(ONE_PIXEL_PNG))
        );
        let manifest = load_manifest(project.path()).expect("manifest");
        assert_eq!(manifest.assets.len(), 1);
        assert_eq!(manifest.assets[0].id, result.output.asset.id);
        finalize_workflow_editor_return(project.path(), &result.cleanup_token).expect("finalize");
        finalize_workflow_editor_return(project.path(), &result.cleanup_token)
            .expect("idempotent finalize");
        assert!(project.path().join(&result.document.relative_path).exists());
        assert!(project
            .path()
            .join(&result.output.asset.relative_path)
            .exists());
    }

    #[test]
    fn workflow_editor_return_rolls_back_files_when_manifest_commit_fails() {
        let project = TempJobDir::new("paintnode-workflow-editor-rollback").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let ora = workflow_editor_ora_bytes();
        let error = commit_workflow_editor_return_with(
            project.path(),
            WorkflowEditorReturnCommit {
                revision_id: "edit-rollback",
                name: "Edited concept",
                document_bytes: &ora,
                output_bytes: ONE_PIXEL_PNG,
                width: 1,
                height: 1,
            },
            &|_, _| Err("manifest write failed".into()),
        )
        .expect_err("manifest failure");

        assert!(error.contains("manifest write failed"));
        assert!(
            fs::read_dir(project.path().join("documents/workflow-edits"))
                .expect("documents dir")
                .next()
                .is_none()
        );
        assert!(fs::read_dir(project.path().join("assets/generated"))
            .expect("generated dir")
            .next()
            .is_none());
    }

    #[test]
    fn workflow_editor_return_cleanup_token_is_idempotent_and_removes_manifest_and_files() {
        let project = TempJobDir::new("paintnode-workflow-editor-cleanup").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let ora = workflow_editor_ora_bytes();
        let result = commit_workflow_editor_return_with(
            project.path(),
            WorkflowEditorReturnCommit {
                revision_id: "edit-cleanup",
                name: "Edited concept",
                document_bytes: &ora,
                output_bytes: ONE_PIXEL_PNG,
                width: 1,
                height: 1,
            },
            &save_manifest_atomic,
        )
        .expect("editor return");
        let document_path = project.path().join(&result.document.relative_path);
        let output_path = project.path().join(&result.output.asset.relative_path);

        rollback_workflow_editor_return(project.path(), &result.cleanup_token).expect("cleanup");
        rollback_workflow_editor_return(project.path(), &result.cleanup_token)
            .expect("idempotent cleanup");

        assert!(!document_path.exists());
        assert!(!output_path.exists());
        assert!(load_manifest(project.path())
            .expect("manifest")
            .assets
            .is_empty());
    }

    #[test]
    fn workflow_editor_return_cleanup_finishes_after_manifest_commit_and_receipt_delete_interruption(
    ) {
        let project =
            TempJobDir::new("paintnode-workflow-editor-partial-cleanup").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let ora = workflow_editor_ora_bytes();
        let result = commit_workflow_editor_return_with(
            project.path(),
            WorkflowEditorReturnCommit {
                revision_id: "edit-partial-cleanup",
                name: "Edited concept",
                document_bytes: &ora,
                output_bytes: ONE_PIXEL_PNG,
                width: 1,
                height: 1,
            },
            &save_manifest_atomic,
        )
        .expect("editor return");
        let mut manifest = load_manifest(project.path()).expect("manifest");
        manifest.assets.clear();
        save_manifest_atomic(project.path(), &manifest).expect("persist partial rollback");
        fs::remove_file(project.path().join(&result.document.relative_path))
            .expect("remove document");
        fs::remove_file(project.path().join(&result.output.asset.relative_path))
            .expect("remove output");

        rollback_workflow_editor_return(project.path(), &result.cleanup_token)
            .expect("finish interrupted rollback");
        assert!(!workflow_editor_receipt_path(project.path(), &result.cleanup_token).exists());
    }

    #[test]
    fn workflow_editor_return_cleanup_repairs_one_missing_artifact_with_stale_manifest() {
        let project =
            TempJobDir::new("paintnode-workflow-editor-stale-manifest").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let unrelated_relative = "assets/imported/unrelated.png";
        fs::write(project.path().join(unrelated_relative), ONE_PIXEL_PNG).expect("unrelated asset");
        let ora = workflow_editor_ora_bytes();
        let result = commit_workflow_editor_return_with(
            project.path(),
            WorkflowEditorReturnCommit {
                revision_id: "edit-stale-manifest",
                name: "Edited concept",
                document_bytes: &ora,
                output_bytes: ONE_PIXEL_PNG,
                width: 1,
                height: 1,
            },
            &save_manifest_atomic,
        )
        .expect("editor return");
        let document_path = project.path().join(&result.document.relative_path);
        let output_path = project.path().join(&result.output.asset.relative_path);
        let mut manifest = load_manifest(project.path()).expect("manifest");
        manifest
            .assets
            .push(material_asset("unrelated", unrelated_relative));
        save_manifest_atomic(project.path(), &manifest).expect("unrelated manifest asset");
        fs::remove_file(&document_path).expect("interrupt after document deletion");

        rollback_workflow_editor_return(project.path(), &result.cleanup_token)
            .expect("retry stale-manifest rollback");

        assert!(!document_path.exists());
        assert!(!output_path.exists());
        assert!(project.path().join(unrelated_relative).exists());
        let manifest = load_manifest(project.path()).expect("repaired manifest");
        assert_eq!(manifest.assets.len(), 1);
        assert_eq!(manifest.assets[0].id, "unrelated");
        assert!(!workflow_editor_receipt_path(project.path(), &result.cleanup_token).exists());
    }

    #[test]
    fn workflow_editor_return_rollback_serializes_concurrent_unrelated_asset_addition() {
        let project =
            TempJobDir::new("paintnode-workflow-editor-concurrent-asset").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let ora = workflow_editor_ora_bytes();
        let result = commit_workflow_editor_return_with(
            project.path(),
            WorkflowEditorReturnCommit {
                revision_id: "edit-concurrent-asset",
                name: "Edited concept",
                document_bytes: &ora,
                output_bytes: ONE_PIXEL_PNG,
                width: 1,
                height: 1,
            },
            &save_manifest_atomic,
        )
        .expect("editor return");
        let unrelated_relative = "assets/imported/concurrent-unrelated.bin";
        fs::write(
            project.path().join(unrelated_relative),
            b"unrelated material",
        )
        .expect("unrelated asset file");
        let mut unrelated_asset = material_asset("concurrent-unrelated", unrelated_relative);
        unrelated_asset.mime = None;

        std::thread::scope(|scope| {
            let project_path = project.path();
            let cleanup_token = result.cleanup_token.as_str();
            let (rollback_at_manifest_tx, rollback_at_manifest_rx) = std::sync::mpsc::channel();
            let (release_rollback_tx, release_rollback_rx) = std::sync::mpsc::channel();
            let (asset_waiting_tx, asset_waiting_rx) = std::sync::mpsc::channel();
            let rollback = scope.spawn(move || {
                rollback_workflow_editor_return_with(
                    project_path,
                    cleanup_token,
                    &|project_dir, manifest| {
                        rollback_at_manifest_tx
                            .send(())
                            .expect("signal rollback manifest transition");
                        release_rollback_rx
                            .recv()
                            .expect("release rollback manifest transition");
                        save_manifest_atomic(project_dir, manifest)
                    },
                )
            });
            rollback_at_manifest_rx
                .recv()
                .expect("rollback reached manifest transition");

            let add = scope.spawn(move || {
                add_asset_with_transaction_observer(project_path, unrelated_asset, || {
                    asset_waiting_tx
                        .send(())
                        .expect("signal blocked asset addition")
                })
            });
            asset_waiting_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("asset addition must contend on rollback's project transaction");

            release_rollback_tx.send(()).expect("release rollback");
            rollback.join().expect("rollback thread").expect("rollback");
            add.join().expect("asset thread").expect("asset addition");
        });

        let manifest = load_manifest(project.path()).expect("manifest after concurrent transition");
        assert_eq!(manifest.assets.len(), 1);
        assert_eq!(manifest.assets[0].id, "concurrent-unrelated");
        assert!(project.path().join(unrelated_relative).exists());
        assert!(!project.path().join(&result.document.relative_path).exists());
        assert!(!project
            .path()
            .join(&result.output.asset.relative_path)
            .exists());
    }

    #[test]
    fn workflow_editor_return_rollback_serializes_concurrent_finalize() {
        let project =
            TempJobDir::new("paintnode-workflow-editor-concurrent-finalize").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let ora = workflow_editor_ora_bytes();
        let result = commit_workflow_editor_return_with(
            project.path(),
            WorkflowEditorReturnCommit {
                revision_id: "edit-concurrent-finalize",
                name: "Edited concept",
                document_bytes: &ora,
                output_bytes: ONE_PIXEL_PNG,
                width: 1,
                height: 1,
            },
            &save_manifest_atomic,
        )
        .expect("editor return");

        std::thread::scope(|scope| {
            let project_path = project.path();
            let cleanup_token = result.cleanup_token.as_str();
            let (rollback_at_manifest_tx, rollback_at_manifest_rx) = std::sync::mpsc::channel();
            let (release_rollback_tx, release_rollback_rx) = std::sync::mpsc::channel();
            let (finalize_waiting_tx, finalize_waiting_rx) = std::sync::mpsc::channel();
            let rollback = scope.spawn(move || {
                rollback_workflow_editor_return_with(
                    project_path,
                    cleanup_token,
                    &|project_dir, manifest| {
                        rollback_at_manifest_tx
                            .send(())
                            .expect("signal rollback manifest transition");
                        release_rollback_rx
                            .recv()
                            .expect("release rollback manifest transition");
                        save_manifest_atomic(project_dir, manifest)
                    },
                )
            });
            rollback_at_manifest_rx
                .recv()
                .expect("rollback reached manifest transition");

            let finalize = scope.spawn(move || {
                finalize_workflow_editor_return_observed(project_path, cleanup_token, || {
                    finalize_waiting_tx
                        .send(())
                        .expect("signal blocked finalize")
                })
            });
            finalize_waiting_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("finalization must contend on rollback's project transaction");

            release_rollback_tx.send(()).expect("release rollback");
            rollback.join().expect("rollback thread").expect("rollback");
            assert!(finalize
                .join()
                .expect("finalize thread")
                .expect("idempotent finalize after rollback"));
        });

        assert!(!workflow_editor_receipt_path(project.path(), &result.cleanup_token).exists());
        assert!(load_manifest(project.path())
            .expect("manifest after concurrent transition")
            .assets
            .is_empty());
        assert!(!project.path().join(&result.document.relative_path).exists());
        assert!(!project
            .path()
            .join(&result.output.asset.relative_path)
            .exists());
    }

    #[test]
    fn workflow_editor_return_cleanup_recovers_every_post_manifest_interruption_boundary() {
        for deleted_artifacts in 0..=2 {
            let project = TempJobDir::new(&format!(
                "paintnode-workflow-editor-post-manifest-{deleted_artifacts}"
            ))
            .expect("project dir");
            ensure_project_dirs(project.path()).expect("project dirs");
            let unrelated_relative = "assets/imported/unrelated.png";
            fs::write(project.path().join(unrelated_relative), ONE_PIXEL_PNG)
                .expect("unrelated asset");
            let ora = workflow_editor_ora_bytes();
            let result = commit_workflow_editor_return_with(
                project.path(),
                WorkflowEditorReturnCommit {
                    revision_id: &format!("edit-post-manifest-{deleted_artifacts}"),
                    name: "Edited concept",
                    document_bytes: &ora,
                    output_bytes: ONE_PIXEL_PNG,
                    width: 1,
                    height: 1,
                },
                &save_manifest_atomic,
            )
            .expect("editor return");
            let document_path = project.path().join(&result.document.relative_path);
            let output_path = project.path().join(&result.output.asset.relative_path);
            let mut manifest = load_manifest(project.path()).expect("manifest");
            manifest
                .assets
                .retain(|asset| asset.id != result.output.asset.id);
            manifest
                .assets
                .push(material_asset("unrelated", unrelated_relative));
            save_manifest_atomic(project.path(), &manifest)
                .expect("interrupt after manifest commit");
            if deleted_artifacts >= 1 {
                fs::remove_file(&document_path).expect("interrupt after document deletion");
            }
            if deleted_artifacts >= 2 {
                fs::remove_file(&output_path).expect("interrupt after output deletion");
            }

            rollback_workflow_editor_return(project.path(), &result.cleanup_token)
                .expect("retry post-manifest rollback");

            assert!(!document_path.exists());
            assert!(!output_path.exists());
            assert!(project.path().join(unrelated_relative).exists());
            let manifest = load_manifest(project.path()).expect("repaired manifest");
            assert_eq!(manifest.assets.len(), 1);
            assert_eq!(manifest.assets[0].id, "unrelated");
            assert!(!workflow_editor_receipt_path(project.path(), &result.cleanup_token).exists());
        }
    }

    #[test]
    fn workflow_editor_return_cleanup_keeps_artifacts_when_manifest_commit_fails() {
        let project = TempJobDir::new("paintnode-workflow-editor-cleanup-manifest-failure")
            .expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let ora = workflow_editor_ora_bytes();
        let result = commit_workflow_editor_return_with(
            project.path(),
            WorkflowEditorReturnCommit {
                revision_id: "edit-cleanup-manifest-failure",
                name: "Edited concept",
                document_bytes: &ora,
                output_bytes: ONE_PIXEL_PNG,
                width: 1,
                height: 1,
            },
            &save_manifest_atomic,
        )
        .expect("editor return");
        let document_path = project.path().join(&result.document.relative_path);
        let output_path = project.path().join(&result.output.asset.relative_path);

        let error =
            rollback_workflow_editor_return_with(project.path(), &result.cleanup_token, &|_, _| {
                Err("interrupted manifest commit".into())
            })
            .expect_err("manifest interruption");

        assert!(error.contains("interrupted manifest commit"));
        assert!(document_path.exists());
        assert!(output_path.exists());
        assert_eq!(
            load_manifest(project.path())
                .expect("unchanged manifest")
                .assets
                .len(),
            1
        );
        assert!(workflow_editor_receipt_path(project.path(), &result.cleanup_token).exists());
    }

    #[test]
    fn workflow_editor_return_cleanup_rechecks_remaining_hash_after_manifest_commit() {
        let project =
            TempJobDir::new("paintnode-workflow-editor-post-manifest-hash").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let ora = workflow_editor_ora_bytes();
        let result = commit_workflow_editor_return_with(
            project.path(),
            WorkflowEditorReturnCommit {
                revision_id: "edit-post-manifest-hash",
                name: "Edited concept",
                document_bytes: &ora,
                output_bytes: ONE_PIXEL_PNG,
                width: 1,
                height: 1,
            },
            &save_manifest_atomic,
        )
        .expect("editor return");
        let document_path = project.path().join(&result.document.relative_path);
        let output_path = project.path().join(&result.output.asset.relative_path);
        let mut manifest = load_manifest(project.path()).expect("manifest");
        manifest
            .assets
            .retain(|asset| asset.id != result.output.asset.id);
        save_manifest_atomic(project.path(), &manifest).expect("manifest commit");
        fs::write(&output_path, b"tampered output").expect("tamper remaining output");

        let error = rollback_workflow_editor_return(project.path(), &result.cleanup_token)
            .expect_err("remaining artifact mismatch must fail closed");

        assert!(error.contains("artifact hashes"));
        assert!(document_path.exists());
        assert!(output_path.exists());
        assert!(workflow_editor_receipt_path(project.path(), &result.cleanup_token).exists());
    }

    #[test]
    fn workflow_editor_return_committed_receipt_disables_rollback_capability() {
        let project =
            TempJobDir::new("paintnode-workflow-editor-committed-receipt").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let ora = workflow_editor_ora_bytes();
        let result = commit_workflow_editor_return_with(
            project.path(),
            WorkflowEditorReturnCommit {
                revision_id: "edit-committed-receipt",
                name: "Edited concept",
                document_bytes: &ora,
                output_bytes: ONE_PIXEL_PNG,
                width: 1,
                height: 1,
            },
            &save_manifest_atomic,
        )
        .expect("editor return");
        let receipt_path = workflow_editor_receipt_path(project.path(), &result.cleanup_token);
        let mut receipt: WorkflowEditorReturnReceipt =
            serde_json::from_slice(&fs::read(&receipt_path).expect("receipt"))
                .expect("receipt json");
        receipt.committed = true;
        fs::write(
            &receipt_path,
            serde_json::to_vec(&receipt).expect("receipt bytes"),
        )
        .expect("mark committed");

        let error = rollback_workflow_editor_return(project.path(), &result.cleanup_token)
            .expect_err("committed receipt must reject rollback");
        assert!(error.contains("already committed"));
        assert!(project.path().join(&result.document.relative_path).exists());
        assert!(project
            .path()
            .join(&result.output.asset.relative_path)
            .exists());
    }

    #[test]
    fn workflow_editor_return_cleanup_refuses_artifact_hash_mismatch() {
        let project =
            TempJobDir::new("paintnode-workflow-editor-hash-mismatch").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let ora = workflow_editor_ora_bytes();
        let result = commit_workflow_editor_return_with(
            project.path(),
            WorkflowEditorReturnCommit {
                revision_id: "edit-hash-mismatch",
                name: "Edited concept",
                document_bytes: &ora,
                output_bytes: ONE_PIXEL_PNG,
                width: 1,
                height: 1,
            },
            &save_manifest_atomic,
        )
        .expect("editor return");
        let output_path = project.path().join(&result.output.asset.relative_path);
        fs::write(&output_path, b"different output").expect("tamper output");

        let error = rollback_workflow_editor_return(project.path(), &result.cleanup_token)
            .expect_err("hash mismatch must fail closed");
        assert!(error.contains("artifact hashes"));
        assert_eq!(
            load_manifest(project.path())
                .expect("manifest")
                .assets
                .len(),
            1
        );
        assert!(project.path().join(&result.document.relative_path).exists());
        assert!(output_path.exists());
    }

    #[test]
    fn workflow_editor_return_cleanup_refuses_manifest_mismatch_without_removing_files() {
        let project = TempJobDir::new("paintnode-workflow-editor-mismatch").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let ora = workflow_editor_ora_bytes();
        let result = commit_workflow_editor_return_with(
            project.path(),
            WorkflowEditorReturnCommit {
                revision_id: "edit-mismatch",
                name: "Edited concept",
                document_bytes: &ora,
                output_bytes: ONE_PIXEL_PNG,
                width: 1,
                height: 1,
            },
            &save_manifest_atomic,
        )
        .expect("editor return");
        let document_path = project.path().join(&result.document.relative_path);
        let output_path = project.path().join(&result.output.asset.relative_path);
        let mut manifest = load_manifest(project.path()).expect("manifest");
        manifest.assets[0].source_file_name = Some("documents/different.ora".into());
        save_manifest_atomic(project.path(), &manifest).expect("tamper manifest");

        let error = rollback_workflow_editor_return(project.path(), &result.cleanup_token)
            .expect_err("mismatch must fail closed");

        assert!(error.contains("no longer matches"));
        assert!(document_path.exists());
        assert!(output_path.exists());
        assert_eq!(
            load_manifest(project.path())
                .expect("manifest")
                .assets
                .len(),
            1
        );
    }

    #[test]
    fn workflow_editor_return_cleanup_rejects_invalid_token_and_receipt_path() {
        let project =
            TempJobDir::new("paintnode-workflow-editor-path-mismatch").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let ora = workflow_editor_ora_bytes();
        let result = commit_workflow_editor_return_with(
            project.path(),
            WorkflowEditorReturnCommit {
                revision_id: "edit-path-mismatch",
                name: "Edited concept",
                document_bytes: &ora,
                output_bytes: ONE_PIXEL_PNG,
                width: 1,
                height: 1,
            },
            &save_manifest_atomic,
        )
        .expect("editor return");
        assert!(rollback_workflow_editor_return(project.path(), "../invalid").is_err());
        let receipt_path = workflow_editor_receipt_path(project.path(), &result.cleanup_token);
        let mut receipt: WorkflowEditorReturnReceipt =
            serde_json::from_slice(&fs::read(&receipt_path).expect("receipt"))
                .expect("receipt json");
        receipt.document_relative_path = "../outside.ora".into();
        fs::write(
            &receipt_path,
            serde_json::to_vec(&receipt).expect("receipt bytes"),
        )
        .expect("tamper receipt");

        assert!(rollback_workflow_editor_return(project.path(), &result.cleanup_token).is_err());
        assert!(project.path().join(&result.document.relative_path).exists());
        assert!(project
            .path()
            .join(&result.output.asset.relative_path)
            .exists());
    }

    #[test]
    fn workflow_editor_return_rejects_invalid_artifacts_without_manifest_or_files() {
        let project = TempJobDir::new("paintnode-workflow-editor-invalid").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        load_manifest(project.path()).expect("initialize manifest");
        let before = fs::read(project_manifest_path(project.path())).expect("manifest");
        assert!(commit_workflow_editor_return_with(
            project.path(),
            WorkflowEditorReturnCommit {
                revision_id: "edit-invalid",
                name: "Edited concept",
                document_bytes: b"not ora",
                output_bytes: b"not png",
                width: 1,
                height: 1,
            },
            &save_manifest,
        )
        .is_err());
        assert_eq!(
            fs::read(project_manifest_path(project.path())).expect("manifest"),
            before
        );
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

        assert_eq!(result.asset_id, "material");
        assert_eq!(result.relative_path, relative);
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
    fn project_asset_material_encodes_versioned_raw_binary_envelope() {
        let content_hash = format!("sha256:{:x}", Sha256::digest(ONE_PIXEL_PNG));
        let envelope = encode_project_asset_material(ProjectAssetMaterialResult {
            asset_id: "material".into(),
            relative_path: "assets/imported/material.png".into(),
            bytes: ONE_PIXEL_PNG.to_vec(),
            content_hash: content_hash.clone(),
        })
        .expect("envelope");

        assert_eq!(&envelope[..8], PROJECT_MATERIAL_ENVELOPE_MAGIC);
        assert_eq!(
            u16::from_be_bytes(envelope[8..10].try_into().expect("version")),
            PROJECT_MATERIAL_ENVELOPE_VERSION
        );
        let metadata_len =
            u32::from_be_bytes(envelope[10..14].try_into().expect("metadata length")) as usize;
        let material_len =
            u32::from_be_bytes(envelope[14..18].try_into().expect("material length")) as usize;
        assert_eq!(material_len, ONE_PIXEL_PNG.len());
        let metadata: serde_json::Value =
            serde_json::from_slice(&envelope[18..18 + metadata_len]).expect("metadata");
        assert_eq!(metadata["assetId"], "material");
        assert_eq!(metadata["relativePath"], "assets/imported/material.png");
        assert_eq!(metadata["contentHash"], content_hash);
        assert_eq!(&envelope[18 + metadata_len..], ONE_PIXEL_PNG);
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

    #[cfg(unix)]
    fn assert_material_resolution_finishes_bounded(
        project_path: PathBuf,
        asset_id: &'static str,
    ) -> Result<ProjectAssetMaterialResult, String> {
        use std::sync::mpsc;
        use std::time::Duration;

        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(resolve_project_asset_material(&project_path, asset_id));
        });
        receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("special project files must be rejected without blocking")
    }

    #[cfg(unix)]
    #[test]
    fn project_asset_material_rejects_asset_fifo_without_blocking() {
        let project = TempJobDir::new("paintnode-material-asset-fifo").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let relative = "assets/imported/material.pipe";
        let mut manifest = new_manifest(project.path());
        manifest.assets.push(material_asset("fifo", relative));
        save_manifest(project.path(), &manifest).expect("manifest");
        let status = Command::new("mkfifo")
            .arg(project.path().join(relative))
            .status()
            .expect("mkfifo");
        assert!(status.success());

        let error =
            assert_material_resolution_finishes_bounded(project.path().to_path_buf(), "fifo")
                .expect_err("FIFO asset");
        assert!(error.contains("not a regular file"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn project_asset_material_rejects_manifest_fifo_without_blocking() {
        let project = TempJobDir::new("paintnode-material-manifest-fifo").expect("project dir");
        ensure_project_dirs(project.path()).expect("project dirs");
        let status = Command::new("mkfifo")
            .arg(project_manifest_path(project.path()))
            .status()
            .expect("mkfifo");
        assert!(status.success());

        let error =
            assert_material_resolution_finishes_bounded(project.path().to_path_buf(), "fifo")
                .expect_err("FIFO manifest");
        assert!(error.contains("not a regular file"), "{error}");
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
