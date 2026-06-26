use base64::Engine;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime},
};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter};

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const GENERATION_TIMEOUT: Duration = Duration::from_secs(600);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const RESULT_STABLE_DURATION: Duration = Duration::from_millis(900);
const PROJECT_MANIFEST: &str = "cxpaint.project.json";
const CODEX_PROGRESS_EVENT: &str = "codex-generation-progress";

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
struct ProjectAsset {
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectState {
    path: String,
    name: String,
    document_path: String,
    assets: Vec<ProjectAssetView>,
    files: Vec<ProjectFileView>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectAssetView {
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
struct GeneratedImageResult {
    data_url: String,
    asset: Option<ProjectAssetView>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DecoupledLayerResult {
    name: String,
    data_url: String,
    alpha_mask_data_url: Option<String>,
    key_color: Option<String>,
    x: Option<i32>,
    y: Option<i32>,
    opacity: Option<f32>,
    visible: Option<bool>,
    asset: Option<ProjectAssetView>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DecoupleImageResult {
    layers: Vec<DecoupledLayerResult>,
    thread_id: Option<String>,
    notes: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecoupleManifest {
    #[serde(default, alias = "assets")]
    layers: Vec<DecoupleManifestLayer>,
    notes: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DecoupleManifestLayer {
    name: String,
    file: String,
    alpha_mask: Option<String>,
    key_color: Option<String>,
    x: Option<i32>,
    y: Option<i32>,
    opacity: Option<f32>,
    visible: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowSourceImage {
    name: String,
    bytes: Vec<u8>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexProgressPayload {
    run_id: String,
    message: String,
}

struct CodexRunResult {
    output: Output,
    completed_from_result_file: bool,
    thread_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredAssetResult {
    data_url: String,
    asset: ProjectAssetView,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedDocumentResult {
    relative_path: String,
    name: String,
}

struct TempJobDir {
    path: PathBuf,
}

impl TempJobDir {
    fn new(prefix: &str) -> Result<Self, String> {
        let base = std::env::temp_dir();
        let pid = std::process::id();
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);

        for attempt in 0..100 {
            let path = base.join(format!("{prefix}-{pid}-{ts}-{attempt}"));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("Failed to create temp job directory: {e}")),
            }
        }

        Err("Failed to allocate a unique temp job directory.".into())
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempJobDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn now_id() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn project_manifest_path(project_path: &Path) -> PathBuf {
    project_path.join(PROJECT_MANIFEST)
}

fn ensure_project_dirs(project_path: &Path) -> Result<(), String> {
    fs::create_dir_all(project_path.join("documents"))
        .map_err(|e| format!("Failed to create documents folder: {e}"))?;
    fs::create_dir_all(project_path.join("autosave"))
        .map_err(|e| format!("Failed to create autosave folder: {e}"))?;
    fs::create_dir_all(project_path.join("assets").join("generated"))
        .map_err(|e| format!("Failed to create generated assets folder: {e}"))?;
    fs::create_dir_all(project_path.join("assets").join("imported"))
        .map_err(|e| format!("Failed to create imported assets folder: {e}"))?;
    fs::create_dir_all(project_path.join(".cxpaint").join("codex-runs"))
        .map_err(|e| format!("Failed to create Codex runs folder: {e}"))?;
    fs::create_dir_all(project_path.join(".cxpaint").join("trash"))
        .map_err(|e| format!("Failed to create project trash folder: {e}"))?;
    Ok(())
}

fn default_project_name(path: &Path) -> String {
    path.file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("CX Paint Project")
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

fn safe_stem(name: &str) -> String {
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

fn mime_for_path(path: &Path) -> Option<String> {
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

fn preview_data_url_for_project_file(path: &Path, mime: Option<&str>) -> Option<String> {
    if is_openraster_path(path) || mime == Some("image/openraster") {
        return ora_thumbnail_data_url(path);
    }
    data_url_for_file(path, mime)
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
        .then(|| data_url_for_file(&path, asset.mime.as_deref()))
        .flatten();
    ProjectAssetView {
        asset,
        preview_data_url,
        exists,
    }
}

fn scan_project_files(project_path: &Path) -> Vec<ProjectFileView> {
    let folders = [
        ("document", PathBuf::from("documents")),
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
            let relative = relative_dir.join(&name);
            let is_workflow = is_workflow_path(&path);
            let mime = mime_for_path(&path)
                .or_else(|| is_openraster_path(&path).then(|| "image/openraster".to_string()))
                .or_else(|| {
                    is_workflow.then(|| "application/vnd.cxpaint.workflow+json".to_string())
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
                preview_data_url: preview_data_url_for_project_file(&path, mime.as_deref()),
                mime,
                exists: true,
            });
        }
    }

    files.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    files
}

fn project_state(project_path: &Path) -> Result<ProjectState, String> {
    let manifest = load_manifest(project_path)?;
    let mut assets = manifest
        .assets
        .into_iter()
        .map(|asset| asset_view(project_path, asset))
        .collect::<Vec<_>>();
    assets.sort_by(|a, b| b.asset.created_at.cmp(&a.asset.created_at));
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

fn write_asset_file(
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

fn safe_file_name(file_name: &str) -> Option<String> {
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

fn write_asset_file_with_file_name(
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

fn add_asset(project_path: &Path, asset: ProjectAsset) -> Result<ProjectAssetView, String> {
    let mut manifest = load_manifest(project_path)?;
    manifest.assets.retain(|existing| existing.id != asset.id);
    manifest.assets.push(asset.clone());
    save_manifest(project_path, &manifest)?;
    Ok(asset_view(project_path, asset))
}

fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(PNG_SIGNATURE)
}

fn file_has_png_signature(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut signature = [0_u8; 8];
    file.read_exact(&mut signature).is_ok() && signature == *PNG_SIGNATURE
}

fn stable_png_size(
    path: &Path,
    last_size: &mut Option<u64>,
    stable_since: &mut Option<Instant>,
) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        *last_size = None;
        *stable_since = None;
        return false;
    };

    let size = metadata.len();
    if size < PNG_SIGNATURE.len() as u64 || !file_has_png_signature(path) {
        *last_size = Some(size);
        *stable_since = None;
        return false;
    }

    if *last_size == Some(size) {
        let since = stable_since.get_or_insert_with(Instant::now);
        since.elapsed() >= RESULT_STABLE_DURATION
    } else {
        *last_size = Some(size);
        *stable_since = Some(Instant::now());
        false
    }
}

fn decode_png_string(value: &str) -> Option<Vec<u8>> {
    let trimmed = value.trim();
    let b64 = trimmed
        .strip_prefix("data:image/png;base64,")
        .or_else(|| trimmed.strip_prefix("data:image/x-png;base64,"))
        .unwrap_or(trimmed);

    if b64.len() < 32
        || !b64
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'-' | b'_' | b'='))
    {
        return None;
    }

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(b64))
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(b64))
        .ok()?;
    is_png(&decoded).then_some(decoded)
}

fn png_path_from_string(value: &str, job_path: &Path) -> Option<PathBuf> {
    let trimmed = value.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() || trimmed.len() > 4096 || !trimmed.to_ascii_lowercase().contains(".png")
    {
        return None;
    }

    let candidate = PathBuf::from(trimmed);
    let absolute = if candidate.is_absolute() {
        candidate
    } else {
        job_path.join(candidate)
    };
    file_has_png_signature(&absolute).then_some(absolute)
}

fn write_png_candidate(result_path: &Path, bytes: &[u8]) -> bool {
    if !is_png(bytes) {
        return false;
    }
    if let Some(parent) = result_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(result_path, bytes).is_ok()
}

fn copy_png_candidate(candidate: &Path, result_path: &Path) -> bool {
    if candidate == result_path {
        return true;
    }
    if !file_has_png_signature(candidate) {
        return false;
    }
    if let Some(parent) = result_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::copy(candidate, result_path).is_ok()
}

fn materialize_png_from_json_value(
    value: &serde_json::Value,
    job_path: &Path,
    result_path: &Path,
) -> bool {
    match value {
        serde_json::Value::String(text) => {
            if let Some(bytes) = decode_png_string(text) {
                write_png_candidate(result_path, &bytes)
            } else if let Some(path) = png_path_from_string(text, job_path) {
                copy_png_candidate(&path, result_path)
            } else {
                false
            }
        }
        serde_json::Value::Array(items) => items
            .iter()
            .any(|item| materialize_png_from_json_value(item, job_path, result_path)),
        serde_json::Value::Object(map) => map
            .values()
            .any(|item| materialize_png_from_json_value(item, job_path, result_path)),
        _ => false,
    }
}

fn materialize_png_from_line(line: &str, job_path: &Path, result_path: &Path) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        return materialize_png_from_json_value(&value, job_path, result_path);
    }

    if let Some(bytes) = decode_png_string(trimmed) {
        return write_png_candidate(result_path, &bytes);
    }

    if let Some(path) = png_path_from_string(trimmed, job_path) {
        return copy_png_candidate(&path, result_path);
    }

    false
}

fn find_png_file(root: &Path, result_path: &Path) -> Option<PathBuf> {
    let mut stack = vec![(root.to_path_buf(), 0_usize)];
    let mut checked = 0_usize;

    while let Some((dir, depth)) = stack.pop() {
        if depth > 6 || checked > 1000 {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path == result_path {
                continue;
            }
            if path.is_dir() {
                stack.push((path, depth + 1));
                continue;
            }
            checked += 1;
            if file_has_png_signature(&path) {
                return Some(path);
            }
        }
    }

    None
}

fn find_newest_png_since(root: &Path, result_path: &Path, since: SystemTime) -> Option<PathBuf> {
    let cutoff = since.checked_sub(Duration::from_secs(3)).unwrap_or(since);
    let mut newest: Option<(SystemTime, PathBuf)> = None;
    let mut stack = vec![(root.to_path_buf(), 0_usize)];
    let mut checked = 0_usize;

    while let Some((dir, depth)) = stack.pop() {
        if depth > 4 || checked > 2000 {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path == result_path {
                continue;
            }
            if path.is_dir() {
                stack.push((path, depth + 1));
                continue;
            }
            checked += 1;
            if !file_has_png_signature(&path) {
                continue;
            }
            let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
                continue;
            };
            if modified.duration_since(cutoff).is_err() {
                continue;
            }
            let is_newer = newest
                .as_ref()
                .map(|(current, _)| modified.duration_since(*current).is_ok())
                .unwrap_or(true);
            if is_newer {
                newest = Some((modified, path));
            }
        }
    }

    newest.map(|(_, path)| path)
}

fn codex_generated_images_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join(".codex").join("generated_images"));
    }
    if let Some(codex_home) = std::env::var_os("CODEX_HOME") {
        roots.push(PathBuf::from(codex_home).join("generated_images"));
    }
    roots.sort();
    roots.dedup();
    roots
}

fn find_codex_cached_png_in_roots<I>(
    roots: I,
    thread_id: Option<&str>,
    since: SystemTime,
    result_path: &Path,
) -> Option<PathBuf>
where
    I: IntoIterator<Item = PathBuf>,
{
    let thread_id = thread_id?.trim();
    if thread_id.is_empty()
        || thread_id.contains('/')
        || thread_id.contains('\\')
        || thread_id.contains("..")
    {
        return None;
    }

    for root in roots {
        let thread_root = root.join(thread_id);
        if let Some(candidate) = find_newest_png_since(&thread_root, result_path, since) {
            return Some(candidate);
        }
    }
    None
}

fn find_codex_cached_png(
    thread_id: Option<&str>,
    since: SystemTime,
    result_path: &Path,
) -> Option<PathBuf> {
    find_codex_cached_png_in_roots(
        codex_generated_images_roots(),
        thread_id,
        since,
        result_path,
    )
}

fn recover_codex_cached_png(
    result_path: &Path,
    thread_id: Option<&str>,
    since: SystemTime,
) -> Option<PathBuf> {
    let candidate = find_codex_cached_png(thread_id, since, result_path)?;
    copy_png_candidate(&candidate, result_path).then_some(candidate)
}

fn recover_result_png(
    job_path: &Path,
    result_path: &Path,
    output: Option<&Output>,
    thread_id: Option<&str>,
    codex_started_at: Option<SystemTime>,
) -> Option<PathBuf> {
    if file_has_png_signature(result_path) {
        return Some(result_path.to_path_buf());
    }

    if let Some(candidate) = find_png_file(job_path, result_path) {
        if copy_png_candidate(&candidate, result_path) {
            return Some(candidate);
        }
    }

    if let Some(output) = output {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if materialize_png_from_line(line, job_path, result_path) {
                return Some(result_path.to_path_buf());
            }
        }
        for line in String::from_utf8_lossy(&output.stderr).lines() {
            if materialize_png_from_line(line, job_path, result_path) {
                return Some(result_path.to_path_buf());
            }
        }
    }

    if let Some(since) = codex_started_at {
        if let Some(candidate) = recover_codex_cached_png(result_path, thread_id, since) {
            return Some(candidate);
        }
    }

    None
}

fn png_data_url(bytes: &[u8]) -> Result<String, String> {
    if !is_png(bytes) {
        return Err("Generated output is not a valid PNG file.".into());
    }

    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}

fn read_png_data_url(path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|e| format!("No output image found at {}: {e}", path.display()))?;
    png_data_url(&bytes)
}

fn safe_job_child_path(job_path: &Path, file_name: &str) -> Result<PathBuf, String> {
    let relative = Path::new(file_name.trim());
    if relative.as_os_str().is_empty() || relative.is_absolute() {
        return Err(format!("Manifest layer file path is invalid: {file_name}"));
    }
    for component in relative.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err(format!("Manifest layer file path is invalid: {file_name}"));
        }
    }
    Ok(job_path.join(relative))
}

fn run_with_timeout(command: &mut Command, timeout: Duration) -> Result<Output, String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch command: {e}"))?;

    let start = Instant::now();
    loop {
        if child
            .try_wait()
            .map_err(|e| format!("Failed to wait for command: {e}"))?
            .is_some()
        {
            return child
                .wait_with_output()
                .map_err(|e| format!("Failed to collect command output: {e}"));
        }

        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Generation timed out. Codex may still be busy, or the local command may be waiting for input.".into());
        }

        thread::sleep(POLL_INTERVAL);
    }
}

fn sanitize_progress_line(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let single_line = trimmed.split_whitespace().collect::<Vec<_>>().join(" ");
    let char_count = single_line.chars().count();
    let text = if char_count > 140 {
        format!("{}...", single_line.chars().take(137).collect::<String>())
    } else {
        single_line
    };

    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn json_string_at<'a>(value: &'a serde_json::Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

fn codex_agent_message_text(line: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
    let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let item_type = json_string_at(&value, &["item", "type"]).unwrap_or("");
    if !event_type.contains("item.completed") || !item_type.contains("agent_message") {
        return None;
    }
    let text = json_string_at(&value, &["item", "text"])?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn codex_thread_id_from_line(line: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
    let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if !event_type.contains("thread.started") {
        return None;
    }
    let thread_id = json_string_at(&value, &["thread_id"])?.trim();
    if thread_id.is_empty() {
        None
    } else {
        Some(thread_id.to_string())
    }
}

fn final_codex_agent_message_from_text(stdout: &str, stderr: &str) -> Option<String> {
    let mut messages = Vec::new();
    for line in stdout.lines().chain(stderr.lines()) {
        if let Some(message) = codex_agent_message_text(line) {
            let lower = message.to_ascii_lowercase();
            if lower.contains("using the imagegen skill")
                || lower.contains("using the image generation skill")
            {
                continue;
            }
            messages.push(message);
        }
    }
    let message = messages.pop()?;
    let char_count = message.chars().count();
    if char_count <= 2000 {
        Some(message)
    } else {
        Some(message.chars().skip(char_count - 2000).collect())
    }
}

fn final_codex_agent_message(output: &Output) -> Option<String> {
    final_codex_agent_message_from_text(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    )
}

fn codex_progress_message(line: &str, is_stderr: bool) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let item_type = json_string_at(&value, &["item", "type"]).unwrap_or("");
        let combined = format!("{event_type} {item_type} {}", value).to_ascii_lowercase();

        if event_type.contains("thread.started") {
            return Some("Codex session started".into());
        }
        if event_type.contains("turn.started") {
            return Some("Codex is working on the image".into());
        }
        if event_type.contains("turn.completed") {
            return Some("Codex finished; checking generated image cache".into());
        }
        if event_type.contains("error") {
            let message = json_string_at(&value, &["message"])
                .or_else(|| json_string_at(&value, &["error", "message"]))
                .and_then(sanitize_progress_line)
                .unwrap_or_else(|| "Codex reported an error".into());
            return Some(message);
        }
        if event_type.contains("item.started") {
            if combined.contains("imagegen") || combined.contains("image_generation") {
                return Some("Generating image with Codex".into());
            }
            if combined.contains("tool") || combined.contains("function") {
                return Some("Codex is using a local tool".into());
            }
            return Some("Codex is processing the prompt".into());
        }
        if event_type.contains("item.completed") {
            if combined.contains("imagegen") || combined.contains("image_generation") {
                return Some("Image generation step completed; waiting for Codex".into());
            }
            if combined.contains("agent_message") {
                if let Some(message) =
                    codex_agent_message_text(trimmed).and_then(|text| sanitize_progress_line(&text))
                {
                    let lower = message.to_ascii_lowercase();
                    if lower.contains("using the imagegen skill")
                        || lower.contains("using the `imagegen` skill")
                        || lower.contains("using the image generation skill")
                    {
                        return Some("Codex is preparing image generation".into());
                    }
                    return Some(format!("Codex: {message}"));
                }
                return Some("Codex is continuing image generation".into());
            }
        }
        return None;
    }

    let text = sanitize_progress_line(trimmed)?;
    let lower = text.to_ascii_lowercase();
    if is_stderr
        || lower.contains("codex")
        || lower.contains("thinking")
        || lower.contains("generating")
        || lower.contains("image")
        || lower.contains("result.png")
    {
        Some(text)
    } else {
        None
    }
}

fn emit_codex_progress(app: &AppHandle, run_id: &str, message: impl Into<String>) {
    let _ = app.emit(
        CODEX_PROGRESS_EVENT,
        CodexProgressPayload {
            run_id: run_id.to_string(),
            message: message.into(),
        },
    );
}

fn spawn_output_reader<R: Read + Send + 'static>(
    stream: R,
    sink: Arc<Mutex<Vec<u8>>>,
    app: AppHandle,
    run_id: String,
    is_stderr: bool,
    job_path: PathBuf,
    result_path: Option<PathBuf>,
    thread_id: Arc<Mutex<Option<String>>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if let Ok(mut output) = sink.lock() {
                        output.extend_from_slice(&line);
                    }
                    let text = String::from_utf8_lossy(&line);
                    if let Some(next_thread_id) = codex_thread_id_from_line(&text) {
                        if let Ok(mut current_thread_id) = thread_id.lock() {
                            *current_thread_id = Some(next_thread_id);
                        }
                    }
                    if let Some(message) = codex_progress_message(&text, is_stderr) {
                        emit_codex_progress(&app, &run_id, message);
                    }
                    if let Some(result_path) = &result_path {
                        if !file_has_png_signature(result_path)
                            && materialize_png_from_line(&text, &job_path, result_path)
                        {
                            emit_codex_progress(
                                &app,
                                &run_id,
                                "Recovered generated PNG from Codex output",
                            );
                        }
                    }
                }
                Err(_) => break,
            }
        }
    })
}

fn run_codex_with_progress(
    command: &mut Command,
    timeout: Duration,
    app: AppHandle,
    run_id: String,
    job_path: PathBuf,
    early_result_path: Option<PathBuf>,
    codex_started_at: SystemTime,
) -> Result<CodexRunResult, String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch command: {e}"))?;

    let stdout = Arc::new(Mutex::new(Vec::new()));
    let stderr = Arc::new(Mutex::new(Vec::new()));
    let thread_id = Arc::new(Mutex::new(None::<String>));
    let mut readers = Vec::new();

    if let Some(stream) = child.stdout.take() {
        readers.push(spawn_output_reader(
            stream,
            Arc::clone(&stdout),
            app.clone(),
            run_id.clone(),
            false,
            job_path.clone(),
            early_result_path.clone(),
            Arc::clone(&thread_id),
        ));
    }
    if let Some(stream) = child.stderr.take() {
        readers.push(spawn_output_reader(
            stream,
            Arc::clone(&stderr),
            app.clone(),
            run_id.clone(),
            true,
            job_path.clone(),
            early_result_path.clone(),
            Arc::clone(&thread_id),
        ));
    }

    let start = Instant::now();
    let mut last_result_size = None;
    let mut result_stable_since = None;
    let mut completed_from_result_file = false;
    let mut child_was_stopped = false;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("Failed to wait for command: {e}"))?
        {
            break status;
        }

        if let Some(result_path) = &early_result_path {
            if !file_has_png_signature(result_path) {
                let current_thread_id = thread_id.lock().ok().and_then(|id| id.clone());
                let _ = recover_result_png(
                    &job_path,
                    result_path,
                    None,
                    current_thread_id.as_deref(),
                    Some(codex_started_at),
                );
            }
            if stable_png_size(result_path, &mut last_result_size, &mut result_stable_since) {
                emit_codex_progress(
                    &app,
                    &run_id,
                    "Generated PNG copied; importing into CX Paint",
                );
                completed_from_result_file = true;
                child_was_stopped = true;
                let _ = child.kill();
                break child.wait().map_err(|e| {
                    format!("Failed to finish Codex after the generated PNG was copied: {e}")
                })?;
            }
        }

        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Generation timed out. Codex may still be busy, or the local command may be waiting for input.".into());
        }

        thread::sleep(POLL_INTERVAL);
    };

    if !child_was_stopped {
        for reader in readers {
            let _ = reader.join();
        }
    }

    let stdout = stdout
        .lock()
        .map(|bytes| bytes.clone())
        .unwrap_or_else(|_| Vec::new());
    let stderr = stderr
        .lock()
        .map(|bytes| bytes.clone())
        .unwrap_or_else(|_| Vec::new());
    let thread_id = thread_id.lock().ok().and_then(|id| id.clone());

    Ok(CodexRunResult {
        output: Output {
            status,
            stdout,
            stderr,
        },
        completed_from_result_file,
        thread_id,
    })
}

fn output_tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim();
    let char_count = trimmed.chars().count();
    if char_count <= 2000 {
        trimmed.to_string()
    } else {
        trimmed.chars().skip(char_count - 2000).collect()
    }
}

fn command_failure(prefix: &str, output: &Output) -> String {
    let stderr = output_tail(&output.stderr);
    let stdout = output_tail(&output.stdout);
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "No output was captured.".into()
    };

    let lower = detail.to_ascii_lowercase();
    if lower.contains("not authenticated")
        || lower.contains("not logged in")
        || lower.contains("login")
        || lower.contains("unauthorized")
    {
        return format!("{prefix} failed because Codex is not logged in. Run `codex login` in Terminal and try again.\n\n{detail}");
    }

    format!("{prefix} exited with {}:\n{detail}", output.status)
}

fn configured_or_default_codex_bin(bin: Option<String>) -> Result<String, String> {
    if let Some(bin) = bin.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        return Ok(bin);
    }

    let candidates = ["codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"];
    for candidate in candidates {
        if Command::new(candidate)
            .arg("--version")
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_API_KEY")
            .output()
            .is_ok()
        {
            return Ok(candidate.to_string());
        }
    }

    Err(
        "Codex CLI was not found. Install Codex, or enter the full path to the `codex` binary."
            .into(),
    )
}

fn codex_prompt(user_prompt: &str) -> String {
    format!(
        r#"Use $imagegen to generate one raster PNG for CX Paint.

User image prompt:
{user_prompt}

Requirements:
- Create exactly one image from the user prompt.
- Use the normal Codex image-generation flow and keep the generated image in Codex's generated-images cache.
- Do not create, edit, or delete files in the working directory.
- Do not ask follow-up questions; make reasonable visual choices from the prompt.
- If the prompt needs safety or quality adjustment, make a reasonable compliant rephrasing and continue with image generation.
- Only return PROMPT_NEEDS_REVISION: if image generation is impossible without user input; include a concise reason and one safer revised prompt suggestion.
- If successful, final response should be one short sentence confirming the image was generated."#
    )
}

fn build_codex_command(
    codex_bin: &str,
    job_path: &Path,
    prompt: &str,
    json_progress: bool,
) -> Command {
    let mut command = Command::new(codex_bin);
    command
        .current_dir(job_path)
        .arg("-s")
        .arg("workspace-write")
        .arg("-a")
        .arg("never")
        .arg("-C")
        .arg(job_path)
        .arg("exec")
        .arg("--ephemeral")
        .arg("--skip-git-repo-check");
    if json_progress {
        command.arg("--json");
    }
    command
        .arg(codex_prompt(prompt.trim()))
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY");
    command
}

fn decouple_codex_prompt(user_prompt: &str) -> String {
    format!(
        r##"Use the attached `source.png` to create a CX Paint recomposition asset pack.

User guidance:
{user_prompt}

Goal:
- Extract or regenerate useful standalone visual assets from the source image for later AI compositing workflows and storyboard planning.
- Think of the result as reusable visual references/ingredients for a node workflow, not as layers that must stack back together to recreate the source photo.
- Prefer assets such as people/characters, held objects, vehicles, product/prop objects, architectural landmarks, environment plates, plants, and useful shadows/reflections when helpful.
- Preserve the subject identity, pose, style, lighting direction, and broad perspective, but prioritize clean reusable assets over exact original occlusion geometry.

Required AI-image workflow:
- Use Codex image generation / the `$imagegen` image skill for the visual reconstruction steps, not text-only reasoning.
- First identify and label the main objects in `source.png`.
- Decide the asset inventory before generating images. Avoid duplicate visual ownership: if an item is extracted as its own asset, remove or neutralize it from any larger subject asset that originally held, overlapped, or contained it.
- Generate a clean environment/background asset when useful.
- For each major editable object, generate an isolated standalone asset from the source image.
- If a person/character originally holds a separately extracted prop, generate the person/character asset with natural empty hands, a neutral pose, or cleanly reconstructed fingers/hands instead of still holding that prop.
- If an object is embedded in or occludes another extracted asset, choose one primary asset to own that object and reconstruct the other asset without it.
- The preferred deliverable for each object/character/prop is a PNG with real transparency, including soft alpha for hair, lace, rope, glass, shadows, antialiasing, and semi-transparent material.
- If real transparent output is not practical, create a grayscale alpha mask PNG with the same dimensions as the asset PNG and record it in `alphaMask`; white means opaque, black means transparent, and gray means partially transparent.
- Use a perfectly flat single-color matte background and `keyColor` only as the last fallback when neither real alpha nor an alpha mask is practical.
- After each generated image is available, copy or save the resulting PNG into the current working directory using the filename you list in `manifest.json`.
- You may use scripts only for deterministic processing: locating generated PNGs, copying files, applying or validating alpha masks, chroma-keying a matte, cropping transparent bounds, inspecting dimensions, and validating output.

Required files in the current working directory:
- `manifest.json`
- One PNG file for each asset listed in `manifest.json`

Manifest schema:
{{
  "assets": [
    {{
      "name": "Girl",
      "file": "girl-asset.png",
      "alphaMask": null,
      "keyColor": null,
      "x": 0,
      "y": 0,
      "opacity": 1,
      "visible": true
    }}
  ],
  "notes": "Optional short notes about rough edges or generated/inpainted regions."
}}

Asset file requirements:
- PNG only.
- Prefer transparent-background PNGs with real alpha for object/character/prop assets.
- If the asset PNG has a background but you can create a soft alpha mask, save the grayscale mask as a PNG and set `alphaMask` to that filename.
- If you generate an object on a plain matte/green-screen background without an alpha mask, set `keyColor` to the exact matte color such as "#00ff00"; CX Paint will remove that color into alpha.
- Choose a matte color that does not appear in the object. It does not need to be green.
- For reusable assets, prefer tight crops with transparent or keyed backgrounds. Set `x` and `y` to 0 unless the image is intentionally a full-size environment plate.
- Use manifest order from broad environment assets to foreground subject/prop assets.
- Keep filenames simple ASCII with `.png`.
- Do not ask follow-up questions.
- Do not edit files outside the current working directory.

Final response:
- One short sentence that says the asset pack was created.
- Do not embed base64 in the final response."##
    )
}

fn build_decouple_codex_command(
    codex_bin: &str,
    job_path: &Path,
    prompt: &str,
    json_progress: bool,
) -> Command {
    let mut command = Command::new(codex_bin);
    command
        .current_dir(job_path)
        .arg("-s")
        .arg("workspace-write")
        .arg("-a")
        .arg("never")
        .arg("-C")
        .arg(job_path)
        .arg("exec")
        .arg("--skip-git-repo-check");
    if json_progress {
        command.arg("--json");
    }
    command
        .arg("-i")
        .arg(job_path.join("source.png"))
        .arg("--")
        .arg(decouple_codex_prompt(prompt.trim()))
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY");
    command
}

fn workflow_compose_prompt(prompt: &str, source_names: &[String]) -> String {
    let sources = source_names
        .iter()
        .enumerate()
        .map(|(i, name)| format!("{}. {}", i + 1, name))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"Use $imagegen to compose one new raster PNG for CX Paint from the attached workflow asset images.

Connected workflow inputs:
{sources}

Composition prompt:
{prompt}

Requirements:
- Treat every attached image as intentionally connected to the composition node.
- Use all attached asset images as visual references/assets for identity, subject appearance, object design, and scene ingredients unless the prompt explicitly says to omit one.
- If an attached image is named "Storyboard sketch", use it as the layout, placement, and annotation guide for the final image.
- Create one coherent new image from the composition prompt.
- Match perspective, lighting, scale, and contact shadows plausibly.
- Do not make a collage or contact sheet.
- Save or copy the final composed PNG to `result.png` in the current working directory.
- Do not create, edit, or delete files outside the current working directory.
- Do not ask follow-up questions.
- If a safety or quality adjustment is needed, make a reasonable compliant rephrasing and continue.

Final response should be one short sentence confirming the composed image was generated."#
    )
}

fn build_workflow_compose_codex_command(
    codex_bin: &str,
    job_path: &Path,
    image_paths: &[PathBuf],
    prompt: &str,
    source_names: &[String],
    json_progress: bool,
) -> Command {
    let mut command = Command::new(codex_bin);
    command
        .current_dir(job_path)
        .arg("-s")
        .arg("workspace-write")
        .arg("-a")
        .arg("never")
        .arg("-C")
        .arg(job_path)
        .arg("exec")
        .arg("--skip-git-repo-check");
    if json_progress {
        command.arg("--json");
    }
    if !image_paths.is_empty() {
        command.arg("-i");
        for path in image_paths {
            command.arg(path);
        }
    }
    command
        .arg("--")
        .arg(workflow_compose_prompt(prompt.trim(), source_names))
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY");
    command
}

fn output_mentions_unsupported_json(output: &Output) -> bool {
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
    .to_ascii_lowercase();
    combined.contains("--json")
        && (combined.contains("unexpected argument")
            || combined.contains("unknown option")
            || combined.contains("unrecognized option")
            || combined.contains("found argument"))
}

/// Run a user-configured local command to generate an image, then return it as a PNG data URL.
///
/// Security model: the command + args come from the app's own settings (local, user-entered),
/// and are executed via an **argv array — never a shell** (`std::process::Command`), so the
/// prompt text cannot inject shell syntax. `{prompt}` and `{output}` placeholders in the args
/// are substituted as single argv elements; `{output}` is a temp PNG path the tool must write.
#[tauri::command]
async fn generate_image(bin: String, args: Vec<String>, prompt: String) -> Result<String, String> {
    if bin.trim().is_empty() {
        return Err("No generator command configured.".into());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        // Unique temp output path for the tool to write into.
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut out_path = std::env::temp_dir();
        out_path.push(format!("cxpaint-gen-{ts}.png"));
        let out_str = out_path.to_string_lossy().to_string();

        let final_args: Vec<String> = args
            .iter()
            .map(|a| a.replace("{prompt}", &prompt).replace("{output}", &out_str))
            .collect();

        let mut command = Command::new(&bin);
        command.args(&final_args);
        let output = run_with_timeout(&mut command, GENERATION_TIMEOUT)
            .map_err(|e| format!("Failed to launch '{bin}': {e}"))?;

        if !output.status.success() {
            return Err(command_failure("Generator", &output));
        }

        let data_url = read_png_data_url(&out_path)?;
        let _ = fs::remove_file(&out_path);

        Ok(data_url)
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

/// Run local Codex headlessly to generate an image into a temp job folder.
///
/// Auth is intentionally left to the user's local Codex installation. This command never reads
/// Codex auth files and strips API-key environment variables so this provider prefers the user's
/// existing ChatGPT/Codex sign-in rather than accidental API billing.
#[tauri::command]
async fn generate_codex_image(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    run_id: String,
) -> Result<GeneratedImageResult, String> {
    if prompt.trim().is_empty() {
        return Err("Enter a prompt.".into());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let codex_bin = configured_or_default_codex_bin(bin)?;
        let run_id = if run_id.trim().is_empty() {
            format!("codex-{}", now_id())
        } else {
            run_id
        };
        let project_dir = project_path
            .as_ref()
            .map(|p| PathBuf::from(p.trim()))
            .filter(|p| !p.as_os_str().is_empty());
        let cleanup_project_job = project_dir.is_some();
        let temp_job;
        let job_path = if let Some(project_dir) = &project_dir {
            ensure_project_dirs(project_dir)?;
            let run_dir = project_dir
                .join(".cxpaint")
                .join("codex-runs")
                .join(format!("run-{}", now_id()));
            fs::create_dir_all(&run_dir)
                .map_err(|e| format!("Failed to create Codex run folder: {e}"))?;
            run_dir
        } else {
            temp_job = TempJobDir::new("cxpaint-codex")?;
            temp_job.path().to_path_buf()
        };
        let result_path = job_path.join("result.png");

        emit_codex_progress(&app, &run_id, "Starting local Codex");
        let codex_started_at = SystemTime::now();
        let mut command = build_codex_command(&codex_bin, &job_path, prompt.trim(), true);
        let mut run = run_codex_with_progress(
            &mut command,
            GENERATION_TIMEOUT,
            app.clone(),
            run_id.clone(),
            job_path.clone(),
            Some(result_path.clone()),
            codex_started_at,
        )
        .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;

        if !run.completed_from_result_file
            && !run.output.status.success()
            && output_mentions_unsupported_json(&run.output)
        {
            emit_codex_progress(
                &app,
                &run_id,
                "Codex progress stream unavailable; retrying generation",
            );
            let mut fallback = build_codex_command(&codex_bin, &job_path, prompt.trim(), false);
            run = run_codex_with_progress(
                &mut fallback,
                GENERATION_TIMEOUT,
                app.clone(),
                run_id.clone(),
                job_path.clone(),
                Some(result_path.clone()),
                codex_started_at,
            )
            .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;
        }

        if !run.completed_from_result_file && !run.output.status.success() {
            if let Some(message) = final_codex_agent_message(&run.output) {
                return Err(format!("Codex did not generate an image.\n\n{message}"));
            }
            return Err(command_failure("Codex", &run.output));
        }

        let recovered_source_path = if !file_has_png_signature(&result_path) {
            recover_result_png(
                &job_path,
                &result_path,
                Some(&run.output),
                run.thread_id.as_deref(),
                Some(codex_started_at),
            )
        } else {
            find_codex_cached_png(run.thread_id.as_deref(), codex_started_at, &result_path)
        };

        if recovered_source_path.is_some()
            && recovered_source_path.as_deref() != Some(result_path.as_path())
        {
            emit_codex_progress(&app, &run_id, "Recovered generated PNG; importing");
        }

        emit_codex_progress(&app, &run_id, "Reading copied PNG");
        if !result_path.exists() {
            if let Some(message) = final_codex_agent_message(&run.output) {
                return Err(format!(
                    "Codex did not generate an image.\n\n{message}\n\nInternal copy path: {}",
                    result_path.display()
                ));
            }

            let stdout = output_tail(&run.output.stdout);
            let stderr = output_tail(&run.output.stderr);
            let detail = if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                "Codex completed without exposing a generated PNG that CX Paint could copy.".into()
            };
            return Err(format!(
                "CX Paint could not find a new PNG in Codex's generated-images cache.\nInternal copy path: {}\n\n{detail}",
                result_path.display()
            ));
        }

        let data_url = read_png_data_url(&result_path)?;
        let asset = if let Some(project_dir) = project_dir {
            emit_codex_progress(&app, &run_id, "Saving generated image to the project");
            let bytes = fs::read(&result_path)
                .map_err(|e| format!("Failed to read generated image for project storage: {e}"))?;
            let source_file_name = recovered_source_path
                .as_ref()
                .and_then(|path| path.file_name())
                .and_then(|name| name.to_str())
                .filter(|name| safe_file_name(name).is_some());
            let (id, relative_path) = if let Some(file_name) = source_file_name {
                write_asset_file_with_file_name(&project_dir, "generated", file_name, &bytes)?
            } else {
                write_asset_file(&project_dir, "generated", prompt.trim(), "png", &bytes)?
            };
            let asset = ProjectAsset {
                id,
                kind: "generated".into(),
                name: source_file_name
                    .map(str::to_string)
                    .unwrap_or_else(|| prompt.trim().chars().take(48).collect::<String>()),
                relative_path,
                created_at: now_id(),
                prompt: Some(prompt.trim().into()),
                source_file_name: source_file_name.map(str::to_string),
                width: None,
                height: None,
                mime: Some("image/png".into()),
            };
            Some(add_asset(&project_dir, asset)?)
        } else {
            None
        };

        if cleanup_project_job {
            let _ = fs::remove_dir_all(&job_path);
        }

        emit_codex_progress(&app, &run_id, "Done");
        Ok(GeneratedImageResult { data_url, asset })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

/// Ask local Codex to turn one source PNG into a manifest plus reusable asset PNGs.
///
/// The app owns the deterministic import step; Codex only needs to satisfy the file contract.
#[tauri::command]
async fn decouple_codex_image(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    source_png: Vec<u8>,
    run_id: String,
    store_assets: Option<bool>,
) -> Result<DecoupleImageResult, String> {
    if !is_png(&source_png) {
        return Err("Asset extraction source must be a PNG image.".into());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<DecoupleImageResult, String> {
        let codex_bin = configured_or_default_codex_bin(bin)?;
        let run_id = if run_id.trim().is_empty() {
            format!("decouple-{}", now_id())
        } else {
            run_id
        };
        let project_dir = project_path
            .as_ref()
            .map(|p| PathBuf::from(p.trim()))
            .filter(|p| !p.as_os_str().is_empty());
        let store_assets = store_assets.unwrap_or(true);
        let temp_job;
        let job_path = if let Some(project_dir) = &project_dir {
            ensure_project_dirs(project_dir)?;
            let run_dir = project_dir
                .join(".cxpaint")
                .join("codex-runs")
                .join(format!("decouple-{}", now_id()));
            fs::create_dir_all(&run_dir)
                .map_err(|e| format!("Failed to create Codex decouple folder: {e}"))?;
            run_dir
        } else {
            temp_job = TempJobDir::new("cxpaint-decouple")?;
            temp_job.path().to_path_buf()
        };

        let source_path = job_path.join("source.png");
        fs::write(&source_path, &source_png)
            .map_err(|e| format!("Failed to write decouple source image: {e}"))?;

        emit_codex_progress(&app, &run_id, "Starting local Codex asset extraction");
        let codex_started_at = SystemTime::now();
        let user_prompt = if prompt.trim().is_empty() {
            "Identify the main reusable elements and create a useful recomposition asset pack."
        } else {
            prompt.trim()
        };
        let mut command = build_decouple_codex_command(&codex_bin, &job_path, user_prompt, true);
        let mut run = run_codex_with_progress(
            &mut command,
            GENERATION_TIMEOUT,
            app.clone(),
            run_id.clone(),
            job_path.clone(),
            None,
            codex_started_at,
        )
        .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;

        if !run.output.status.success() && output_mentions_unsupported_json(&run.output) {
            emit_codex_progress(
                &app,
                &run_id,
                "Codex progress stream unavailable; retrying asset extraction",
            );
            let mut fallback =
                build_decouple_codex_command(&codex_bin, &job_path, user_prompt, false);
            run = run_codex_with_progress(
                &mut fallback,
                GENERATION_TIMEOUT,
                app.clone(),
                run_id.clone(),
                job_path.clone(),
                None,
                codex_started_at,
            )
            .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;
        }

        if !run.output.status.success() {
            if let Some(message) = final_codex_agent_message(&run.output) {
                return Err(format!("Codex did not create an asset pack.\n\n{message}"));
            }
            return Err(command_failure("Codex asset extraction", &run.output));
        }

        let manifest_path = job_path.join("manifest.json");
        emit_codex_progress(&app, &run_id, "Reading asset manifest");
        let manifest_text = fs::read_to_string(&manifest_path).map_err(|e| {
            format!(
                "Codex did not create manifest.json at {}: {e}",
                manifest_path.display()
            )
        })?;
        let manifest: DecoupleManifest = serde_json::from_str(&manifest_text)
            .map_err(|e| format!("Asset manifest is invalid JSON: {e}"))?;
        if manifest.layers.is_empty() {
            return Err("Asset manifest did not contain any assets.".into());
        }

        let mut layers = Vec::new();
        for (index, layer) in manifest.layers.into_iter().enumerate() {
            let name = layer.name.trim();
            let name = if name.is_empty() {
                format!("Extracted Asset {}", index + 1)
            } else {
                name.chars().take(80).collect::<String>()
            };
            let layer_path = safe_job_child_path(&job_path, &layer.file)?;
            let bytes = fs::read(&layer_path).map_err(|e| {
                format!(
                    "Asset '{}' was listed but could not be read at {}: {e}",
                    name,
                    layer_path.display()
                )
            })?;
            if !is_png(&bytes) {
                return Err(format!("Asset '{}' is not a valid PNG.", name));
            }

            let data_url = png_data_url(&bytes)?;
            let alpha_mask_data_url = match layer.alpha_mask.as_deref().map(str::trim) {
                Some(mask_file) if !mask_file.is_empty() => {
                    let mask_path = safe_job_child_path(&job_path, mask_file)?;
                    let mask_bytes = fs::read(&mask_path).map_err(|e| {
                        format!(
                            "Alpha mask for asset '{}' was listed but could not be read at {}: {e}",
                            name,
                            mask_path.display()
                        )
                    })?;
                    if !is_png(&mask_bytes) {
                        return Err(format!(
                            "Alpha mask for asset '{}' is not a valid PNG.",
                            name
                        ));
                    }
                    Some(png_data_url(&mask_bytes)?)
                }
                _ => None,
            };
            let asset = match (store_assets, project_dir.as_ref()) {
                (true, Some(project_dir)) => {
                    let (id, relative_path) =
                        write_asset_file(project_dir, "generated", &name, "png", &bytes)?;
                    Some(add_asset(
                        project_dir,
                        ProjectAsset {
                            id,
                            kind: "generated".into(),
                            name: name.clone(),
                            relative_path,
                            created_at: now_id(),
                            prompt: Some(format!(
                                "Extracted workflow asset from source: {user_prompt}"
                            )),
                            source_file_name: Path::new(&layer.file)
                                .file_name()
                                .and_then(|s| s.to_str())
                                .map(str::to_string),
                            width: None,
                            height: None,
                            mime: Some("image/png".into()),
                        },
                    )?)
                }
                _ => None,
            };

            layers.push(DecoupledLayerResult {
                name,
                data_url,
                alpha_mask_data_url,
                key_color: layer.key_color,
                x: layer.x,
                y: layer.y,
                opacity: layer.opacity,
                visible: layer.visible,
                asset,
            });
        }

        emit_codex_progress(&app, &run_id, "Done");
        Ok(DecoupleImageResult {
            layers,
            thread_id: run.thread_id,
            notes: manifest.notes,
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
async fn compose_codex_workflow(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    sources: Vec<WorkflowSourceImage>,
    run_id: String,
) -> Result<GeneratedImageResult, String> {
    if prompt.trim().is_empty() {
        return Err("Enter a composition prompt.".into());
    }
    if sources.is_empty() {
        return Err("Add at least one asset node before generating.".into());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let codex_bin = configured_or_default_codex_bin(bin)?;
        let run_id = if run_id.trim().is_empty() {
            format!("workflow-{}", now_id())
        } else {
            run_id
        };
        let project_dir = project_path
            .as_ref()
            .map(|p| PathBuf::from(p.trim()))
            .filter(|p| !p.as_os_str().is_empty());
        let cleanup_project_job = project_dir.is_some();
        let temp_job;
        let job_path = if let Some(project_dir) = &project_dir {
            ensure_project_dirs(project_dir)?;
            let run_dir = project_dir
                .join(".cxpaint")
                .join("codex-runs")
                .join(format!("workflow-{}", now_id()));
            fs::create_dir_all(&run_dir)
                .map_err(|e| format!("Failed to create Codex workflow folder: {e}"))?;
            run_dir
        } else {
            temp_job = TempJobDir::new("cxpaint-workflow")?;
            temp_job.path().to_path_buf()
        };

        let mut source_names = Vec::new();
        let mut image_paths = Vec::new();
        for (index, source) in sources.into_iter().enumerate() {
            if !is_png(&source.bytes) {
                return Err(format!(
                    "Workflow asset '{}' is not a PNG image.",
                    source.name
                ));
            }
            let name = if source.name.trim().is_empty() {
                format!("asset-{}", index + 1)
            } else {
                source.name.chars().take(64).collect::<String>()
            };
            let path = job_path.join(format!("{}-{}.png", index + 1, safe_stem(&name)));
            fs::write(&path, &source.bytes)
                .map_err(|e| format!("Failed to write workflow source image: {e}"))?;
            source_names.push(name);
            image_paths.push(path);
        }

        let result_path = job_path.join("result.png");
        emit_codex_progress(&app, &run_id, "Starting local Codex workflow composition");
        let codex_started_at = SystemTime::now();
        let mut command = build_workflow_compose_codex_command(
            &codex_bin,
            &job_path,
            &image_paths,
            prompt.trim(),
            &source_names,
            true,
        );
        let mut run = run_codex_with_progress(
            &mut command,
            GENERATION_TIMEOUT,
            app.clone(),
            run_id.clone(),
            job_path.clone(),
            Some(result_path.clone()),
            codex_started_at,
        )
        .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;

        if !run.completed_from_result_file
            && !run.output.status.success()
            && output_mentions_unsupported_json(&run.output)
        {
            emit_codex_progress(
                &app,
                &run_id,
                "Codex progress stream unavailable; retrying workflow composition",
            );
            let mut fallback = build_workflow_compose_codex_command(
                &codex_bin,
                &job_path,
                &image_paths,
                prompt.trim(),
                &source_names,
                false,
            );
            run = run_codex_with_progress(
                &mut fallback,
                GENERATION_TIMEOUT,
                app.clone(),
                run_id.clone(),
                job_path.clone(),
                Some(result_path.clone()),
                codex_started_at,
            )
            .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;
        }

        if !run.completed_from_result_file && !run.output.status.success() {
            if let Some(message) = final_codex_agent_message(&run.output) {
                return Err(format!("Codex did not compose an image.\n\n{message}"));
            }
            return Err(command_failure("Codex workflow composition", &run.output));
        }

        let recovered_source_path = if !file_has_png_signature(&result_path) {
            recover_result_png(
                &job_path,
                &result_path,
                Some(&run.output),
                run.thread_id.as_deref(),
                Some(codex_started_at),
            )
        } else {
            find_codex_cached_png(run.thread_id.as_deref(), codex_started_at, &result_path)
        };

        if recovered_source_path.is_some()
            && recovered_source_path.as_deref() != Some(result_path.as_path())
        {
            emit_codex_progress(&app, &run_id, "Recovered composed PNG; importing");
        }

        emit_codex_progress(&app, &run_id, "Reading composed PNG");
        if !result_path.exists() {
            if let Some(message) = final_codex_agent_message(&run.output) {
                return Err(format!(
                    "Codex did not expose a composed image.\n\n{message}\n\nInternal copy path: {}",
                    result_path.display()
                ));
            }
            return Err(format!(
                "CX Paint could not find a composed PNG at {}.",
                result_path.display()
            ));
        }

        let data_url = read_png_data_url(&result_path)?;
        let asset = if let Some(project_dir) = project_dir {
            emit_codex_progress(&app, &run_id, "Saving composed image to the project");
            let bytes = fs::read(&result_path)
                .map_err(|e| format!("Failed to read composed image for project storage: {e}"))?;
            let (id, relative_path) =
                write_asset_file(&project_dir, "generated", prompt.trim(), "png", &bytes)?;
            let asset = ProjectAsset {
                id,
                kind: "generated".into(),
                name: format!(
                    "Workflow: {}",
                    prompt.trim().chars().take(48).collect::<String>()
                ),
                relative_path,
                created_at: now_id(),
                prompt: Some(prompt.trim().into()),
                source_file_name: recovered_source_path
                    .as_ref()
                    .and_then(|path| path.file_name())
                    .and_then(|name| name.to_str())
                    .map(str::to_string),
                width: None,
                height: None,
                mime: Some("image/png".into()),
            };
            Some(add_asset(&project_dir, asset)?)
        } else {
            None
        };

        if cleanup_project_job {
            let _ = fs::remove_dir_all(&job_path);
        }

        emit_codex_progress(&app, &run_id, "Done");
        Ok(GeneratedImageResult { data_url, asset })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
async fn project_open_folder() -> Result<Option<ProjectState>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<ProjectState>, String> {
        let Some(path) = rfd::FileDialog::new()
            .set_title("Open CX Paint Project Folder")
            .pick_folder()
        else {
            return Ok(None);
        };
        Ok(Some(project_state(&path)?))
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
async fn project_refresh(project_path: String) -> Result<ProjectState, String> {
    tauri::async_runtime::spawn_blocking(move || project_state(Path::new(project_path.trim())))
        .await
        .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
async fn project_store_asset_bytes(
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
async fn project_read_asset(
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
async fn project_reveal(project_path: String, asset_id: Option<String>) -> Result<(), String> {
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
async fn project_reveal_file(project_path: String, relative_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let project_dir = PathBuf::from(project_path.trim());
        let relative = safe_project_relative_path(&relative_path)?;
        reveal_path(&project_dir.join(relative))
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
async fn project_read_file(project_path: String, relative_path: String) -> Result<Vec<u8>, String> {
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
async fn project_delete_asset(
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
        let asset = manifest.assets.remove(index);
        let source = project_dir.join(&asset.relative_path);
        if source.exists() {
            let trash = project_dir.join(".cxpaint").join("trash").join(format!(
                "{}-{}",
                now_id(),
                source
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("asset")
            ));
            if let Some(parent) = trash.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create trash folder: {e}"))?;
            }
            fs::rename(&source, &trash)
                .map_err(|e| format!("Failed to move asset to project trash: {e}"))?;
        }
        save_manifest(&project_dir, &manifest)?;
        project_state(&project_dir)
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
async fn project_write_document(
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
async fn project_write_document_path(
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
async fn project_save_document_as(
    project_path: Option<String>,
    name: String,
    previous_name: Option<String>,
    dialog_title: Option<String>,
    bytes: Vec<u8>,
) -> Result<Option<SavedDocumentResult>, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<SavedDocumentResult>, String> {
        let project_dir = project_path
            .as_deref()
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from);
        let default_name = safe_document_file_name(&name);
        let dialog_title = dialog_title
            .as_deref()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .unwrap_or("Save OpenRaster Document");
        let mut dialog = rfd::FileDialog::new()
            .set_title(dialog_title)
            .add_filter("OpenRaster", &["ora"])
            .set_file_name(&default_name);

        if let Some(project_dir) = &project_dir {
            let documents_dir = project_dir.join("documents");
            fs::create_dir_all(&documents_dir)
                .map_err(|e| format!("Failed to create documents folder: {e}"))?;
            dialog = dialog.set_directory(documents_dir);
        }

        let Some(mut path) = dialog.save_file() else {
            return Ok(None);
        };
        if !path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("ora"))
        {
            path.set_extension("ora");
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
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("Untitled")
            .to_string();
        Ok(Some(SavedDocumentResult {
            relative_path: display_path,
            name,
        }))
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let new = MenuItem::with_id(app, "app:new", "New...", true, Some("CmdOrCtrl+N"))?;
    let open = MenuItem::with_id(app, "app:open", "Open...", true, Some("CmdOrCtrl+O"))?;
    let place = MenuItem::with_id(app, "app:place-image", "Place Image...", true, None::<&str>)?;
    let save = MenuItem::with_id(app, "app:save-ora", "Save", true, Some("CmdOrCtrl+S"))?;
    let save_copy = MenuItem::with_id(
        app,
        "app:save-copy-ora",
        "Save a Copy...",
        true,
        Some("CmdOrCtrl+Shift+S"),
    )?;
    let export = MenuItem::with_id(
        app,
        "app:export-png",
        "Export PNG...",
        true,
        Some("CmdOrCtrl+E"),
    )?;

    let undo = MenuItem::with_id(app, "app:undo", "Undo", true, Some("CmdOrCtrl+Z"))?;
    let redo = MenuItem::with_id(app, "app:redo", "Redo", true, Some("CmdOrCtrl+Shift+Z"))?;
    let cut = MenuItem::with_id(app, "app:cut", "Cut", true, Some("CmdOrCtrl+X"))?;
    let copy = MenuItem::with_id(app, "app:copy", "Copy", true, Some("CmdOrCtrl+C"))?;
    let paste = MenuItem::with_id(app, "app:paste", "Paste", true, Some("CmdOrCtrl+V"))?;
    let fill_fg = MenuItem::with_id(
        app,
        "app:fill-foreground",
        "Fill with Foreground",
        true,
        None::<&str>,
    )?;
    let fill_bg = MenuItem::with_id(
        app,
        "app:fill-background",
        "Fill with Background",
        true,
        None::<&str>,
    )?;
    let clear = MenuItem::with_id(app, "app:clear", "Clear", true, Some("Delete"))?;

    let image_size = MenuItem::with_id(app, "app:image-size", "Image Size...", true, None::<&str>)?;
    let reveal_all = MenuItem::with_id(app, "app:reveal-all", "Reveal All", true, None::<&str>)?;
    let crop = MenuItem::with_id(
        app,
        "app:crop-to-selection",
        "Crop to Selection",
        true,
        None::<&str>,
    )?;
    let rotate_cw = MenuItem::with_id(app, "app:rotate-cw", "Rotate 90° CW", true, None::<&str>)?;
    let rotate_ccw =
        MenuItem::with_id(app, "app:rotate-ccw", "Rotate 90° CCW", true, None::<&str>)?;
    let rotate_180 = MenuItem::with_id(app, "app:rotate-180", "Rotate 180°", true, None::<&str>)?;
    let flip_h = MenuItem::with_id(
        app,
        "app:flip-horizontal",
        "Flip Horizontal",
        true,
        None::<&str>,
    )?;
    let flip_v = MenuItem::with_id(
        app,
        "app:flip-vertical",
        "Flip Vertical",
        true,
        None::<&str>,
    )?;
    let brightness = MenuItem::with_id(
        app,
        "app:brightness-contrast",
        "Brightness/Contrast...",
        true,
        None::<&str>,
    )?;
    let hue = MenuItem::with_id(
        app,
        "app:hue-saturation",
        "Hue/Saturation...",
        true,
        None::<&str>,
    )?;
    let desaturate = MenuItem::with_id(app, "app:desaturate", "Desaturate", true, None::<&str>)?;
    let invert = MenuItem::with_id(app, "app:invert", "Invert", true, Some("CmdOrCtrl+I"))?;
    let flatten = MenuItem::with_id(app, "app:flatten", "Flatten Image", true, None::<&str>)?;

    let new_layer = MenuItem::with_id(app, "app:new-layer", "New Layer", true, None::<&str>)?;
    let duplicate_layer = MenuItem::with_id(
        app,
        "app:duplicate-layer",
        "Duplicate Layer",
        true,
        None::<&str>,
    )?;
    let delete_layer =
        MenuItem::with_id(app, "app:delete-layer", "Delete Layer", true, None::<&str>)?;
    let merge_down = MenuItem::with_id(app, "app:merge-down", "Merge Down", true, None::<&str>)?;

    let select_all = MenuItem::with_id(app, "app:select-all", "All", true, Some("CmdOrCtrl+A"))?;
    let deselect = MenuItem::with_id(app, "app:deselect", "Deselect", true, Some("CmdOrCtrl+D"))?;
    let inverse = MenuItem::with_id(
        app,
        "app:inverse-selection",
        "Inverse",
        true,
        Some("CmdOrCtrl+Shift+I"),
    )?;

    let gaussian = MenuItem::with_id(
        app,
        "app:gaussian-blur",
        "Gaussian Blur...",
        true,
        None::<&str>,
    )?;
    let sharpen = MenuItem::with_id(app, "app:sharpen", "Sharpen", true, None::<&str>)?;
    let ai_generate = MenuItem::with_id(
        app,
        "app:ai-generate",
        "Generate Image...",
        true,
        None::<&str>,
    )?;
    let ai_decouple = MenuItem::with_id(
        app,
        "app:ai-decouple",
        "Extract Assets...",
        true,
        None::<&str>,
    )?;
    let workflow_board = MenuItem::with_id(
        app,
        "app:workflow-board",
        "New Workflow Board",
        true,
        None::<&str>,
    )?;
    let zoom_in = MenuItem::with_id(app, "app:zoom-in", "Zoom In", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(app, "app:zoom-out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let fit = MenuItem::with_id(
        app,
        "app:fit-screen",
        "Fit on Screen",
        true,
        Some("CmdOrCtrl+0"),
    )?;
    let actual = MenuItem::with_id(
        app,
        "app:actual-pixels",
        "Actual Pixels (100%)",
        true,
        Some("CmdOrCtrl+1"),
    )?;
    let about = MenuItem::with_id(app, "app:about", "About CX Paint", true, None::<&str>)?;

    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new,
            &open,
            &place,
            &PredefinedMenuItem::separator(app)?,
            &save,
            &save_copy,
            &export,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &undo,
            &redo,
            &PredefinedMenuItem::separator(app)?,
            &cut,
            &copy,
            &paste,
            &PredefinedMenuItem::separator(app)?,
            &fill_fg,
            &fill_bg,
            &clear,
        ],
    )?;
    let image = Submenu::with_items(
        app,
        "Image",
        true,
        &[
            &image_size,
            &reveal_all,
            &crop,
            &PredefinedMenuItem::separator(app)?,
            &rotate_cw,
            &rotate_ccw,
            &rotate_180,
            &flip_h,
            &flip_v,
            &PredefinedMenuItem::separator(app)?,
            &brightness,
            &hue,
            &desaturate,
            &invert,
            &PredefinedMenuItem::separator(app)?,
            &flatten,
        ],
    )?;
    let layer = Submenu::with_items(
        app,
        "Layer",
        true,
        &[
            &new_layer,
            &duplicate_layer,
            &delete_layer,
            &PredefinedMenuItem::separator(app)?,
            &merge_down,
        ],
    )?;
    let select = Submenu::with_items(app, "Select", true, &[&select_all, &deselect, &inverse])?;
    let filter = Submenu::with_items(app, "Filter", true, &[&gaussian, &sharpen])?;
    let ai = Submenu::with_items(
        app,
        "AI",
        true,
        &[
            &ai_generate,
            &ai_decouple,
            &PredefinedMenuItem::separator(app)?,
            &workflow_board,
        ],
    )?;
    let view = Submenu::with_items(app, "View", true, &[&zoom_in, &zoom_out, &fit, &actual])?;
    let help = Submenu::with_items(app, "Help", true, &[&about])?;

    Menu::with_items(
        app,
        &[
            &file, &edit, &image, &layer, &select, &filter, &ai, &view, &help,
        ],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let menu = build_app_menu(app.handle())?;
            app.handle().set_menu(menu)?;
            app.handle().on_menu_event(|app, event| {
                let id = event.id().as_ref();
                if id.starts_with("app:") {
                    let _ = app.emit("app-menu", id.to_string());
                }
            });
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            generate_image,
            generate_codex_image,
            decouple_codex_image,
            compose_codex_workflow,
            project_open_folder,
            project_refresh,
            project_store_asset_bytes,
            project_read_asset,
            project_reveal,
            project_reveal_file,
            project_read_file,
            project_delete_asset,
            project_write_document,
            project_write_document_path,
            project_save_document_as
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    const ONE_PIXEL_PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89,
    ];

    #[test]
    fn png_data_url_accepts_png_signature() {
        let data_url = png_data_url(ONE_PIXEL_PNG).expect("valid PNG signature");
        assert!(data_url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn png_data_url_rejects_non_png() {
        let err = png_data_url(b"not a png").expect_err("invalid PNG should fail");
        assert!(err.contains("not a valid PNG"));
    }

    #[test]
    fn ora_thumbnail_data_url_reads_embedded_thumbnail() {
        let job = TempJobDir::new("cxpaint-ora-thumb-test").expect("temp dir");
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
        let job = TempJobDir::new("cxpaint-ora-merged-test").expect("temp dir");
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
    fn temp_job_dir_removes_directory_on_drop() {
        let path = {
            let job = TempJobDir::new("cxpaint-test").expect("temp dir");
            let marker = job.path().join("marker.txt");
            fs::write(&marker, b"ok").expect("write marker");
            assert!(marker.exists());
            job.path().to_path_buf()
        };

        assert!(!path.exists());
    }

    #[test]
    fn codex_progress_message_maps_json_events() {
        let message = codex_progress_message(r#"{"type":"turn.started"}"#, false)
            .expect("turn event should map to progress");
        assert_eq!(message, "Codex is working on the image");

        let message = codex_progress_message(
            r#"{"type":"item.started","item":{"type":"image_generation_call","name":"imagegen"}}"#,
            false,
        )
        .expect("image event should map to progress");
        assert_eq!(message, "Generating image with Codex");

        let message = codex_progress_message(
            r#"{"type":"item.completed","item":{"type":"image_generation_call","name":"imagegen"}}"#,
            false,
        )
        .expect("completed image event should map to progress");
        assert_eq!(
            message,
            "Image generation step completed; waiting for Codex"
        );

        let message = codex_progress_message(
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"I’ll keep this as a preview/cache generation only, so I won’t touch the workspace. I’m also phrasing the person as a clearly adult young woman."}}"#,
            false,
        )
        .expect("agent message should map to progress");
        assert!(message.starts_with("Codex:"));
        assert!(message.contains("preview/cache generation"));
    }

    #[test]
    fn codex_progress_message_sanitizes_plain_text() {
        let message = codex_progress_message("  generating image\n", true)
            .expect("stderr line should map to progress");
        assert_eq!(message, "generating image");
    }

    #[test]
    fn codex_thread_id_from_line_extracts_thread_started_event() {
        let thread_id = codex_thread_id_from_line(
            r#"{"type":"thread.started","thread_id":"019ef9e6-cc0a-79b3-9464-c2d16354e957"}"#,
        )
        .expect("thread id");
        assert_eq!(thread_id, "019ef9e6-cc0a-79b3-9464-c2d16354e957");
        assert!(codex_thread_id_from_line(r#"{"type":"turn.started"}"#).is_none());
    }

    #[test]
    fn final_codex_agent_message_extracts_last_meaningful_message() {
        let stdout = r#"{"type":"item.completed","item":{"type":"agent_message","text":"I’m using the imagegen skill because this is a raster image generation request."}}
{"type":"item.completed","item":{"type":"agent_message","text":"Generated one raster PNG for CX Paint and kept it in Codex’s generated-images cache."}}"#;

        let message = final_codex_agent_message_from_text(stdout, "")
            .expect("should extract final agent message");
        assert!(message.starts_with("Generated one raster PNG"));
    }

    #[test]
    fn decouple_codex_command_delimits_image_args_before_prompt() {
        let job = TempJobDir::new("cxpaint-decouple-command-test").expect("temp dir");
        let command = build_decouple_codex_command("codex", job.path(), "separate objects", true);
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        let image_idx = args
            .iter()
            .position(|arg| arg == "-i")
            .expect("image arg should be present");
        assert_eq!(
            args[image_idx + 1],
            job.path().join("source.png").to_string_lossy()
        );
        assert_eq!(args[image_idx + 2], "--");
        assert!(
            args[image_idx + 3].contains("User guidance:\nseparate objects"),
            "prompt should be passed after -- instead of being consumed as another image path",
        );
    }

    #[test]
    fn decouple_prompt_prevents_duplicate_held_props_across_assets() {
        let prompt = decouple_codex_prompt("extract girl and apple");
        assert!(prompt.contains("Avoid duplicate visual ownership"));
        assert!(
            prompt.contains("If a person/character originally holds a separately extracted prop")
        );
        assert!(prompt.contains("natural empty hands"));
    }

    #[test]
    fn decouple_prompt_prefers_soft_alpha_assets_over_keyed_mattes() {
        let prompt = decouple_codex_prompt("extract rope railing");
        assert!(prompt.contains("PNG with real transparency"));
        assert!(prompt.contains("soft alpha for hair, lace, rope"));
        assert!(prompt.contains("\"assets\": ["));
        assert!(prompt.contains("\"alphaMask\": null"));
        assert!(prompt.contains("last fallback"));
    }

    #[test]
    fn decouple_manifest_reads_optional_alpha_mask() {
        let manifest: DecoupleManifest = serde_json::from_str(
            r#"{
              "assets": [
                {
                  "name": "Rope railing",
                  "file": "rope.png",
                  "alphaMask": "rope-mask.png",
                  "keyColor": null,
                  "x": 0,
                  "y": 0,
                  "opacity": 1,
                  "visible": true
                }
              ],
              "notes": "mask used for soft rope edges"
            }"#,
        )
        .expect("manifest should parse");

        assert_eq!(
            manifest.layers[0].alpha_mask.as_deref(),
            Some("rope-mask.png")
        );
    }

    #[test]
    fn decouple_manifest_accepts_legacy_layers_key() {
        let manifest: DecoupleManifest = serde_json::from_str(
            r#"{
              "layers": [
                {
                  "name": "Girl",
                  "file": "girl.png",
                  "alphaMask": null,
                  "keyColor": null,
                  "x": 0,
                  "y": 0,
                  "opacity": 1,
                  "visible": true
                }
              ]
            }"#,
        )
        .expect("legacy manifest should parse");

        assert_eq!(manifest.layers.len(), 1);
        assert_eq!(manifest.layers[0].name, "Girl");
    }

    #[test]
    fn workflow_compose_command_delimits_variadic_image_args_before_prompt() {
        let job = TempJobDir::new("cxpaint-workflow-command-test").expect("temp dir");
        let image_paths = vec![job.path().join("girl.png"), job.path().join("truck.png")];
        let names = vec!["girl".to_string(), "truck".to_string()];
        let command = build_workflow_compose_codex_command(
            "codex",
            job.path(),
            &image_paths,
            "compose scene",
            &names,
            true,
        );
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        let image_idx = args
            .iter()
            .position(|arg| arg == "-i")
            .expect("image arg should be present");
        assert_eq!(args[image_idx + 1], image_paths[0].to_string_lossy());
        assert_eq!(args[image_idx + 2], image_paths[1].to_string_lossy());
        assert_eq!(args[image_idx + 3], "--");
        assert!(args[image_idx + 4].contains("Composition prompt:\ncompose scene"));
    }

    #[test]
    fn workflow_compose_prompt_requires_connected_assets_and_storyboard() {
        let prompt = workflow_compose_prompt(
            "girl holds apple by the water",
            &[
                "Girl With Empty Hands".to_string(),
                "Storyboard sketch: composition layout and handwritten placement annotations"
                    .to_string(),
            ],
        );

        assert!(prompt.contains("Connected workflow inputs"));
        assert!(prompt.contains("Treat every attached image as intentionally connected"));
        assert!(prompt.contains("Use all attached asset images"));
        assert!(prompt.contains("If an attached image is named \"Storyboard sketch\""));
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
    fn stable_png_size_waits_for_unchanged_png_file() {
        let job = TempJobDir::new("cxpaint-stable-png-test").expect("temp dir");
        let path = job.path().join("result.png");
        fs::write(&path, ONE_PIXEL_PNG).expect("write png signature");

        let mut last_size = None;
        let mut stable_since = None;
        assert!(!stable_png_size(&path, &mut last_size, &mut stable_since));

        thread::sleep(RESULT_STABLE_DURATION + Duration::from_millis(50));
        assert!(stable_png_size(&path, &mut last_size, &mut stable_since));
    }

    #[test]
    fn materialize_png_from_json_data_url_writes_result_png() {
        let job = TempJobDir::new("cxpaint-json-png-test").expect("temp dir");
        let result_path = job.path().join("result.png");
        let b64 = base64::engine::general_purpose::STANDARD.encode(ONE_PIXEL_PNG);
        let line = format!(r#"{{"item":{{"result":"data:image/png;base64,{b64}"}}}}"#);

        assert!(materialize_png_from_line(&line, job.path(), &result_path));
        assert!(file_has_png_signature(&result_path));
    }

    #[test]
    fn recover_result_png_copies_png_from_job_folder() {
        let job = TempJobDir::new("cxpaint-recover-png-test").expect("temp dir");
        let nested = job.path().join("images");
        fs::create_dir_all(&nested).expect("nested dir");
        fs::write(nested.join("generated.png"), ONE_PIXEL_PNG).expect("write generated png");

        let result_path = job.path().join("result.png");
        let recovered = recover_result_png(job.path(), &result_path, None, None, None)
            .expect("should recover generated png");
        assert_eq!(recovered, nested.join("generated.png"));
        assert!(file_has_png_signature(&result_path));
    }

    #[test]
    fn write_asset_file_with_file_name_preserves_codex_file_name() {
        let project = TempJobDir::new("cxpaint-project-name-test").expect("project dir");
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
    fn autosave_document_overwrites_same_file_and_cleans_timestamped_versions() {
        let project = TempJobDir::new("cxpaint-autosave-overwrite-test").expect("project dir");
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

    #[test]
    fn find_newest_png_since_filters_old_cache_images() {
        let cache = TempJobDir::new("cxpaint-cache-png-test").expect("cache dir");
        let old_dir = cache.path().join("old");
        let new_dir = cache.path().join("new");
        fs::create_dir_all(&old_dir).expect("old dir");
        fs::create_dir_all(&new_dir).expect("new dir");
        fs::write(old_dir.join("old.png"), ONE_PIXEL_PNG).expect("old png");

        let since = SystemTime::now();
        thread::sleep(Duration::from_millis(20));
        let new_path = new_dir.join("new.png");
        fs::write(&new_path, ONE_PIXEL_PNG).expect("new png");

        let result_path = cache.path().join("result.png");
        let found = find_newest_png_since(cache.path(), &result_path, since).expect("new png");
        assert_eq!(found, new_path);
    }

    #[test]
    fn find_codex_cached_png_requires_matching_thread_folder() {
        let cache = TempJobDir::new("cxpaint-thread-cache-png-test").expect("cache dir");
        let own_thread = "019ef9e6-cc0a-79b3-9464-c2d16354e957";
        let other_thread = "019ef9e7-a111-7ccc-9000-c2d16354e958";
        let own_dir = cache.path().join(own_thread);
        let other_dir = cache.path().join(other_thread);
        fs::create_dir_all(&own_dir).expect("own thread dir");
        fs::create_dir_all(&other_dir).expect("other thread dir");

        let since = SystemTime::now();
        thread::sleep(Duration::from_millis(20));
        let other_path = other_dir.join("other.png");
        fs::write(&other_path, ONE_PIXEL_PNG).expect("other png");
        thread::sleep(Duration::from_millis(20));
        let own_path = own_dir.join("own.png");
        fs::write(&own_path, ONE_PIXEL_PNG).expect("own png");

        let result_path = cache.path().join("result.png");
        let found = find_codex_cached_png_in_roots(
            vec![cache.path().to_path_buf()],
            Some(own_thread),
            since,
            &result_path,
        )
        .expect("own png");
        assert_eq!(found, own_path);

        let wrong_thread = find_codex_cached_png_in_roots(
            vec![cache.path().to_path_buf()],
            Some("missing-thread"),
            since,
            &result_path,
        );
        assert!(wrong_thread.is_none());

        let no_thread = find_codex_cached_png_in_roots(
            vec![cache.path().to_path_buf()],
            None,
            since,
            &result_path,
        );
        assert!(no_thread.is_none());
    }
}
