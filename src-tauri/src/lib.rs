use base64::Engine;
use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    fs,
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Read, Seek, Write},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime},
};

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, System};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, RunEvent};

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const GENERATION_TIMEOUT: Duration = Duration::from_secs(600);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const AI_RETOUCH_OUTPUT_MASK_GROW_RADIUS: u32 = 0;
const AI_RETOUCH_OUTPUT_MASK_FEATHER_RADIUS: u32 = 0;
// Must match PAINTNODE_CHROMA_KEY_HEX in src/lib/engine/decouple/chroma.ts.
const AI_CHROMA_KEY_HEX: &str = "#00ff00";
const AI_CHROMA_KEY_RGBA: [u8; 4] = [0, 255, 0, 255];
const PROJECT_MANIFEST: &str = "paintnode.project.json";
const DEFAULT_PROJECT_DIR_NAME: &str = "PaintNode";
const CODEX_PROGRESS_EVENT: &str = "codex-generation-progress";
const PAINTNODE_WORK_DIR: &str = "paintnode";
const CODEX_RUNS_DIR: &str = "codex-runs";
const ANTIGRAVITY_RUNS_DIR: &str = "antigravity-runs";
const AI_WORKING_CANVAS_UNIT: u32 = 16;
const PROJECT_THUMBNAIL_MAX_EDGE: u32 = 160;
const NATIVE_OPEN_FILES_EVENT: &str = "native-open-files";

#[derive(Clone, Default)]
struct PendingOpenPaths(Arc<Mutex<Vec<String>>>);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PixelRect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct SupportedAspectRatio {
    label: String,
    width: u32,
    height: u32,
    min_width: u32,
    min_height: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ImageModelCapabilities {
    fallback_aspect_ratios: Vec<SupportedAspectRatio>,
    providers: ImageProviderCapabilities,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
struct ImageProviderCapabilities {
    codex: CodexImageCapability,
    antigravity: AntigravityImageCapability,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CodexImageCapability {
    dimension_multiple: u32,
    max_long_side: u32,
    max_short_side: u32,
    max_aspect_ratio: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct AntigravityImageCapability {
    aspect_ratios: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AiWorkingCanvas {
    original_dimensions: (u32, u32),
    working_dimensions: (u32, u32),
    content_rect: PixelRect,
    aspect_label: String,
}

static AI_IMAGE_MODEL_CAPABILITIES: OnceLock<ImageModelCapabilities> = OnceLock::new();
const AI_IMAGE_MODEL_CAPABILITIES_JSON: &str =
    include_str!("../../src/lib/ai/imageModelCapabilities.json");

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
    assets: Vec<ProjectAssetView>,
    mask_data_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexDetectionResult {
    found: bool,
    path: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppMemoryInfo {
    resident_bytes: u64,
    process_count: usize,
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

fn reference_png_file_name(index: usize, name: &str) -> String {
    let source = Path::new(name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(name);
    format!("reference-{}-{}.png", index + 1, safe_stem(source))
}

fn validate_reference_pngs(
    references: &[WorkflowSourceImage],
    context: &str,
) -> Result<(), String> {
    for (index, reference) in references.iter().enumerate() {
        if !is_png(&reference.bytes) {
            return Err(format!(
                "{context} reference {} is not a PNG image.",
                index + 1
            ));
        }
        png_dimensions_from_bytes(&reference.bytes).ok_or_else(|| {
            format!(
                "{context} reference {} PNG dimensions are invalid.",
                index + 1
            )
        })?;
    }
    Ok(())
}

fn write_reference_pngs(
    job_path: &Path,
    references: &[WorkflowSourceImage],
    context: &str,
) -> Result<(Vec<PathBuf>, Vec<String>), String> {
    if references.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let reference_dir = job_path.join("references");
    fs::create_dir_all(&reference_dir)
        .map_err(|e| format!("Failed to create {context} references directory: {e}"))?;
    let mut paths = Vec::with_capacity(references.len());
    let mut names = Vec::with_capacity(references.len());
    for (index, reference) in references.iter().enumerate() {
        let name = reference_png_file_name(index, &reference.name);
        let path = reference_dir.join(&name);
        fs::write(&path, &reference.bytes)
            .map_err(|e| format!("Failed to write {context} reference image: {e}"))?;
        paths.push(path);
        names.push(format!("references/{name}"));
    }
    Ok((paths, names))
}

fn reference_prompt_note(reference_names: &[String], prefix: &str) -> String {
    if reference_names.is_empty() {
        return "- No additional user reference images are attached.".into();
    }
    let mut lines = vec!["Additional user reference images:".to_string()];
    for name in reference_names {
        lines.push(format!("- `{prefix}{name}`: user-added visual reference."));
    }
    lines.push("Use these references as visual guidance for style, identity, material, palette, composition, or specific details requested by the prompt. Do not paste them directly unless the user explicitly asks for copied content.".into());
    lines.join("\n")
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexProgressPayload {
    run_id: String,
    message: String,
}

#[derive(Debug)]
struct CodexRunResult {
    output: Output,
    thread_id: Option<String>,
    satisfied_required_output: bool,
}

#[derive(Debug, Default)]
struct CodexCommandOptions {
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
}

#[derive(Debug, Default)]
struct AntigravityCommandOptions {
    model: Option<String>,
    approval_mode: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AiAutonomyLevel {
    Low,
    Guided,
    Open,
    Unmanaged,
}

#[derive(Debug)]
struct CodexImageRunResult {
    run: CodexRunResult,
    image_cached_before_exit: bool,
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDroppedFile {
    path: String,
    name: String,
    bytes: Vec<u8>,
    size: u64,
    modified_at: u128,
    mime: Option<String>,
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
    fs::create_dir_all(project_path.join("storyboards"))
        .map_err(|e| format!("Failed to create storyboards folder: {e}"))?;
    fs::create_dir_all(project_path.join("autosave"))
        .map_err(|e| format!("Failed to create autosave folder: {e}"))?;
    fs::create_dir_all(project_path.join("assets").join("generated"))
        .map_err(|e| format!("Failed to create generated assets folder: {e}"))?;
    fs::create_dir_all(project_path.join("assets").join("imported"))
        .map_err(|e| format!("Failed to create imported assets folder: {e}"))?;
    fs::create_dir_all(project_path.join(PAINTNODE_WORK_DIR).join(CODEX_RUNS_DIR))
        .map_err(|e| format!("Failed to create Codex runs folder: {e}"))?;
    fs::create_dir_all(
        project_path
            .join(PAINTNODE_WORK_DIR)
            .join(ANTIGRAVITY_RUNS_DIR),
    )
    .map_err(|e| format!("Failed to create Antigravity runs folder: {e}"))?;
    fs::create_dir_all(project_path.join(PAINTNODE_WORK_DIR).join("trash"))
        .map_err(|e| format!("Failed to create project trash folder: {e}"))?;
    fs::create_dir_all(project_path.join(PAINTNODE_WORK_DIR).join("thumbnails"))
        .map_err(|e| format!("Failed to create project thumbnail cache folder: {e}"))?;
    Ok(())
}

fn project_agent_run_dir(
    project_dir: &Path,
    vendor_dir: &str,
    prefix: &str,
) -> Result<PathBuf, String> {
    ensure_project_dirs(project_dir)?;
    let run_dir = project_dir
        .join(PAINTNODE_WORK_DIR)
        .join(vendor_dir)
        .join(format!("{prefix}-{}", now_id()));
    fs::create_dir_all(&run_dir).map_err(|e| format!("Failed to create AI job folder: {e}"))?;
    Ok(run_dir)
}

fn optional_project_dir(project_path: &Option<String>) -> Option<PathBuf> {
    project_path
        .as_ref()
        .map(|p| PathBuf::from(p.trim()))
        .filter(|p| !p.as_os_str().is_empty())
}

fn default_documents_project_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|e| format!("Failed to locate the Documents folder: {e}"))?;
    Ok(documents.join(DEFAULT_PROJECT_DIR_NAME))
}

fn ai_job_project_dir(
    app: &AppHandle,
    project_dir: &Option<PathBuf>,
    keep_job_dir: bool,
) -> Result<Option<PathBuf>, String> {
    if project_dir.is_some() || !keep_job_dir {
        return Ok(project_dir.clone());
    }
    let default_dir = default_documents_project_dir(app)?;
    ensure_project_dirs(&default_dir)?;
    Ok(Some(default_dir))
}

fn cleanup_project_agent_job(job_path: &Path) {
    let _ = fs::remove_dir_all(job_path);
    if let Some(vendor_dir) = job_path.parent() {
        let is_agent_vendor_dir = vendor_dir
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            == Some(PAINTNODE_WORK_DIR);
        if is_agent_vendor_dir {
            let is_empty = fs::read_dir(vendor_dir)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false);
            if is_empty {
                let _ = fs::remove_dir(vendor_dir);
            }
        }
    }
}

fn should_keep_job_dir(keep_job_dir: Option<bool>) -> bool {
    keep_job_dir.unwrap_or(false)
}

fn cleanup_project_job_enabled(project_dir: &Option<PathBuf>, keep_job_dir: bool) -> bool {
    project_dir.is_some() && !keep_job_dir
}

fn write_ai_job_prompt(job_path: &Path, prompt: &str, label: &str) -> Result<(), String> {
    fs::write(job_path.join("prompt.txt"), prompt)
        .map_err(|e| format!("Failed to write {label} prompt file: {e}"))
}

fn emit_kept_job_dir(app: &AppHandle, run_id: &str, job_path: &Path, keep_job_dir: bool) {
    if keep_job_dir {
        emit_codex_progress(
            app,
            run_id,
            &format!("Saved AI run inputs: {}", job_path.display()),
        );
    }
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

fn png_data_url_from_bytes(bytes: &[u8]) -> Option<String> {
    if !is_png(bytes) {
        return None;
    }
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:image/png;base64,{b64}"))
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

fn queue_native_open_paths(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    app.state::<PendingOpenPaths>()
        .0
        .lock()
        .map(|mut pending| pending.extend(paths.clone()))
        .ok();
    let _ = app.emit(NATIVE_OPEN_FILES_EVENT, paths);
}

#[tauri::command]
fn take_pending_open_paths(state: tauri::State<'_, PendingOpenPaths>) -> Vec<String> {
    state
        .0
        .lock()
        .map(|mut pending| std::mem::take(&mut *pending))
        .unwrap_or_default()
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

fn add_asset(project_path: &Path, asset: ProjectAsset) -> Result<ProjectAssetView, String> {
    let mut manifest = load_manifest(project_path)?;
    manifest.assets.retain(|existing| existing.id != asset.id);
    manifest.assets.push(asset.clone());
    save_manifest(project_path, &manifest)?;
    Ok(asset_view(project_path, asset))
}

fn safe_png_source_file_name(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| *name != "result.png")
        .filter(|name| safe_file_name(name).is_some())
        .map(str::to_string)
}

fn ai_retouch_asset_name(prompt: &str, source_file_name: Option<&str>) -> String {
    source_file_name.map(str::to_string).unwrap_or_else(|| {
        let prompt = prompt.trim();
        let suffix = if prompt.is_empty() {
            "result".into()
        } else {
            prompt.chars().take(48).collect::<String>()
        };
        format!("AI Retouch: {suffix}")
    })
}

fn store_generated_png_asset(
    project_dir: &Path,
    bytes: &[u8],
    name: String,
    prompt: Option<String>,
    source_file_name: Option<String>,
) -> Result<ProjectAssetView, String> {
    let (id, relative_path) = write_asset_file(project_dir, "generated", &name, "png", bytes)?;
    add_asset(
        project_dir,
        ProjectAsset {
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
        },
    )
}

fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(PNG_SIGNATURE)
}

fn png_dimensions_from_bytes(bytes: &[u8]) -> Option<(u32, u32)> {
    if !is_png(bytes) || bytes.len() < 24 {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    (width > 0 && height > 0).then_some((width, height))
}

fn png_dimensions(path: &Path) -> Result<(u32, u32), String> {
    let bytes = fs::read(path)
        .map_err(|e| format!("Failed to read PNG dimensions at {}: {e}", path.display()))?;
    png_dimensions_from_bytes(&bytes)
        .ok_or_else(|| format!("PNG dimensions are invalid at {}.", path.display()))
}

fn decode_png_rgba(bytes: &[u8], label: &str) -> Result<image::RgbaImage, String> {
    if !is_png(bytes) {
        return Err(format!("{label} is not a PNG image."));
    }
    let image = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to decode {label} PNG: {e}"))?;
    Ok(image.to_rgba8())
}

fn encode_rgba_png(image: image::RgbaImage, label: &str) -> Result<Vec<u8>, String> {
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode {label} PNG: {e}"))?;
    Ok(bytes.into_inner())
}

fn ai_chroma_key_pixel() -> image::Rgba<u8> {
    image::Rgba(AI_CHROMA_KEY_RGBA)
}

fn ai_mask_padding_pixel() -> image::Rgba<u8> {
    image::Rgba([0, 0, 0, 0])
}

impl AiWorkingCanvas {
    fn has_padding(&self) -> bool {
        self.original_dimensions != self.working_dimensions
            || self.content_rect.x != 0
            || self.content_rect.y != 0
    }
}

fn ai_image_model_capabilities() -> &'static ImageModelCapabilities {
    AI_IMAGE_MODEL_CAPABILITIES.get_or_init(|| {
        serde_json::from_str(AI_IMAGE_MODEL_CAPABILITIES_JSON)
            .expect("PaintNode AI image model capabilities JSON must be valid")
    })
}

fn round_up_to_unit(value: u32, unit: u32) -> u32 {
    value.div_ceil(unit).max(1) * unit
}

fn ai_working_canvas_for_dimensions(dimensions: (u32, u32)) -> AiWorkingCanvas {
    let (original_width, original_height) = dimensions;
    let mut best: Option<(AiWorkingCanvas, u64, u64)> = None;

    for ratio in &ai_image_model_capabilities().fallback_aspect_ratios {
        let minimum_units = original_width
            .div_ceil(ratio.width)
            .max(original_height.div_ceil(ratio.height))
            .max(1);
        let units = round_up_to_unit(minimum_units, AI_WORKING_CANVAS_UNIT);
        let Some(working_width) = ratio.width.checked_mul(units) else {
            continue;
        };
        let Some(working_height) = ratio.height.checked_mul(units) else {
            continue;
        };
        let working_width = working_width.max(ratio.min_width);
        let working_height = working_height.max(ratio.min_height);
        if working_width < original_width || working_height < original_height {
            continue;
        }
        let area = u64::from(working_width) * u64::from(working_height);
        let aspect_error = ((i128::from(working_width) * i128::from(original_height))
            - (i128::from(working_height) * i128::from(original_width)))
        .unsigned_abs() as u64;
        let content_rect = PixelRect {
            x: (working_width - original_width) / 2,
            y: (working_height - original_height) / 2,
            width: original_width,
            height: original_height,
        };
        let canvas = AiWorkingCanvas {
            original_dimensions: dimensions,
            working_dimensions: (working_width, working_height),
            content_rect,
            aspect_label: ratio.label.clone(),
        };
        let is_better = best
            .as_ref()
            .map(|(_, best_area, best_aspect_error)| {
                (aspect_error, area) < (*best_aspect_error, *best_area)
            })
            .unwrap_or(true);
        if is_better {
            best = Some((canvas, area, aspect_error));
        }
    }

    best.map(|(canvas, _, _)| canvas)
        .unwrap_or(AiWorkingCanvas {
            original_dimensions: dimensions,
            working_dimensions: dimensions,
            content_rect: PixelRect {
                x: 0,
                y: 0,
                width: original_width,
                height: original_height,
            },
            aspect_label: "custom".into(),
        })
}

fn ai_exact_supported_aspect_ratio(
    dimensions: (u32, u32),
) -> Option<&'static SupportedAspectRatio> {
    let (width, height) = dimensions;
    if width == 0 || height == 0 {
        return None;
    }
    ai_image_model_capabilities()
        .fallback_aspect_ratios
        .iter()
        .find(|ratio| {
            u128::from(width) * u128::from(ratio.height)
                == u128::from(height) * u128::from(ratio.width)
        })
}

fn ai_working_canvas_for_exact_supported_ratio(dimensions: (u32, u32)) -> Option<AiWorkingCanvas> {
    let (width, height) = dimensions;
    ai_exact_supported_aspect_ratio(dimensions).map(|ratio| AiWorkingCanvas {
        original_dimensions: dimensions,
        working_dimensions: dimensions,
        content_rect: PixelRect {
            x: 0,
            y: 0,
            width,
            height,
        },
        aspect_label: ratio.label.clone(),
    })
}

fn ai_exact_working_canvas(dimensions: (u32, u32), aspect_label: &str) -> AiWorkingCanvas {
    let (width, height) = dimensions;
    AiWorkingCanvas {
        original_dimensions: dimensions,
        working_dimensions: dimensions,
        content_rect: PixelRect {
            x: 0,
            y: 0,
            width,
            height,
        },
        aspect_label: aspect_label.into(),
    }
}

fn ai_codex_gpt_image_2_supports_dimensions(dimensions: (u32, u32)) -> bool {
    let (width, height) = dimensions;
    let long_side = width.max(height);
    let short_side = width.min(height);
    let codex = &ai_image_model_capabilities().providers.codex;
    width > 0
        && height > 0
        && codex.dimension_multiple > 0
        && long_side <= codex.max_long_side
        && short_side <= codex.max_short_side
        && width % codex.dimension_multiple == 0
        && height % codex.dimension_multiple == 0
        && u128::from(width) <= u128::from(height) * u128::from(codex.max_aspect_ratio)
        && u128::from(height) <= u128::from(width) * u128::from(codex.max_aspect_ratio)
}

fn ai_codex_working_canvas_for_dimensions(dimensions: (u32, u32)) -> AiWorkingCanvas {
    if ai_codex_gpt_image_2_supports_dimensions(dimensions) {
        return ai_exact_working_canvas(dimensions, "codex");
    }
    ai_working_canvas_for_exact_supported_ratio(dimensions)
        .unwrap_or_else(|| ai_working_canvas_for_dimensions(dimensions))
}

fn validate_optional_target_dimensions(
    width: Option<u32>,
    height: Option<u32>,
) -> Result<Option<(u32, u32)>, String> {
    match (width, height) {
        (Some(width), Some(height)) if width > 0 && height > 0 => Ok(Some((width, height))),
        (None, None) => Ok(None),
        _ => Err("AI target dimensions must include both width and height.".into()),
    }
}

fn pad_png_to_ai_working_canvas(
    bytes: &[u8],
    working: &AiWorkingCanvas,
    label: &str,
    background: image::Rgba<u8>,
) -> Result<Vec<u8>, String> {
    let image = decode_png_rgba(bytes, label)?;
    if image.dimensions() != working.original_dimensions {
        return Err(format!(
            "{label} must be {}x{} before PaintNode prepares the AI working canvas, but it is {}x{}.",
            working.original_dimensions.0,
            working.original_dimensions.1,
            image.width(),
            image.height()
        ));
    }
    if !working.has_padding() {
        return Ok(bytes.to_vec());
    }

    let mut out = image::RgbaImage::from_pixel(
        working.working_dimensions.0,
        working.working_dimensions.1,
        background,
    );
    for y in 0..working.content_rect.height {
        for x in 0..working.content_rect.width {
            out.put_pixel(
                working.content_rect.x + x,
                working.content_rect.y + y,
                *image.get_pixel(x, y),
            );
        }
    }
    encode_rgba_png(out, label)
}

fn scaled_content_rect(result_dimensions: (u32, u32), working: &AiWorkingCanvas) -> PixelRect {
    let scale_x = result_dimensions.0 as f64 / working.working_dimensions.0 as f64;
    let scale_y = result_dimensions.1 as f64 / working.working_dimensions.1 as f64;
    let x = (working.content_rect.x as f64 * scale_x).round() as u32;
    let y = (working.content_rect.y as f64 * scale_y).round() as u32;
    let mut width = (working.content_rect.width as f64 * scale_x).round() as u32;
    let mut height = (working.content_rect.height as f64 * scale_y).round() as u32;
    let x = x.min(result_dimensions.0.saturating_sub(1));
    let y = y.min(result_dimensions.1.saturating_sub(1));
    width = width.max(1).min(result_dimensions.0 - x);
    height = height.max(1).min(result_dimensions.1 - y);
    PixelRect {
        x,
        y,
        width,
        height,
    }
}

fn pixel_is_ai_chroma_key(pixel: &image::Rgba<u8>) -> bool {
    let [r, g, b, a] = pixel.0;
    a >= 245
        && r.abs_diff(AI_CHROMA_KEY_RGBA[0]) <= 8
        && g.abs_diff(AI_CHROMA_KEY_RGBA[1]) <= 8
        && b.abs_diff(AI_CHROMA_KEY_RGBA[2]) <= 8
}

fn ai_chroma_key_padding_coverage(
    image: &image::RgbaImage,
    content_rect: PixelRect,
) -> Option<f64> {
    let mut padding_pixels = 0_u64;
    let mut keyed_pixels = 0_u64;
    for y in 0..image.height() {
        for x in 0..image.width() {
            let inside = x >= content_rect.x
                && x < content_rect.x + content_rect.width
                && y >= content_rect.y
                && y < content_rect.y + content_rect.height;
            if inside {
                continue;
            }
            padding_pixels += 1;
            if pixel_is_ai_chroma_key(image.get_pixel(x, y)) {
                keyed_pixels += 1;
            }
        }
    }
    (padding_pixels > 0).then(|| keyed_pixels as f64 / padding_pixels as f64)
}

fn crop_png_bytes_to_ai_content(
    bytes: &[u8],
    working: &AiWorkingCanvas,
    label: &str,
) -> Result<(Vec<u8>, (u32, u32), bool), String> {
    let result_dimensions = png_dimensions_from_bytes(bytes)
        .ok_or_else(|| format!("{label} PNG dimensions are invalid."))?;
    if result_dimensions == working.original_dimensions {
        return Ok((bytes.to_vec(), result_dimensions, false));
    }

    let image = decode_png_rgba(bytes, label)?;
    let rect = scaled_content_rect(result_dimensions, working);
    let normalized = if working.has_padding()
        && ai_chroma_key_padding_coverage(&image, rect)
            .map(|coverage| coverage < 0.6)
            .unwrap_or(false)
    {
        image::imageops::resize(
            &image,
            working.original_dimensions.0,
            working.original_dimensions.1,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        let cropped =
            image::imageops::crop_imm(&image, rect.x, rect.y, rect.width, rect.height).to_image();
        if cropped.dimensions() == working.original_dimensions {
            cropped
        } else {
            image::imageops::resize(
                &cropped,
                working.original_dimensions.0,
                working.original_dimensions.1,
                image::imageops::FilterType::Lanczos3,
            )
        }
    };
    let normalized_bytes = encode_rgba_png(normalized, label)?;
    Ok((normalized_bytes, result_dimensions, true))
}

fn read_png_bytes_cropped_to_ai_working_canvas(
    path: &Path,
    working: &AiWorkingCanvas,
    label: &str,
) -> Result<(Vec<u8>, (u32, u32), bool), String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read {label}: {e}"))?;
    let (normalized_bytes, result_dimensions, normalized) =
        crop_png_bytes_to_ai_content(&bytes, working, label)?;
    if normalized {
        fs::write(path, &normalized_bytes)
            .map_err(|e| format!("Failed to write cropped {label} at {}: {e}", path.display()))?;
    }
    Ok((normalized_bytes, result_dimensions, normalized))
}

fn ai_working_canvas_accepts_result_dimensions(
    working: &AiWorkingCanvas,
    dimensions: (u32, u32),
) -> bool {
    if dimensions == working.original_dimensions || dimensions == working.working_dimensions {
        return true;
    }
    let lhs = u128::from(dimensions.0) * u128::from(working.working_dimensions.1);
    let rhs = u128::from(dimensions.1) * u128::from(working.working_dimensions.0);
    let diff = lhs.abs_diff(rhs);
    diff * 1000 <= lhs.max(rhs) * 2
}

fn mask_pixel_coverage(mask_pixel: &image::Rgba<u8>) -> u8 {
    let [r, g, b, a] = mask_pixel.0;
    let luminance = (u32::from(r) * 54 + u32::from(g) * 183 + u32::from(b) * 19 + 128) / 256;
    ((luminance * u32::from(a) + 127) / 255) as u8
}

fn box_blur_coverage(coverage: &[u8], width: u32, height: u32, radius: u32) -> Vec<u8> {
    if radius == 0 {
        return coverage.to_vec();
    }
    let w = width as usize;
    let h = height as usize;
    let r = radius as usize;
    let mut horizontal = vec![0_u8; coverage.len()];
    for y in 0..h {
        let row = y * w;
        for x in 0..w {
            let x0 = x.saturating_sub(r);
            let x1 = (x + r).min(w - 1);
            let mut sum = 0_u32;
            for sx in x0..=x1 {
                sum += u32::from(coverage[row + sx]);
            }
            horizontal[row + x] = (sum / (x1 - x0 + 1) as u32) as u8;
        }
    }

    let mut out = vec![0_u8; coverage.len()];
    for y in 0..h {
        let y0 = y.saturating_sub(r);
        let y1 = (y + r).min(h - 1);
        for x in 0..w {
            let mut sum = 0_u32;
            for sy in y0..=y1 {
                sum += u32::from(horizontal[sy * w + x]);
            }
            out[y * w + x] = (sum / (y1 - y0 + 1) as u32) as u8;
        }
    }
    out
}

fn ai_retouch_editable_mask_png(
    source_png: &[u8],
    mask_png: &[u8],
    grow_radius: u32,
    feather_radius: u32,
) -> Result<Vec<u8>, String> {
    let source_dimensions = png_dimensions_from_bytes(source_png)
        .ok_or_else(|| "AI retouch source PNG dimensions are invalid.".to_string())?;
    let mask = decode_png_rgba(mask_png, "AI retouch mask")?;
    if mask.dimensions() != source_dimensions {
        return Err(format!(
            "AI retouch mask must match source dimensions. Source is {}x{}, mask is {}x{}.",
            source_dimensions.0,
            source_dimensions.1,
            mask.width(),
            mask.height()
        ));
    }

    let width = source_dimensions.0;
    let height = source_dimensions.1;
    let mut original = vec![0_u8; (width * height) as usize];
    let mut covered = Vec::new();
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) as usize;
            let coverage = mask_pixel_coverage(mask.get_pixel(x, y));
            original[i] = coverage;
            if coverage > 0 {
                covered.push((x, y, coverage));
            }
        }
    }

    let mut grown = original.clone();
    let radius_sq = grow_radius.saturating_mul(grow_radius);
    for (x, y, coverage) in covered {
        let x0 = x.saturating_sub(grow_radius);
        let y0 = y.saturating_sub(grow_radius);
        let x1 = (x + grow_radius).min(width - 1);
        let y1 = (y + grow_radius).min(height - 1);
        for yy in y0..=y1 {
            let dy = yy.abs_diff(y);
            for xx in x0..=x1 {
                let dx = xx.abs_diff(x);
                if dx.saturating_mul(dx) + dy.saturating_mul(dy) > radius_sq {
                    continue;
                }
                let i = (yy * width + xx) as usize;
                grown[i] = grown[i].max(coverage);
            }
        }
    }

    let blurred = box_blur_coverage(&grown, width, height, feather_radius);
    let mut out = image::RgbaImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) as usize;
            let coverage = blurred[i].max(original[i]);
            out.put_pixel(x, y, image::Rgba([255, 255, 255, coverage]));
        }
    }

    encode_rgba_png(out, "AI retouch editable mask")
}

fn file_has_png_signature(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut signature = [0_u8; 8];
    file.read_exact(&mut signature).is_ok() && signature == *PNG_SIGNATURE
}

fn required_png_output_state(path: &Path) -> Option<(u64, Option<SystemTime>)> {
    let metadata = path.metadata().ok()?;
    if !metadata.is_file() || metadata.len() < PNG_SIGNATURE.len() as u64 {
        return None;
    }
    if !file_has_png_signature(path) {
        return None;
    }
    Some((metadata.len(), metadata.modified().ok()))
}

fn required_png_output_is_ready(
    job_path: &Path,
    required_output: &str,
    snapshot: &mut Option<(u64, Option<SystemTime>, Instant)>,
) -> bool {
    let Some((len, modified)) = required_png_output_state(&job_path.join(required_output)) else {
        *snapshot = None;
        return false;
    };

    if let Some(modified) = modified {
        if SystemTime::now()
            .duration_since(modified)
            .is_ok_and(|age| age >= Duration::from_millis(1000))
        {
            return true;
        }
    }

    match snapshot {
        Some((last_len, last_modified, since))
            if *last_len == len && *last_modified == modified =>
        {
            since.elapsed() >= Duration::from_millis(1000)
        }
        _ => {
            *snapshot = Some((len, modified, Instant::now()));
            false
        }
    }
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

#[derive(Clone, Debug)]
struct CodexCachedPng {
    modified: SystemTime,
    path: PathBuf,
}

fn find_pngs_since(root: &Path, result_path: &Path, since: SystemTime) -> Vec<CodexCachedPng> {
    let cutoff = since.checked_sub(Duration::from_secs(3)).unwrap_or(since);
    let mut matches = Vec::new();
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
                if path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name == "inputs")
                {
                    continue;
                }
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
            matches.push(CodexCachedPng { modified, path });
        }
    }

    matches.sort_by(|a, b| {
        a.modified
            .cmp(&b.modified)
            .then_with(|| a.path.cmp(&b.path))
    });
    matches
}

fn find_newest_png_since(root: &Path, result_path: &Path, since: SystemTime) -> Option<PathBuf> {
    find_pngs_since(root, result_path, since)
        .into_iter()
        .last()
        .map(|candidate| candidate.path)
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

fn find_codex_cached_pngs_in_roots<I>(
    roots: I,
    thread_id: Option<&str>,
    since: SystemTime,
    result_path: &Path,
) -> Vec<PathBuf>
where
    I: IntoIterator<Item = PathBuf>,
{
    let Some(thread_id) = thread_id.map(str::trim) else {
        return Vec::new();
    };
    if thread_id.is_empty()
        || thread_id.contains('/')
        || thread_id.contains('\\')
        || thread_id.contains("..")
    {
        return Vec::new();
    }

    let mut matches = Vec::new();
    for root in roots {
        let thread_root = root.join(thread_id);
        matches.extend(find_pngs_since(&thread_root, result_path, since));
    }
    matches.sort_by(|a, b| {
        a.modified
            .cmp(&b.modified)
            .then_with(|| a.path.cmp(&b.path))
    });
    matches
        .into_iter()
        .map(|candidate| candidate.path)
        .collect()
}

fn png_file_looks_stable(path: &Path) -> bool {
    let Ok(first) = fs::metadata(path) else {
        return false;
    };
    thread::sleep(Duration::from_millis(250));
    let Ok(second) = fs::metadata(path) else {
        return false;
    };
    first.len() == second.len() && file_has_png_signature(path) && png_dimensions(path).is_ok()
}

fn find_ready_codex_cached_png(
    thread_id: Option<&str>,
    since: SystemTime,
    working: &AiWorkingCanvas,
) -> Option<PathBuf> {
    let exclude_path = Path::new("__paintnode-result-placeholder.png");
    let candidates = find_codex_cached_pngs_in_roots(
        codex_generated_images_roots(),
        thread_id,
        since,
        exclude_path,
    );
    candidates.into_iter().rev().find(|candidate| {
        png_dimensions(candidate).ok().is_some_and(|dimensions| {
            ai_working_canvas_accepts_result_dimensions(working, dimensions)
        }) && png_file_looks_stable(candidate)
    })
}

fn unique_child_path(dir: &Path, file_name: &str) -> PathBuf {
    let safe_name =
        safe_file_name(file_name).unwrap_or_else(|| format!("codex-generated-{}.png", now_id()));
    let first = dir.join(&safe_name);
    if !first.exists() {
        return first;
    }

    let path = Path::new(&safe_name);
    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .map(safe_stem)
        .unwrap_or_else(|| "codex-generated".into());
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("png");
    for index in 2..1000 {
        let candidate = dir.join(format!("{stem}-{index}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    dir.join(format!("{stem}-{}.{}", now_id(), ext))
}

fn copy_codex_cached_png_in_roots_to_job<I>(
    roots: I,
    job_path: &Path,
    thread_id: Option<&str>,
    since: SystemTime,
) -> Result<Option<(PathBuf, PathBuf)>, String>
where
    I: IntoIterator<Item = PathBuf>,
{
    let generated_dir = job_path.join("generated");
    let exclude_path = generated_dir.join("__paintnode-result-placeholder.png");
    let Some(candidate) = find_codex_cached_png_in_roots(roots, thread_id, since, &exclude_path)
    else {
        return Ok(None);
    };

    fs::create_dir_all(&generated_dir)
        .map_err(|e| format!("Failed to create Codex generated image staging folder: {e}"))?;
    let candidate_name = candidate
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("codex-generated.png");
    let staged_path = unique_child_path(&generated_dir, candidate_name);
    if !copy_png_candidate(&candidate, &staged_path) {
        return Err(format!(
            "Failed to copy Codex generated image from {} to {}.",
            candidate.display(),
            staged_path.display()
        ));
    }
    Ok(Some((candidate, staged_path)))
}

fn copy_codex_cached_pngs_in_roots_to_job<I>(
    roots: I,
    job_path: &Path,
    thread_id: Option<&str>,
    since: SystemTime,
) -> Result<Vec<(PathBuf, PathBuf)>, String>
where
    I: IntoIterator<Item = PathBuf>,
{
    let generated_dir = job_path.join("generated");
    let exclude_path = generated_dir.join("__paintnode-result-placeholder.png");
    let candidates = find_codex_cached_pngs_in_roots(roots, thread_id, since, &exclude_path);
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    fs::create_dir_all(&generated_dir)
        .map_err(|e| format!("Failed to create Codex generated image staging folder: {e}"))?;

    let mut copied = Vec::new();
    for candidate in candidates {
        let candidate_name = candidate
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("codex-generated.png");
        let staged_path = unique_child_path(&generated_dir, candidate_name);
        if !copy_png_candidate(&candidate, &staged_path) {
            return Err(format!(
                "Failed to copy Codex generated image from {} to {}.",
                candidate.display(),
                staged_path.display()
            ));
        }
        copied.push((candidate, staged_path));
    }
    Ok(copied)
}

fn copy_codex_cached_pngs_to_job(
    job_path: &Path,
    thread_id: Option<&str>,
    since: SystemTime,
) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    copy_codex_cached_pngs_in_roots_to_job(
        codex_generated_images_roots(),
        job_path,
        thread_id,
        since,
    )
}

fn copy_codex_cached_png_to_job(
    job_path: &Path,
    thread_id: Option<&str>,
    since: SystemTime,
) -> Result<Option<(PathBuf, PathBuf)>, String> {
    copy_codex_cached_png_in_roots_to_job(
        codex_generated_images_roots(),
        job_path,
        thread_id,
        since,
    )
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

fn provider_progress_message(line: &str, is_stderr: bool, provider_label: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) {
        let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let item_type = json_string_at(&value, &["item", "type"]).unwrap_or("");
        let combined = format!("{event_type} {item_type} {}", value).to_ascii_lowercase();

        if event_type.contains("thread.started") {
            return Some(format!("{provider_label} session started"));
        }
        if event_type.contains("turn.started") {
            return Some(format!("{provider_label} is working on the image"));
        }
        if event_type.contains("turn.completed") {
            return Some(format!(
                "{provider_label} finished; checking generated output"
            ));
        }
        if event_type.contains("error") {
            let message = json_string_at(&value, &["message"])
                .or_else(|| json_string_at(&value, &["error", "message"]))
                .and_then(sanitize_progress_line)
                .unwrap_or_else(|| format!("{provider_label} reported an error"));
            return Some(message);
        }
        if event_type.contains("item.started") {
            if combined.contains("imagegen") || combined.contains("image_generation") {
                return Some(format!("Generating image with {provider_label}"));
            }
            if combined.contains("tool") || combined.contains("function") {
                return Some(format!("{provider_label} is using a local tool"));
            }
            return Some(format!("{provider_label} is processing the prompt"));
        }
        if event_type.contains("item.completed") {
            if combined.contains("imagegen") || combined.contains("image_generation") {
                return Some(format!(
                    "Image generation step completed; waiting for {provider_label}"
                ));
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
                        return Some(format!("{provider_label} is preparing image generation"));
                    }
                    return Some(format!("{provider_label}: {message}"));
                }
                return Some(format!("{provider_label} is continuing image generation"));
            }
        }
        return None;
    }

    let text = sanitize_progress_line(trimmed)?;
    let lower = text.to_ascii_lowercase();
    let provider_lower = provider_label.to_ascii_lowercase();
    if is_stderr
        || lower.contains(&provider_lower)
        || lower.contains("codex")
        || lower.contains("antigravity")
        || lower.contains("agy")
        || lower.contains("thinking")
        || lower.contains("processing")
        || lower.contains("waiting")
        || lower.contains("generating")
        || lower.contains("created")
        || lower.contains("saved")
        || lower.contains("image")
        || lower.contains("result.png")
        || lower.contains("timeout")
        || lower.contains("error")
    {
        Some(text)
    } else {
        None
    }
}

fn watched_job_files(job_path: &Path) -> HashMap<String, Option<SystemTime>> {
    let mut files = HashMap::new();
    let Ok(entries) = fs::read_dir(job_path) else {
        return files;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let lower = file_name.to_ascii_lowercase();
        if !(lower.ends_with(".png") || lower.ends_with(".json") || lower.ends_with(".txt")) {
            continue;
        }
        let modified = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok());
        files.insert(file_name.to_string(), modified);
    }
    files
}

fn job_file_progress_message(
    provider_label: &str,
    file_name: &str,
    required_output: Option<&str>,
) -> String {
    if required_output == Some(file_name) {
        return format!("{provider_label} wrote {file_name}; waiting for the CLI to finish");
    }
    if file_name.ends_with(".png") {
        if required_output
            .is_some_and(|required| file_name.starts_with("result") && file_name != required)
        {
            return format!(
                "{provider_label} wrote {file_name}; still waiting for required {required}",
                required = required_output.unwrap()
            );
        }
        return format!("{provider_label} wrote image candidate: {file_name}");
    }
    format!("{provider_label} updated {file_name}")
}

fn emit_job_file_progress(
    app: &AppHandle,
    run_id: &str,
    provider_label: &str,
    job_path: &Path,
    snapshot: &mut HashMap<String, Option<SystemTime>>,
    required_output: Option<&str>,
) {
    let current = watched_job_files(job_path);
    let mut changes = current
        .iter()
        .filter(|(name, modified)| snapshot.get(*name) != Some(*modified))
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    changes.sort();
    for file_name in changes {
        emit_codex_progress(
            app,
            run_id,
            job_file_progress_message(provider_label, &file_name, required_output),
        );
    }
    *snapshot = current;
}

fn antigravity_brain_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".gemini/antigravity-cli/brain"))
}

fn path_contains_text(path: &Path, needle: &str) -> bool {
    let Ok(text) = fs::read_to_string(path) else {
        return false;
    };
    text.contains(needle)
}

fn find_antigravity_transcript(job_path: &Path, workspace_path: &Path) -> Option<PathBuf> {
    let brain_dir = antigravity_brain_dir()?;
    let job_abs = job_path.to_string_lossy().replace('\\', "/");
    let job_rel = job_path
        .strip_prefix(workspace_path)
        .ok()
        .map(|path| path.to_string_lossy().replace('\\', "/"));
    let job_name = job_path.file_name()?.to_string_lossy().to_string();

    let mut candidates = Vec::new();
    let entries = fs::read_dir(brain_dir).ok()?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let transcript = dir.join(".system_generated/logs/transcript.jsonl");
        let full_transcript = dir.join(".system_generated/logs/transcript_full.jsonl");
        for path in [transcript, full_transcript] {
            if let Ok(metadata) = path.metadata() {
                let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                candidates.push((modified, path));
            }
        }
    }
    candidates.sort_by_key(|(modified, _)| *modified);
    candidates.reverse();

    for (_, path) in candidates {
        if path_contains_text(&path, &job_abs)
            || job_rel
                .as_deref()
                .is_some_and(|relative| path_contains_text(&path, relative))
            || path_contains_text(&path, &job_name)
        {
            return Some(path);
        }
    }
    None
}

fn json_text(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .and_then(sanitize_progress_line)
}

fn tool_action_message(tool_call: &serde_json::Value) -> Option<String> {
    let args = tool_call.get("args")?;
    json_text(args, "toolAction")
        .or_else(|| json_text(args, "toolSummary"))
        .map(|action| format!("Antigravity: {action}"))
}

fn antigravity_transcript_messages(line: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return Vec::new();
    };
    let source = value.get("source").and_then(|v| v.as_str()).unwrap_or("");
    let entry_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let status = value.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if source != "MODEL" || status != "DONE" {
        return Vec::new();
    }

    if entry_type == "PLANNER_RESPONSE" {
        return value
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .map(|calls| calls.iter().filter_map(tool_action_message).collect())
            .unwrap_or_default();
    }

    match entry_type {
        "GENERATE_IMAGE" => vec!["Antigravity completed image generation".into()],
        "RUN_COMMAND" => vec!["Antigravity completed a local processing step".into()],
        "VIEW_FILE" => vec!["Antigravity inspected an output image".into()],
        "LIST_DIRECTORY" => vec!["Antigravity inspected the job folder".into()],
        _ => Vec::new(),
    }
}

fn emit_antigravity_transcript_progress(
    app: &AppHandle,
    run_id: &str,
    transcript_path: &Path,
    offset: &mut u64,
) {
    let Ok(mut file) = fs::File::open(transcript_path) else {
        return;
    };
    if file.seek(std::io::SeekFrom::Start(*offset)).is_err() {
        return;
    }
    let mut text = String::new();
    if file.read_to_string(&mut text).is_err() {
        return;
    }
    *offset += text.as_bytes().len() as u64;
    for line in text.lines() {
        for message in antigravity_transcript_messages(line) {
            emit_codex_progress(app, run_id, message);
        }
    }
}

fn generated_job_outputs(job_path: &Path, required_output: &str) -> Vec<String> {
    let mut outputs = watched_job_files(job_path)
        .into_keys()
        .filter(|name| {
            let lower = name.to_ascii_lowercase();
            name != required_output
                && lower.ends_with(".png")
                && !matches!(
                    lower.as_str(),
                    "source.png" | "edit_target.png" | "mask.png"
                )
        })
        .collect::<Vec<_>>();
    outputs.sort();
    outputs
}

fn command_failure_with_required_output(
    prefix: &str,
    output: &Output,
    job_path: &Path,
    required_output: &str,
) -> String {
    let mut message = command_failure(prefix, output);
    if !job_path.join(required_output).exists() {
        let outputs = generated_job_outputs(job_path, required_output);
        if !outputs.is_empty() {
            message.push_str(&format!(
                "\n\nAntigravity created {}, but PaintNode still needs `{required_output}`.",
                outputs.join(", ")
            ));
        }
    }
    message
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
    thread_id: Arc<Mutex<Option<String>>>,
    provider_label: String,
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
                    if let Some(message) =
                        provider_progress_message(&text, is_stderr, &provider_label)
                    {
                        emit_codex_progress(&app, &run_id, message);
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
            Arc::clone(&thread_id),
            "Codex".into(),
        ));
    }
    if let Some(stream) = child.stderr.take() {
        readers.push(spawn_output_reader(
            stream,
            Arc::clone(&stderr),
            app.clone(),
            run_id.clone(),
            true,
            Arc::clone(&thread_id),
            "Codex".into(),
        ));
    }

    let start = Instant::now();
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("Failed to wait for command: {e}"))?
        {
            break status;
        }

        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Generation timed out. Codex may still be busy, or the local command may be waiting for input.".into());
        }

        thread::sleep(POLL_INTERVAL);
    };

    for reader in readers {
        let _ = reader.join();
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
        thread_id,
        satisfied_required_output: false,
    })
}

fn run_antigravity_with_progress(
    command: &mut Command,
    timeout: Duration,
    app: AppHandle,
    run_id: String,
    workspace_path: &Path,
    job_path: &Path,
    required_output: Option<&str>,
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
            Arc::clone(&thread_id),
            "Antigravity".into(),
        ));
    }
    if let Some(stream) = child.stderr.take() {
        readers.push(spawn_output_reader(
            stream,
            Arc::clone(&stderr),
            app.clone(),
            run_id.clone(),
            true,
            Arc::clone(&thread_id),
            "Antigravity".into(),
        ));
    }

    let start = Instant::now();
    let mut last_file_poll = Instant::now();
    let mut file_snapshot = watched_job_files(job_path);
    let mut transcript_path = None::<PathBuf>;
    let mut transcript_offset = 0_u64;
    let mut last_transcript_poll = Instant::now();
    let mut required_output_snapshot = None::<(u64, Option<SystemTime>, Instant)>;
    let (status, satisfied_required_output) = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("Failed to wait for command: {e}"))?
        {
            emit_job_file_progress(
                &app,
                &run_id,
                "Antigravity",
                job_path,
                &mut file_snapshot,
                required_output,
            );
            if transcript_path.is_none() {
                transcript_path = find_antigravity_transcript(job_path, workspace_path);
            }
            if let Some(path) = transcript_path.as_deref() {
                emit_antigravity_transcript_progress(&app, &run_id, path, &mut transcript_offset);
            }
            break (status, false);
        }

        if last_file_poll.elapsed() >= Duration::from_millis(1000) {
            emit_job_file_progress(
                &app,
                &run_id,
                "Antigravity",
                job_path,
                &mut file_snapshot,
                required_output,
            );
            last_file_poll = Instant::now();
        }

        if last_transcript_poll.elapsed() >= Duration::from_millis(1000) {
            if transcript_path.is_none() {
                transcript_path = find_antigravity_transcript(job_path, workspace_path);
                if transcript_path.is_some() {
                    emit_codex_progress(&app, &run_id, "Antigravity session transcript found");
                }
            }
            if let Some(path) = transcript_path.as_deref() {
                emit_antigravity_transcript_progress(&app, &run_id, path, &mut transcript_offset);
            }
            last_transcript_poll = Instant::now();
        }

        if let Some(required_output) = required_output {
            if required_png_output_is_ready(
                job_path,
                required_output,
                &mut required_output_snapshot,
            ) {
                emit_codex_progress(
                    &app,
                    &run_id,
                    &format!(
                        "Antigravity wrote {required_output}; applying PaintNode post-processing"
                    ),
                );
                let _ = child.kill();
                let status = child.wait().map_err(|e| {
                    format!("Failed to stop Antigravity after output was ready: {e}")
                })?;
                break (status, true);
            }
        }

        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Generation timed out. The local command may still be busy, or it may be waiting for input.".into());
        }

        thread::sleep(POLL_INTERVAL);
    };

    for reader in readers {
        let _ = reader.join();
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
        thread_id,
        satisfied_required_output,
    })
}

fn run_codex_with_progress_until_cached_png(
    command: &mut Command,
    timeout: Duration,
    app: AppHandle,
    run_id: String,
    cache_since: SystemTime,
    working: &AiWorkingCanvas,
) -> Result<CodexImageRunResult, String> {
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
            Arc::clone(&thread_id),
            "Codex".into(),
        ));
    }
    if let Some(stream) = child.stderr.take() {
        readers.push(spawn_output_reader(
            stream,
            Arc::clone(&stderr),
            app.clone(),
            run_id.clone(),
            true,
            Arc::clone(&thread_id),
            "Codex".into(),
        ));
    }

    let start = Instant::now();
    let mut image_cached_before_exit = false;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("Failed to wait for command: {e}"))?
        {
            break status;
        }

        let current_thread_id = thread_id.lock().ok().and_then(|id| id.clone());
        if find_ready_codex_cached_png(current_thread_id.as_deref(), cache_since, working).is_some()
        {
            image_cached_before_exit = true;
            emit_codex_progress(
                &app,
                &run_id,
                "Codex image generated; normalizing PaintNode retouch result",
            );
            let _ = child.kill();
            break child
                .wait()
                .map_err(|e| format!("Failed to stop Codex after image generation: {e}"))?;
        }

        if start.elapsed() >= timeout {
            let current_thread_id = thread_id.lock().ok().and_then(|id| id.clone());
            if find_ready_codex_cached_png(current_thread_id.as_deref(), cache_since, working)
                .is_some()
            {
                image_cached_before_exit = true;
                emit_codex_progress(
                    &app,
                    &run_id,
                    "Codex timed out after image generation; normalizing PaintNode retouch result",
                );
                let _ = child.kill();
                break child
                    .wait()
                    .map_err(|e| format!("Failed to stop Codex after image generation: {e}"))?;
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err("Generation timed out. Codex may still be busy, or the local command may be waiting for input.".into());
        }

        thread::sleep(POLL_INTERVAL);
    };

    for reader in readers {
        let _ = reader.join();
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

    Ok(CodexImageRunResult {
        run: CodexRunResult {
            output: Output {
                status,
                stdout,
                stderr,
            },
            thread_id,
            satisfied_required_output: false,
        },
        image_cached_before_exit,
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

fn clean_codex_option(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn ai_autonomy_level(value: Option<String>) -> AiAutonomyLevel {
    match clean_codex_option(value).as_deref() {
        Some("guided") => AiAutonomyLevel::Guided,
        Some("open") => AiAutonomyLevel::Open,
        Some("unmanaged") => AiAutonomyLevel::Unmanaged,
        _ => AiAutonomyLevel::Low,
    }
}

fn image_agent_autonomy_contract(level: AiAutonomyLevel, _provider: &str) -> &'static str {
    match level {
        AiAutonomyLevel::Low => {
            "Autonomy level: Low. Use the image-generation capability for visual synthesis only. Do not write or run Python, shell, OpenCV, Pillow, ORB/homography, alignment, comparison-image, or custom verification tools. Do not search the workspace for helper scripts. PaintNode owns deterministic resizing, masking, protected-pixel restoration, alpha/key processing, validation, and import."
        }
        AiAutonomyLevel::Guided => {
            "Autonomy level: Guided. Prefer image generation only. You may do only simple file moves/copies or manifest/dimension inspection when explicitly needed to satisfy the required output file contract. Do not build image-processing pipelines, alignment tools, OpenCV/Pillow scripts, ORB/homography checks, or comparison-image workflows; PaintNode owns deterministic post-processing."
        }
        AiAutonomyLevel::Open => {
            "Autonomy level: Open. You may use simple local tools when useful, but keep generated image synthesis as the main task and avoid unnecessary tool-building. PaintNode still owns final deterministic import and protected-pixel restoration."
        }
        AiAutonomyLevel::Unmanaged => {
            "Autonomy level: Unmanaged. Use your available image-generation capability or provider tools to produce the requested image. PaintNode does not constrain the intermediate workflow beyond producing the required output."
        }
    }
}

fn codex_command_options(
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
) -> CodexCommandOptions {
    CodexCommandOptions {
        model: clean_codex_option(model),
        reasoning_effort: clean_codex_option(reasoning_effort),
        service_tier: clean_codex_option(service_tier),
    }
}

fn apply_codex_command_options(command: &mut Command, options: &CodexCommandOptions) {
    if let Some(model) = options.model.as_deref() {
        command.arg("-m").arg(model);
    }
    if let Some(reasoning_effort) = options.reasoning_effort.as_deref() {
        command
            .arg("-c")
            .arg(format!("model_reasoning_effort=\"{reasoning_effort}\""));
    }
    if matches!(options.service_tier.as_deref(), Some("fast")) {
        command
            .arg("-c")
            .arg("service_tier=\"fast\"")
            .arg("-c")
            .arg("features.fast_mode=true");
    }
}

fn configured_or_default_antigravity_bin(bin: Option<String>) -> Result<String, String> {
    if let Some(bin) = bin.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        return Ok(bin);
    }

    let mut candidates = vec!["agy".to_string()];
    if let Ok(home) = std::env::var("HOME") {
        candidates.push(format!("{home}/.local/bin/agy"));
    }
    candidates.extend([
        "/opt/homebrew/bin/agy".to_string(),
        "/usr/local/bin/agy".to_string(),
    ]);
    for candidate in candidates {
        if Command::new(&candidate).arg("--version").output().is_ok() {
            return Ok(candidate.to_string());
        }
    }

    Err("Antigravity CLI was not found. Install Antigravity CLI, or enter the full path to the `agy` binary.".into())
}

fn antigravity_command_options(
    model: Option<String>,
    approval_mode: Option<String>,
) -> AntigravityCommandOptions {
    let model = clean_codex_option(model).filter(|value| value != "auto");
    let approval_mode = clean_codex_option(approval_mode);
    AntigravityCommandOptions {
        model,
        approval_mode,
    }
}

fn apply_antigravity_command_options(command: &mut Command, options: &AntigravityCommandOptions) {
    if matches!(options.approval_mode.as_deref(), Some("skipPermissions")) {
        command.arg("--dangerously-skip-permissions");
    }
    if let Some(model) = options.model.as_deref() {
        command.arg("--model").arg(model);
    }
}

fn build_antigravity_command(
    antigravity_bin: &str,
    workspace_path: &Path,
    job_path: &Path,
    prompt: &str,
    options: &AntigravityCommandOptions,
    new_project: bool,
    _json_progress: bool,
) -> Command {
    let mut command = Command::new(antigravity_bin);
    command.current_dir(workspace_path);
    apply_antigravity_command_options(&mut command, options);
    if new_project {
        command.arg("--new-project");
    }
    command.arg("--add-dir").arg(job_path);
    command.arg("-p").arg(prompt.trim());
    command
}

fn antigravity_job_dir_label(workspace_path: &Path, job_path: &Path) -> String {
    if workspace_path == job_path {
        ".".into()
    } else if let Ok(relative) = job_path.strip_prefix(workspace_path) {
        relative.to_string_lossy().replace('\\', "/")
    } else {
        job_path.to_string_lossy().into_owned()
    }
}

fn antigravity_result_path(job_dir: &str) -> String {
    if job_dir == "." {
        "result.png".into()
    } else {
        format!("{job_dir}/result.png")
    }
}

fn ai_working_canvas_instruction(working: &AiWorkingCanvas) -> String {
    let rect = working.content_rect;
    let padding_note = if working.has_padding() {
        let left_padding = rect.x;
        let top_padding = rect.y;
        let right_padding = working
            .working_dimensions
            .0
            .saturating_sub(rect.x + rect.width);
        let bottom_padding = working
            .working_dimensions
            .1
            .saturating_sub(rect.y + rect.height);
        format!(
            r#"Chroma-key padding:
- Keep the final PNG exactly {working_width}x{working_height}.
- The document rectangle is x={x}, y={y}, width={content_width}, height={content_height}.
- Keep the padding dimensions unchanged: left={left_padding}px, top={top_padding}px, right={right_padding}px, bottom={bottom_padding}px.
- Pixels outside the document rectangle are a flat PaintNode chroma-key matte: {chroma_key}.
- This matte is not a green-screen/key-removal request. Do not remove it or make it transparent.
- Keep every matte pixel exactly {chroma_key}; do not crop, resize, alpha-out, recolor, blur, shade, texture, extend, or paint scene content into the matte.
- Only generate or edit pixels inside the document rectangle."#,
            working_width = working.working_dimensions.0,
            working_height = working.working_dimensions.1,
            x = rect.x,
            y = rect.y,
            content_width = rect.width,
            content_height = rect.height,
            left_padding = left_padding,
            top_padding = top_padding,
            right_padding = right_padding,
            bottom_padding = bottom_padding,
            chroma_key = AI_CHROMA_KEY_HEX
        )
    } else {
        "The document rectangle fills the working PNG.".into()
    };
    format!(
        r#"PaintNode image geometry:
- Working PNG: {working_width}x{working_height}.
- Document rectangle: x={x}, y={y}, width={content_width}, height={content_height}.
{padding_note}
- Keep the document rectangle in the same position and size."#,
        working_width = working.working_dimensions.0,
        working_height = working.working_dimensions.1,
        x = rect.x,
        y = rect.y,
        content_width = rect.width,
        content_height = rect.height,
        padding_note = padding_note
    )
}

fn antigravity_generate_prompt(
    user_prompt: &str,
    job_dir: &str,
    autonomy: AiAutonomyLevel,
    _working: Option<&AiWorkingCanvas>,
    reference_names: &[String],
) -> String {
    let result_path = antigravity_result_path(job_dir);
    let autonomy_contract = image_agent_autonomy_contract(autonomy, "Antigravity");
    let workspace_rule = if autonomy == AiAutonomyLevel::Unmanaged {
        "- Save the final image at the required path so PaintNode can import it.".into()
    } else {
        format!(
            "- Work only inside the PaintNode AI job directory `{job_dir}`.\n- Do not edit files outside the PaintNode AI job directory."
        )
    };
    let reference_prefix = if job_dir == "." {
        String::new()
    } else {
        format!("{job_dir}/")
    };
    let reference_note = reference_prompt_note(reference_names, &reference_prefix);
    format!(
        r#"Generate one raster PNG for PaintNode.

User image prompt:
{user_prompt}

{reference_note}

{autonomy_contract}

Required output:
- Save the final image as `{result_path}`.
- PNG only.
- Do not ask follow-up questions.
{workspace_rule}

Final response should be one short sentence confirming `{result_path}` was created."#
    )
}

fn antigravity_fill_prompt(
    prompt: &str,
    job_dir: &str,
    autonomy: AiAutonomyLevel,
    working: &AiWorkingCanvas,
    reference_names: &[String],
) -> String {
    let result_path = antigravity_result_path(job_dir);
    let autonomy_contract = image_agent_autonomy_contract(autonomy, "Antigravity");
    let working_instruction = ai_working_canvas_instruction(working);
    let workspace_rule = if autonomy == AiAutonomyLevel::Unmanaged {
        "- Save the final image at the required path so PaintNode can import it.".into()
    } else {
        format!("- Work only inside `{job_dir}`.")
    };
    let reference_prefix = if job_dir == "." {
        String::new()
    } else {
        format!("{job_dir}/")
    };
    let reference_note = reference_prompt_note(reference_names, &reference_prefix);
    format!(
        r#"Perform one mask-guided PaintNode generative fill using the PNG files in `{job_dir}`.

Input files:
- `{job_dir}/source.png`: source PNG with the document centered inside it. Pixels outside the document rectangle are the PaintNode chroma-key matte `{chroma_key}`.
- `{job_dir}/edit_target.png`: same-size image to edit in place.
- `{job_dir}/mask.png`: same-size edit mask. White pixels are editable. Gray pixels are a feathered transition buffer. Black or transparent pixels are protected context and are not editable.

{reference_note}

{working_instruction}

User fill prompt:
{prompt}

{autonomy_contract}

Required output:
- Save exactly one PNG file as `{result_path}`.
- Prefer the same pixel dimensions as `source.png`, `edit_target.png`, and `mask.png`.
- Change only the white-mask area and keep black/transparent-mask context visually preserved.
- Match surrounding texture, lighting, perspective, color, focus, and grain.
- Do not crop, zoom, reframe, or shift the centered content rectangle.
{workspace_rule}
- Do not ask follow-up questions.

Final response should be one short sentence confirming `{result_path}` was created."#,
        chroma_key = AI_CHROMA_KEY_HEX
    )
}

fn antigravity_retouch_prompt(
    prompt: &str,
    has_annotated_source: bool,
    has_reference: bool,
    reference_names: &[String],
    job_dir: &str,
    autonomy: AiAutonomyLevel,
    working: &AiWorkingCanvas,
) -> String {
    let annotation_note = if has_annotated_source {
        format!("- `{job_dir}/annotated_source.png`: optional guide image with PaintNode callouts. Use it only to locate the requested edit.")
    } else {
        "- No annotated source guide is present.".into()
    };
    let reference_note = if has_reference {
        format!("- `{job_dir}/reference.png`: optional sampled reference area. Use it as visual guidance, not as pasted content unless the user explicitly requests copying.")
    } else {
        "- No sampled reference image is present.".into()
    };
    let reference_prefix = if job_dir == "." {
        String::new()
    } else {
        format!("{job_dir}/")
    };
    let extra_reference_note = reference_prompt_note(reference_names, &reference_prefix);
    let result_path = antigravity_result_path(job_dir);
    let autonomy_contract = image_agent_autonomy_contract(autonomy, "Antigravity");
    let working_instruction = ai_working_canvas_instruction(working);
    let contract_note = if autonomy == AiAutonomyLevel::Unmanaged {
        format!(
            "- `{job_dir}/paintnode_contract.txt`: deterministic PaintNode post-processing notes."
        )
    } else {
        format!(
            "- `{job_dir}/paintnode_contract.txt`: deterministic PaintNode post-processing contract."
        )
    };
    let workspace_rule = if autonomy == AiAutonomyLevel::Unmanaged {
        "- Save the final image at the required path so PaintNode can import it.".into()
    } else {
        format!("- Work only inside `{job_dir}`.")
    };
    format!(
        r#"Perform one PaintNode AI retouch using the PNG files in `{job_dir}`.

Input files:
- `{job_dir}/source.png`: source PNG with the document centered inside it. Pixels outside the document rectangle are the PaintNode chroma-key matte `{chroma_key}`.
- `{job_dir}/edit_target.png`: same-size photo/canvas image to edit in place.
- `{job_dir}/mask.png`: same-size edit mask. White pixels are editable. Gray pixels are a feathered transition buffer. Black or transparent pixels are protected context and are not editable.
{contract_note}
{annotation_note}
{reference_note}
{extra_reference_note}

{working_instruction}

User retouch prompt:
{prompt}

{autonomy_contract}

Required output:
- Save exactly one PNG file as `{result_path}`.
- Prefer the same pixel dimensions as `source.png` and `edit_target.png`.
- Treat the edit as an in-place retouch of the centered content rectangle; do not crop, zoom, reframe, or shift that rectangle.
- Treat `mask.png` as the maximum allowed edit area, not as an instruction to repaint every white pixel. Change only the content explicitly requested by the user prompt and preserve unrequested masked content.
- Keep every newly generated, removed, replaced, reconstructed, relit, recolored, cleaned, extended, blended, shadowed, reflected, or otherwise changed visible pixel inside the white/gray mask footprint.
- Any edit whose visible change extends outside the mask is a failed retouch, even if PaintNode later restores protected pixels. Scale, simplify, or localize the requested change so the complete visible edit fits inside the mask footprint.
- If the prompt changes clothing or accessories, preserve the person's identity, face, hair, skin, hands, pose, body proportions, expression, gaze, and all unrequested surrounding content unless the user explicitly asks to alter those details.
- Blend naturally through any gray feather buffer. PaintNode will apply the mask afterward, but your candidate should still preserve protected and unrequested areas.
- Keep every black/transparent-mask protected area visually identical to `source.png`: no enhancement, denoise, sharpening, relight, recolor, cleanup, straightening, or reframing outside the mask.
- Use surrounding texture, lighting, perspective, grain, focus, and edges to blend the retouched area naturally.
- Do not include UI chrome, checkerboard transparency, selection outlines, masks, annotations, labels, or guide marks in `result.png`.
{workspace_rule}
- Do not ask follow-up questions.

Final response should be one short sentence confirming `{result_path}` was created."#,
        chroma_key = AI_CHROMA_KEY_HEX
    )
}

fn antigravity_retouch_contract_text(
    job_dir: &str,
    autonomy: AiAutonomyLevel,
    working: &AiWorkingCanvas,
) -> String {
    let result_path = antigravity_result_path(job_dir);
    let working_instruction = ai_working_canvas_instruction(working);
    let method_limits = if autonomy == AiAutonomyLevel::Unmanaged {
        String::new()
    } else {
        format!(
            r#"
Do not do:
- Do not run Python, OpenCV, Pillow, ORB, homography, feature matching, or alignment scripts.
- Do not create comparison/debug images such as `comp_resize.png`, `comp_warp.png`, or similar.
- Do not inspect unrelated workspace files or search for custom scripts.
- Do not keep working after `{result_path}` has been written.
"#
        )
    };
    format!(
        r#"PaintNode deterministic AI retouch contract

Your only required output is `{result_path}`.

{working_instruction}

Antigravity should do:
- Use the image-generation capability to create one visual retouch candidate.
- Save or copy that generated PNG to `{result_path}`.
- Preserve the centered content rectangle geometry and masked-region intent as much as the image-generation tool allows.

PaintNode will do after `{result_path}` exists:
- Validate that the file is a PNG.
- Crop the centered content rectangle back to the exact source canvas dimensions if needed.
- If the image tool returned the same supported aspect ratio at another resolution, resize only that cropped content rectangle.
- Restore protected black-mask pixels from `source.png`.
- Blend gray feather-buffer mask pixels between generated and source pixels.
- Apply the editable mask as the linked retouch mask layer.
- Store the generated asset in the project.
{method_limits}
"#
    )
}

fn antigravity_decouple_prompt(prompt: &str, job_dir: &str) -> String {
    format!(
        r#"Extract reusable visual assets from `{job_dir}/source.png` for PaintNode.

User guidance:
{prompt}

Required output:
- Work only inside `{job_dir}`.
- Create `{job_dir}/manifest.json`.
- Create one PNG file per extracted layer/asset inside `{job_dir}`.
- If useful, create PNG alpha masks inside `{job_dir}`.
- The manifest must be JSON with a top-level `layers` array.
- Each layer must include `name` and `file`. Optional fields are `alphaMask`, `keyColor`, `x`, `y`, `opacity`, and `visible`.
- Use file names relative to `{job_dir}`, such as `asset-1.png`, not absolute paths.
- Do not ask follow-up questions.

Final response should be one short sentence confirming `manifest.json` and the PNG assets were created."#
    )
}

fn antigravity_workflow_prompt(
    prompt: &str,
    source_names: &[String],
    job_dir: &str,
    autonomy: AiAutonomyLevel,
) -> String {
    let result_path = antigravity_result_path(job_dir);
    let autonomy_contract = image_agent_autonomy_contract(autonomy, "Antigravity");
    let workspace_rule = if autonomy == AiAutonomyLevel::Unmanaged {
        "- Save the final image at the required path so PaintNode can import it.".into()
    } else {
        format!("- Work only inside `{job_dir}`.\n- Do not edit or delete the input files.")
    };
    let sources = source_names
        .iter()
        .enumerate()
        .map(|(index, name)| format!("{}. {}", index + 1, name))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"Compose one new PaintNode raster PNG from the workflow asset images in `{job_dir}/inputs/`.

Available source assets:
{sources}

User composition prompt:
{prompt}

{autonomy_contract}

Required output:
- Save exactly one final composed PNG as `{result_path}`.
- PNG only.
{workspace_rule}
- Do not ask follow-up questions.

Final response should be one short sentence confirming `{result_path}` was created."#
    )
}

fn codex_prompt(
    user_prompt: &str,
    autonomy: AiAutonomyLevel,
    _working: Option<&AiWorkingCanvas>,
    reference_names: &[String],
) -> String {
    let autonomy_contract = image_agent_autonomy_contract(autonomy, "Codex");
    let task_intro = "Use $imagegen to generate one raster PNG for PaintNode.";
    let managed_method_requirements = if autonomy == AiAutonomyLevel::Unmanaged {
        "- Use the normal Codex image-generation flow and keep the generated image in Codex's generated-images cache.\n"
    } else {
        "- Use the normal Codex image-generation flow and keep the generated image in Codex's generated-images cache.\n- Do not create, edit, or delete files in the working directory.\n"
    };
    let reference_note = reference_prompt_note(reference_names, "");
    format!(
        r#"{task_intro}

User image prompt:
{user_prompt}

{reference_note}

{autonomy_contract}

Requirements:
- Create exactly one image from the user prompt.
{managed_method_requirements}
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
    reference_paths: &[PathBuf],
    reference_names: &[String],
    options: &CodexCommandOptions,
    autonomy: AiAutonomyLevel,
    working: Option<&AiWorkingCanvas>,
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
        .arg(job_path);
    apply_codex_command_options(&mut command, options);
    command
        .arg("exec")
        .arg("--ephemeral")
        .arg("--skip-git-repo-check");
    if json_progress {
        command.arg("--json");
    }
    if reference_paths.is_empty() {
        command.arg(codex_prompt(
            prompt.trim(),
            autonomy,
            working,
            reference_names,
        ));
    } else {
        command.arg("-i");
        for path in reference_paths {
            command.arg(path);
        }
        command.arg("--").arg(codex_prompt(
            prompt.trim(),
            autonomy,
            working,
            reference_names,
        ));
    }
    command
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY");
    command
}

fn decouple_codex_prompt(user_prompt: &str) -> String {
    format!(
        r##"Use the attached `source.png` to create a PaintNode recomposition asset pack.

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
- Use a perfectly flat PaintNode chroma-key matte ({chroma_key}) and `keyColor` only as the last fallback when neither real alpha nor an alpha mask is practical.
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
- If you generate an object on a plain matte/green-screen background without an alpha mask, use exactly `{chroma_key}` as the matte and set `keyColor` to `{chroma_key}`. PaintNode will remove that color into alpha.
- Do not choose a different matte color. PaintNode accepts only `{chroma_key}` for keyed AI assets.
- For reusable assets, prefer tight crops with transparent or keyed backgrounds. Set `x` and `y` to 0 unless the image is intentionally a full-size environment plate.
- Use manifest order from broad environment assets to foreground subject/prop assets.
- Keep filenames simple ASCII with `.png`.
- Do not ask follow-up questions.
- Do not edit files outside the current working directory.

Final response:
- One short sentence that says the asset pack was created.
- Do not embed base64 in the final response."##,
        chroma_key = AI_CHROMA_KEY_HEX
    )
}

fn build_decouple_codex_command(
    codex_bin: &str,
    job_path: &Path,
    prompt: &str,
    options: &CodexCommandOptions,
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
        .arg(job_path);
    apply_codex_command_options(&mut command, options);
    command.arg("exec").arg("--skip-git-repo-check");
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

fn workflow_compose_prompt(
    prompt: &str,
    source_names: &[String],
    autonomy: AiAutonomyLevel,
) -> String {
    let autonomy_contract = image_agent_autonomy_contract(autonomy, "Codex");
    let task_intro =
        "Use $imagegen to compose one new raster PNG for PaintNode from the attached workflow asset images.";
    let managed_method_requirements = if autonomy == AiAutonomyLevel::Unmanaged {
        "- Use the normal Codex image-generation flow and keep the generated image in Codex's generated-images cache.\n"
    } else {
        "- Use the normal Codex image-generation flow and keep the generated image in Codex's generated-images cache.\n- Do not create, edit, or delete files in the working directory.\n"
    };
    let sources = source_names
        .iter()
        .enumerate()
        .map(|(i, name)| format!("{}. {}", i + 1, name))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"{task_intro}

Connected workflow inputs:
{sources}

Composition prompt:
{prompt}

{autonomy_contract}

Requirements:
- Treat every attached image as intentionally connected to the composition node.
- The final PNG must visibly include every mandatory connected asset unless the prompt explicitly says to omit it.
- This is a generative synthesis task, not a cut-and-paste compositing task: reason from the assets and prompt to create a new coherent photo/image.
- Use the attached assets as visual references for identity, appearance, objects, environment, style, and layout. Reconstruct the final scene naturally instead of blindly pasting cropped source pixels together.
- Do not satisfy the task by copying or lightly editing only one source image, especially a background/environment image. Do not make a collage, contact sheet, sticker-board, or obvious paste-up.
- Unless the user explicitly asks for surreal or impossible results, preserve normal real-world structure: plausible anatomy, object scale, perspective, lighting, shadows, occlusion, contact, and physical interaction.
- If the user asks for an impossible or intentionally non-realistic composition, follow that request deliberately while still making the result visually coherent.
- Use subject/person assets for the subject identity, pose, clothing, and body appearance; use prop/object assets for the object appearance; use environment assets for the setting.
- If the prompt describes a person holding or interacting with a prop, the person and prop must both be visible and physically connected in the final image.
- Human anatomy is a hard quality requirement: exactly two arms, two hands, one palm per hand, natural wrists, plausible fingers, and no duplicated palms, extra hands, fused fingers, missing fingers, or broken joints.
- For held props, show a clean believable grip: the holding hand should wrap or support the prop naturally, and the other hand should remain anatomically separate and match the requested pose.
- If any attached image name starts with "Storyboard sketch", treat that image as the primary spatial plan, not as optional inspiration.
- Storyboard sketches are rough semantic diagrams: preserve their relative placement, left/right ordering, scale relationships, body pose, gesture direction, prop positions, foreground/background zones, and major negative space. Do not copy the rough sketch style into the final image.
- Preserve storyboard coordinate regions exactly enough for composition: a subject centered in the left third/left half of the storyboard must remain in that same left-side region in the final image; do not mirror, recenter, or shift it to the opposite side unless the prompt explicitly overrides the storyboard.
- Respect canvas halves, thirds, and major dividers shown in the storyboard. Large empty areas in the storyboard should remain visually open in the final image.
- If the storyboard and text differ, keep the text's subject/action meaning but follow the storyboard's composition and placement unless the text explicitly overrides the storyboard.
- Before generating the image, internally audit the storyboard into a concrete composition plan: subject bounding box, face/head position, torso direction, arm/hand poses, held-object position, gesture direction, environment zones, important dividers, and empty-space balance.
- Pass that concrete composition plan to image generation. Do not rely on a generic interpretation of the text prompt when the storyboard provides a more specific pose or layout.
- Create one coherent new image from the composition prompt and the mandatory asset list.
- Match perspective, lighting, scale, and contact shadows plausibly.
- Before finishing, zoom in mentally on the face, arms, hands, fingers, and held objects. If the requested subject, prop/object, environment, or hand anatomy is wrong, regenerate/refine until it is acceptable.
{managed_method_requirements}
- Do not ask follow-up questions.
- If a safety or quality adjustment is needed, make a reasonable compliant rephrasing and continue.

Final response should be one short sentence confirming the composed image was generated."#
    )
}

fn generative_fill_prompt(
    prompt: &str,
    autonomy: AiAutonomyLevel,
    working: &AiWorkingCanvas,
    reference_names: &[String],
) -> String {
    let autonomy_contract = image_agent_autonomy_contract(autonomy, "Codex");
    let task_intro = "Use $imagegen to perform one mask-guided generative fill for PaintNode.";
    let working_instruction = ai_working_canvas_instruction(working);
    let managed_method_requirements = if autonomy == AiAutonomyLevel::Unmanaged {
        "- Use the normal Codex image-generation flow for the visual fill. PaintNode owns deterministic working-canvas crop-back, protected-pixel restoration, mask blending, and import.\n"
    } else {
        "- Use the normal Codex image-generation flow for the visual fill. PaintNode owns deterministic working-canvas crop-back, protected-pixel restoration, mask blending, and import.\n- Do not create, edit, or delete files in the working directory except `result.png`.\n"
    };
    let reference_note = reference_prompt_note(reference_names, "");
    format!(
        r#"{task_intro}

Attached images:
1. `source.png` is the source PNG with the document centered inside it. Pixels outside the document rectangle are the PaintNode chroma-key matte `{chroma_key}`.
2. `edit_target.png` is the same-size image to edit in place. It has the protected photo content plus a neutral gray placeholder where PaintNode needs generated pixels.
3. `mask.png` is the same-size edit mask. White pixels are the full editable/generated area. Gray pixels are a narrow seam-blending transition zone. Black or transparent pixels are protected context and are not editable.

{reference_note}

{working_instruction}

User edit prompt:
{prompt}

{autonomy_contract}

Requirements:
- Use the centered content rectangle inside `edit_target.png` as the final document geometry. Do not create a new crop, zoom, framing, perspective, or aspect ratio for that rectangle.
- If `source.png` / `edit_target.png` have `{chroma_key}` chroma-key padding around that centered rectangle, leave those matte pixels exactly `{chroma_key}`.
- Prefer one full working-canvas PNG with the exact same pixel dimensions as `edit_target.png` and `source.png`.
- Save the final PNG as `result.png` in the current working directory. This file is required.
- Treat `result.png` as an in-place edit of `edit_target.png`, not as a newly composed photograph.
- Preserve every black/transparent-mask protected pixel from `source.png` visually unchanged. Treat protected content as context only.
- Fill the white-mask area, matching the surrounding scene, perspective, lighting, focus, color, grain, and camera style.
- Use the gray-mask transition zone only to keep edges registered and seamless with the original photo; do not make visible subject or composition changes there.
- Blend naturally across the mask boundary, but do not repaint protected subjects, vehicles, people, buildings, signs, road markings, or other black/transparent-mask content.
- Do not include PaintNode UI, checkerboard transparency pattern, selection outlines, red guide marks, borders, labels, or mask visualization in the output.
- Do not leave the neutral gray placeholder visible in the white-mask area.
- If extending a real photo, avoid inventing crisp readable text in newly generated distant signs or advertisements; partial or indistinct text is preferable.
{managed_method_requirements}
- Do not ask follow-up questions.
- If a safety or quality adjustment is needed, make a reasonable compliant rephrasing and continue.

Final response should be one short sentence confirming `result.png` was created."#,
        chroma_key = AI_CHROMA_KEY_HEX
    )
}

fn build_generative_fill_codex_command(
    codex_bin: &str,
    job_path: &Path,
    prompt: &str,
    reference_paths: &[PathBuf],
    reference_names: &[String],
    options: &CodexCommandOptions,
    autonomy: AiAutonomyLevel,
    working: &AiWorkingCanvas,
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
        .arg(job_path);
    apply_codex_command_options(&mut command, options);
    command.arg("exec").arg("--skip-git-repo-check");
    if json_progress {
        command.arg("--json");
    }
    command
        .arg("-i")
        .arg(job_path.join("source.png"))
        .arg(job_path.join("edit_target.png"))
        .arg(job_path.join("mask.png"));
    for path in reference_paths {
        command.arg(path);
    }
    command
        .arg("--")
        .arg(generative_fill_prompt(
            prompt.trim(),
            autonomy,
            working,
            reference_names,
        ))
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY");
    command
}

fn ai_retouch_exact_canvas_attached_image_notes(
    has_annotated_source: bool,
    has_reference: bool,
    reference_names: &[String],
) -> String {
    let mut lines = Vec::new();
    let mut index = 4;
    if has_annotated_source {
        lines.push(format!(
            "{index}. `annotated_source.png` is an optional guide image with PaintNode callouts. Use it only to locate the requested edit."
        ));
        index += 1;
    }
    if has_reference {
        lines.push(format!(
            "{index}. `reference.png` is an optional sampled reference area. Use it as visual guidance, not as pasted content unless the user explicitly requests copying."
        ));
    }
    if !reference_names.is_empty() {
        lines.push("Additional user reference images:".to_string());
        for name in reference_names {
            lines.push(format!("- `{name}`: user-added visual reference."));
        }
        lines.push("Use additional references as visual guidance only. Do not paste them directly unless the user explicitly asks for copied content.".to_string());
    }
    if lines.is_empty() {
        String::new()
    } else {
        format!("\n{}", lines.join("\n"))
    }
}

fn ai_retouch_exact_canvas_prompt(
    prompt: &str,
    has_annotated_source: bool,
    has_reference: bool,
    reference_names: &[String],
) -> String {
    let attached_image_notes = ai_retouch_exact_canvas_attached_image_notes(
        has_annotated_source,
        has_reference,
        reference_names,
    );
    format!(
        r#"Use $imagegen to perform one in-place PaintNode retouch.

This is a fixed-canvas image editing task, not a new image generation task.

Attached images:
1. `source.png` is the original source image.
2. `edit_target.png` is the exact base image to edit in place.
3. `mask.png` is the edit permission mask:
   - White pixels are editable.
   - Gray pixels are a feathered blend buffer.
   - Black pixels are locked context.
   - Transparent pixels are locked context and must remain unchanged.{attached_image_notes}

PaintNode image geometry:
- The output must have the same full-canvas framing, same document rectangle, same camera geometry, and same pixel coordinate system as `edit_target.png`.

Critical registration rule:
Do not translate, shift, crop, zoom, rotate, scale, stretch, warp, resize, reframe, straighten, or change the camera perspective.
The output must stay registered to the input image.

Before using image generation, inspect `source.png`, `edit_target.png`, and `mask.png` and identify the actual stable registration anchors from the visible pixels.
When invoking image generation, include only those image-specific anchors you observed from the attached inputs.
Do not use or invent a generic anchor checklist.

If the requested edit cannot be completed without moving, resizing, or reframing the subject or camera, simplify the edit instead.

User retouch prompt:
{prompt}

Retouch scope:
Only change pixels necessary to satisfy the user retouch prompt.
The visible edit must stay inside the white/gray mask footprint.
Do not use the mask as an instruction to repaint everything inside it.
Do not change unrequested content inside the mask.

Person preservation:
You may redraw clothing inside the editable area.
Do not move or rescale the person.
Preserve the original pose, head location, gaze, expression, body proportions, silhouette alignment, lighting direction, focus, grain, and camera style.
Unless explicitly requested, do not change the face, hair, eyes, skin, hands, or any unrequested surrounding content.

Locked context:
Black or transparent mask areas are locked. They must look copied from the original image.
Do not clean up, enhance, denoise, sharpen, recolor, relight, beautify, or reinterpret locked context.

Output requirements:
Return one full-canvas PNG candidate with the same dimensions and framing as `edit_target.png`.
Do not include PaintNode UI, checkerboard transparency, selection outlines, borders, labels, arrows, callouts, annotation text, guide marks, or mask visualization.

Autonomy level:
Use the image-generation capability only.
Do not write or run Python, shell, OpenCV, Pillow, alignment, comparison-image, or verification tools.
Do not create, edit, copy, verify, or delete files in the working directory.
Keep the generated image in Codex's generated-images cache.

Final response:
One short sentence confirming the AI retouch image was generated."#
    )
}

fn ai_retouch_prompt(
    prompt: &str,
    has_annotated_source: bool,
    has_reference: bool,
    reference_names: &[String],
    autonomy: AiAutonomyLevel,
    working: &AiWorkingCanvas,
) -> String {
    if !working.has_padding() {
        return ai_retouch_exact_canvas_prompt(
            prompt,
            has_annotated_source,
            has_reference,
            reference_names,
        );
    }

    let annotation_note = if has_annotated_source {
        "4. `annotated_source.png` is the clean source image with PaintNode annotation callouts rendered on top. Use it only to understand where the user's arrows, labels, and callouts point."
    } else {
        "No annotated source guide is attached for this retouch."
    };
    let reference_note = if has_reference {
        if has_annotated_source {
            "5. `reference.png` is the sampled source/reference area for this retouch. Use it as visual guidance, not as a paste-in unless the user prompt explicitly asks for copied content."
        } else {
            "4. `reference.png` is the sampled source/reference area for this retouch. Use it as visual guidance, not as a paste-in unless the user prompt explicitly asks for copied content."
        }
    } else {
        "No reference image is attached for this retouch. Infer the repair from the protected context around the mask."
    };
    let autonomy_contract = image_agent_autonomy_contract(autonomy, "Codex");
    let task_intro = "Use $imagegen to perform one AI retouch edit for PaintNode.";
    let working_instruction = ai_working_canvas_instruction(working);
    let extra_reference_note = reference_prompt_note(reference_names, "");
    let managed_method_requirements = if autonomy == AiAutonomyLevel::Unmanaged {
        "- Use the normal Codex image-generation flow and keep the generated image in Codex's generated-images cache.\n"
    } else {
        "- Use the normal Codex image-generation flow and keep the generated image in Codex's generated-images cache.\n- Do not create, edit, copy, verify, or delete files in the working directory.\n- You do not need to copy the generated PNG to `result.png`, composite the mask, restore protected pixels, crop, resize, write helper scripts, or prove exact pixel preservation. Those are deterministic PaintNode responsibilities.\n"
    };
    format!(
        r#"{task_intro}

Attached images:
1. `source.png` is the source PNG with the document centered inside it. Pixels outside the document rectangle are the PaintNode chroma-key matte `{chroma_key}`.
2. `edit_target.png` is the same-size image to edit in place. It preserves the original photo everywhere, including under the white mask. Masked pixels are editable even though their original content is still visible.
3. `mask.png` is the same-size edit mask. White pixels are editable. Gray pixels are a feathered transition buffer. Black or transparent pixels are protected context and are not editable.
{annotation_note}
{reference_note}
{extra_reference_note}

{working_instruction}

User retouch prompt:
{prompt}

{autonomy_contract}

Requirements:
- Use the centered content rectangle inside `edit_target.png` as the final document geometry. Do not create a crop, zoom, new framing, or aspect-ratio change for that rectangle.
- If `source.png` / `edit_target.png` have `{chroma_key}` chroma-key padding around that centered rectangle, leave those matte pixels exactly `{chroma_key}`.
- Prefer one full working-canvas PNG candidate with the exact same pixel dimensions as `source.png` and `edit_target.png`.
{managed_method_requirements}
- PaintNode will apply `mask.png` after you finish: white-mask pixels will be inserted from your generated candidate, gray-mask pixels will be blended with `source.png`, and black/transparent-mask protected pixels will be discarded and preserved from `source.png` by the app.
- Even so, make your generated candidate visually identical to `source.png` everywhere `mask.png` is black or transparent. Do not clean up, enhance, crop out, remove, sharpen, denoise, recolor, relight, straighten, or reframe any protected area.
- Treat the generated candidate as an in-place retouch of `edit_target.png`, not as a new composition.
- Treat `mask.png` as the maximum allowed edit area, not as an instruction to repaint every white pixel. Change only the content explicitly requested by the user prompt and preserve unrequested masked content.
- Keep every newly generated, removed, replaced, reconstructed, relit, recolored, cleaned, extended, blended, shadowed, reflected, or otherwise changed visible pixel inside the white/gray mask footprint.
- Any edit whose visible change extends outside the mask is a failed retouch, even if PaintNode later restores protected pixels. Scale, simplify, or localize the requested change so the complete visible edit fits inside the mask footprint.
- If the prompt changes clothing or accessories, preserve the person's identity, face, hair, skin, hands, pose, body proportions, expression, gaze, and all unrequested surrounding content unless the user explicitly asks to alter those details.
- If `annotated_source.png` is attached, use its arrows, labels, and callout positions as guidance for what each nearby mask region should become.
- Change only the masked retouch area, with any edge blending kept subtle and registered.
- For text, logos, painted marks, signs, glare, or surface blemishes, remove only the foreground mark and reconstruct the continuous underlying surface. Do not cover it with a flat rectangle, paint swatch, or unrelated color block.
- Match the surrounding scene, perspective, lighting, focus, color, texture, grain, and camera style.
- Do not include PaintNode UI, checkerboard transparency, selection outlines, borders, labels, red arrows, yellow callout boxes, annotation text, guide marks, or mask visualization.
- Do not ask follow-up questions.
- If a safety or quality adjustment is needed, make a reasonable compliant rephrasing and continue.

Final response should be one short sentence confirming the AI retouch image was generated."#,
        chroma_key = AI_CHROMA_KEY_HEX
    )
}

fn build_ai_retouch_codex_command(
    codex_bin: &str,
    job_path: &Path,
    prompt: &str,
    has_annotated_source: bool,
    has_reference: bool,
    reference_paths: &[PathBuf],
    reference_names: &[String],
    options: &CodexCommandOptions,
    autonomy: AiAutonomyLevel,
    working: &AiWorkingCanvas,
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
        .arg(job_path);
    apply_codex_command_options(&mut command, options);
    command.arg("exec").arg("--skip-git-repo-check");
    if json_progress {
        command.arg("--json");
    }
    command
        .arg("-i")
        .arg(job_path.join("source.png"))
        .arg(job_path.join("edit_target.png"))
        .arg(job_path.join("mask.png"));
    if has_annotated_source {
        command.arg(job_path.join("annotated_source.png"));
    }
    if has_reference {
        command.arg(job_path.join("reference.png"));
    }
    for path in reference_paths {
        command.arg(path);
    }
    command
        .arg("--")
        .arg(ai_retouch_prompt(
            prompt.trim(),
            has_annotated_source,
            has_reference,
            reference_names,
            autonomy,
            working,
        ))
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY");
    command
}

fn build_workflow_compose_codex_command(
    codex_bin: &str,
    job_path: &Path,
    image_paths: &[PathBuf],
    prompt: &str,
    source_names: &[String],
    options: &CodexCommandOptions,
    autonomy: AiAutonomyLevel,
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
        .arg(job_path);
    apply_codex_command_options(&mut command, options);
    command.arg("exec").arg("--skip-git-repo-check");
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
        .arg(workflow_compose_prompt(
            prompt.trim(),
            source_names,
            autonomy,
        ))
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

#[tauri::command]
fn clipboard_read_text() -> Result<Option<String>, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("Clipboard unavailable: {error}"))?;
    Ok(clipboard.get_text().ok())
}

#[tauri::command]
fn clipboard_write_text(text: String) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("Clipboard unavailable: {error}"))?;
    clipboard
        .set_text(text)
        .map_err(|error| format!("Clipboard write failed: {error}"))
}

#[tauri::command]
fn app_memory_info() -> Result<AppMemoryInfo, String> {
    let mut system = System::new_all();
    system.refresh_all();

    let root_pid = Pid::from_u32(std::process::id());
    let mut resident_bytes = 0_u64;
    let mut process_count = 0_usize;

    for (pid, process) in system.processes() {
        let mut current = Some(*pid);
        let mut depth = 0;
        let mut belongs_to_app = false;

        while let Some(candidate) = current {
            if candidate == root_pid {
                belongs_to_app = true;
                break;
            }
            depth += 1;
            if depth > 64 {
                break;
            }
            current = system.process(candidate).and_then(|item| item.parent());
        }

        if belongs_to_app {
            resident_bytes = resident_bytes.saturating_add(process.memory());
            process_count += 1;
        }
    }

    Ok(AppMemoryInfo {
        resident_bytes,
        process_count,
    })
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
        out_path.push(format!("paintnode-gen-{ts}.png"));
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

#[tauri::command]
async fn detect_codex(bin: Option<String>) -> Result<CodexDetectionResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> CodexDetectionResult {
        let codex_bin = match configured_or_default_codex_bin(bin) {
            Ok(path) => path,
            Err(error) => {
                return CodexDetectionResult {
                    found: false,
                    path: None,
                    version: None,
                    error: Some(error),
                };
            }
        };

        match Command::new(&codex_bin)
            .arg("--version")
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_API_KEY")
            .output()
        {
            Ok(output) if output.status.success() => {
                let version = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .or_else(|| {
                        String::from_utf8_lossy(&output.stderr)
                            .lines()
                            .next()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                    });
                CodexDetectionResult {
                    found: true,
                    path: Some(codex_bin),
                    version,
                    error: None,
                }
            }
            Ok(output) => CodexDetectionResult {
                found: false,
                path: Some(codex_bin),
                version: None,
                error: Some(command_failure("Codex detection", &output)),
            },
            Err(error) => CodexDetectionResult {
                found: false,
                path: Some(codex_bin),
                version: None,
                error: Some(format!("Failed to launch Codex: {error}")),
            },
        }
    })
    .await
    .map_err(|e| format!("Task error: {e}"))
}

#[tauri::command]
async fn detect_antigravity(bin: Option<String>) -> Result<CodexDetectionResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> CodexDetectionResult {
        let antigravity_bin = match configured_or_default_antigravity_bin(bin) {
            Ok(path) => path,
            Err(error) => {
                return CodexDetectionResult {
                    found: false,
                    path: None,
                    version: None,
                    error: Some(error),
                };
            }
        };

        match Command::new(&antigravity_bin).arg("--version").output() {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                CodexDetectionResult {
                    found: true,
                    path: Some(antigravity_bin),
                    version: Some(if stdout.is_empty() { stderr } else { stdout }),
                    error: None,
                }
            }
            Ok(output) => CodexDetectionResult {
                found: false,
                path: Some(antigravity_bin),
                version: None,
                error: Some(command_failure("Antigravity detection", &output)),
            },
            Err(error) => CodexDetectionResult {
                found: false,
                path: Some(antigravity_bin),
                version: None,
                error: Some(format!("Failed to launch Antigravity CLI: {error}")),
            },
        }
    })
    .await
    .map_err(|e| format!("Task error: {e}"))
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
    keep_job_dir: Option<bool>,
    reference_pngs: Vec<WorkflowSourceImage>,
    run_id: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    autonomy_level: Option<String>,
    target_width: Option<u32>,
    target_height: Option<u32>,
) -> Result<GeneratedImageResult, String> {
    if prompt.trim().is_empty() {
        return Err("Enter a prompt.".into());
    }
    validate_reference_pngs(&reference_pngs, "Generate image")?;
    let target_dimensions = validate_optional_target_dimensions(target_width, target_height)?;

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let codex_bin = configured_or_default_codex_bin(bin)?;
        let codex_options = codex_command_options(model, reasoning_effort, service_tier);
        let autonomy = ai_autonomy_level(autonomy_level);
        let working = target_dimensions.map(ai_codex_working_canvas_for_dimensions);
        let run_id = if run_id.trim().is_empty() {
            format!("codex-{}", now_id())
        } else {
            run_id
        };
        let project_dir = optional_project_dir(&project_path);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let job_project_dir = ai_job_project_dir(&app, &project_dir, keep_job_dir)?;
        let cleanup_project_job = cleanup_project_job_enabled(&job_project_dir, keep_job_dir);
        let temp_job;
        let job_path = if let Some(job_project_dir) = &job_project_dir {
            project_agent_run_dir(job_project_dir, CODEX_RUNS_DIR, "run")?
        } else {
            temp_job = TempJobDir::new("paintnode-codex")?;
            temp_job.path().to_path_buf()
        };
        let (reference_paths, reference_names) =
            write_reference_pngs(&job_path, &reference_pngs, "Generate image")?;
        write_ai_job_prompt(
            &job_path,
            &codex_prompt(prompt.trim(), autonomy, working.as_ref(), &reference_names),
            "Codex image generation",
        )?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);
        emit_codex_progress(&app, &run_id, "Starting local Codex");
        let codex_started_at = SystemTime::now();
        let mut command = build_codex_command(
            &codex_bin,
            &job_path,
            prompt.trim(),
            &reference_paths,
            &reference_names,
            &codex_options,
            autonomy,
            working.as_ref(),
            true,
        );
        let mut run = run_codex_with_progress(
            &mut command,
            GENERATION_TIMEOUT,
            app.clone(),
            run_id.clone(),
        )
        .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;

        if !run.output.status.success() && output_mentions_unsupported_json(&run.output) {
            emit_codex_progress(
                &app,
                &run_id,
                "Codex progress stream unavailable; retrying generation",
            );
            let mut fallback = build_codex_command(
                &codex_bin,
                &job_path,
                prompt.trim(),
                &reference_paths,
                &reference_names,
                &codex_options,
                autonomy,
                working.as_ref(),
                false,
            );
            run = run_codex_with_progress(
                &mut fallback,
                GENERATION_TIMEOUT,
                app.clone(),
                run_id.clone(),
            )
            .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;
        }

        if !run.output.status.success() {
            if let Some(message) = final_codex_agent_message(&run.output) {
                return Err(format!("Codex did not generate an image.\n\n{message}"));
            }
            return Err(command_failure("Codex", &run.output));
        }

        let Some((recovered_source_path, staged_result_path)) =
            copy_codex_cached_png_to_job(&job_path, run.thread_id.as_deref(), codex_started_at)?
        else {
            if let Some(message) = final_codex_agent_message(&run.output) {
                return Err(format!(
                    "Codex did not expose a generated image in its generated-images cache.\n\n{message}"
                ));
            }

            let stdout = output_tail(&run.output.stdout);
            let stderr = output_tail(&run.output.stderr);
            let detail = if !stderr.is_empty() {
                stderr
            } else if !stdout.is_empty() {
                stdout
            } else {
                "Codex completed without exposing a generated PNG that PaintNode could copy.".into()
            };
            return Err(format!(
                "PaintNode could not find a new PNG in Codex's generated-images cache.\n\n{detail}"
            ));
        };

        emit_codex_progress(&app, &run_id, "Reading copied PNG");
        let (bytes, result_dimensions, normalized_result) = if let Some(working) = &working {
            read_png_bytes_cropped_to_ai_working_canvas(
                &staged_result_path,
                working,
                "Codex generated image",
            )?
        } else {
            let bytes = fs::read(&staged_result_path)
                .map_err(|e| format!("Failed to read generated image: {e}"))?;
            let dimensions = png_dimensions_from_bytes(&bytes)
                .ok_or_else(|| "Codex generated image PNG dimensions are invalid.".to_string())?;
            (bytes, dimensions, false)
        };
        if normalized_result {
            if let Some(working) = &working {
                emit_codex_progress(
                    &app,
                    &run_id,
                    &format!(
                        "Normalized Codex result from {}x{} {} canvas to {}x{}",
                        result_dimensions.0,
                        result_dimensions.1,
                        working.aspect_label,
                        working.original_dimensions.0,
                        working.original_dimensions.1
                    ),
                );
            }
        }
        let data_url = png_data_url(&bytes)?;
        let asset = if let Some(project_dir) = project_dir {
            emit_codex_progress(&app, &run_id, "Saving generated image to the project");
            let source_file_name = recovered_source_path
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| *name != "result.png")
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
            cleanup_project_agent_job(&job_path);
        }

        emit_codex_progress(&app, &run_id, "Done");
        let assets = asset.iter().cloned().collect();
        Ok(GeneratedImageResult {
            data_url,
            asset,
            assets,
            mask_data_url: None,
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

/// Run local Codex headlessly for a mask-guided generative fill.
#[tauri::command]
async fn generate_codex_fill_image(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    keep_job_dir: Option<bool>,
    store_asset: Option<bool>,
    source_png: Vec<u8>,
    edit_target_png: Vec<u8>,
    mask_png: Vec<u8>,
    reference_pngs: Vec<WorkflowSourceImage>,
    run_id: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    autonomy_level: Option<String>,
) -> Result<GeneratedImageResult, String> {
    if prompt.trim().is_empty() {
        return Err("Enter a generative fill prompt.".into());
    }
    if !is_png(&source_png) {
        return Err("Generative fill source is not a PNG image.".into());
    }
    if !is_png(&edit_target_png) {
        return Err("Generative fill edit target is not a PNG image.".into());
    }
    if !is_png(&mask_png) {
        return Err("Generative fill mask is not a PNG image.".into());
    }
    validate_reference_pngs(&reference_pngs, "Generative fill")?;
    let source_dimensions = png_dimensions_from_bytes(&source_png)
        .ok_or_else(|| "Generative fill source PNG dimensions are invalid.".to_string())?;
    let target_dimensions = png_dimensions_from_bytes(&edit_target_png)
        .ok_or_else(|| "Generative fill edit target PNG dimensions are invalid.".to_string())?;
    let mask_dimensions = png_dimensions_from_bytes(&mask_png)
        .ok_or_else(|| "Generative fill mask PNG dimensions are invalid.".to_string())?;
    if target_dimensions != source_dimensions {
        return Err(format!(
            "Generative fill edit target must match source dimensions. Source is {}x{}, target is {}x{}.",
            source_dimensions.0, source_dimensions.1, target_dimensions.0, target_dimensions.1
        ));
    }
    if mask_dimensions != source_dimensions {
        return Err(format!(
            "Generative fill mask must match source dimensions. Source is {}x{}, mask is {}x{}.",
            source_dimensions.0, source_dimensions.1, mask_dimensions.0, mask_dimensions.1
        ));
    }
    let working = ai_working_canvas_for_dimensions(source_dimensions);

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let codex_bin = configured_or_default_codex_bin(bin)?;
        let codex_options = codex_command_options(model, reasoning_effort, service_tier);
        let autonomy = ai_autonomy_level(autonomy_level);
        let run_id = if run_id.trim().is_empty() {
            format!("fill-{}", now_id())
        } else {
            run_id
        };
        let project_dir = optional_project_dir(&project_path);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let job_project_dir = ai_job_project_dir(&app, &project_dir, keep_job_dir)?;
        let cleanup_project_job = cleanup_project_job_enabled(&job_project_dir, keep_job_dir);
        let store_asset = store_asset.unwrap_or(true);
        let temp_job;
        let job_path = if let Some(job_project_dir) = &job_project_dir {
            project_agent_run_dir(job_project_dir, CODEX_RUNS_DIR, "fill")?
        } else {
            temp_job = TempJobDir::new("paintnode-fill")?;
            temp_job.path().to_path_buf()
        };

        let working_source_png = pad_png_to_ai_working_canvas(
            &source_png,
            &working,
            "generative fill source image",
            ai_chroma_key_pixel(),
        )?;
        let working_edit_target_png = pad_png_to_ai_working_canvas(
            &edit_target_png,
            &working,
            "generative fill edit target image",
            ai_chroma_key_pixel(),
        )?;
        let working_mask_png = pad_png_to_ai_working_canvas(
            &mask_png,
            &working,
            "generative fill mask image",
            ai_mask_padding_pixel(),
        )?;

        fs::write(job_path.join("source.png"), &working_source_png)
            .map_err(|e| format!("Failed to write generative fill source image: {e}"))?;
        fs::write(job_path.join("edit_target.png"), &working_edit_target_png)
            .map_err(|e| format!("Failed to write generative fill edit target image: {e}"))?;
        fs::write(job_path.join("mask.png"), &working_mask_png)
            .map_err(|e| format!("Failed to write generative fill mask image: {e}"))?;
        let (reference_paths, reference_names) =
            write_reference_pngs(&job_path, &reference_pngs, "Generative fill")?;
        write_ai_job_prompt(
            &job_path,
            &generative_fill_prompt(prompt.trim(), autonomy, &working, &reference_names),
            "Codex generative fill",
        )?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);

        emit_codex_progress(&app, &run_id, "Starting local Codex generative fill");
        let codex_started_at = SystemTime::now();
        let mut command = build_generative_fill_codex_command(
            &codex_bin,
            &job_path,
            prompt.trim(),
            &reference_paths,
            &reference_names,
            &codex_options,
            autonomy,
            &working,
            true,
        );
        let mut run = run_codex_with_progress(
            &mut command,
            GENERATION_TIMEOUT,
            app.clone(),
            run_id.clone(),
        )
        .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;

        if !run.output.status.success() && output_mentions_unsupported_json(&run.output) {
            emit_codex_progress(
                &app,
                &run_id,
                "Codex progress stream unavailable; retrying generative fill",
            );
            let mut fallback = build_generative_fill_codex_command(
                &codex_bin,
                &job_path,
                prompt.trim(),
                &reference_paths,
                &reference_names,
                &codex_options,
                autonomy,
                &working,
                false,
            );
            run = run_codex_with_progress(
                &mut fallback,
                GENERATION_TIMEOUT,
                app.clone(),
                run_id.clone(),
            )
            .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;
        }

        if !run.output.status.success() {
            if let Some(message) = final_codex_agent_message(&run.output) {
                return Err(format!("Codex did not generate a fill image.\n\n{message}"));
            }
            return Err(command_failure("Codex generative fill", &run.output));
        }

        let requested_result_path = job_path.join("result.png");
        let (recovered_source_path, staged_result_path) = if requested_result_path.exists() {
            (requested_result_path.clone(), requested_result_path)
        } else {
            let Some((recovered_source_path, staged_result_path)) =
                copy_codex_cached_png_to_job(&job_path, run.thread_id.as_deref(), codex_started_at)?
            else {
                if let Some(message) = final_codex_agent_message(&run.output) {
                    return Err(format!(
                        "Codex did not create result.png or expose a generative fill image in its generated-images cache.\n\n{message}"
                    ));
                }
                return Err("PaintNode could not find result.png or a generative fill PNG in Codex's generated-images cache.".into());
            };
            (recovered_source_path, staged_result_path)
        };

        emit_codex_progress(&app, &run_id, "Reading generative fill PNG");
        let (bytes, result_dimensions, normalized_result) =
            read_png_bytes_cropped_to_ai_working_canvas(
                &staged_result_path,
                &working,
                "Codex generative fill",
            )?;
        if normalized_result {
            emit_codex_progress(
                &app,
                &run_id,
                &format!(
                    "Normalized Codex fill from {}x{} {} canvas to {}x{}",
                    result_dimensions.0,
                    result_dimensions.1,
                    working.aspect_label,
                    source_dimensions.0,
                    source_dimensions.1
                ),
            );
        }
        let data_url = png_data_url(&bytes)?;
        let asset = if store_asset {
            if let Some(project_dir) = project_dir {
            emit_codex_progress(&app, &run_id, "Saving generative fill to the project");
            let source_file_name = recovered_source_path
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| *name != "result.png")
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
            }
        } else {
            None
        };

        if cleanup_project_job {
            cleanup_project_agent_job(&job_path);
        }

        emit_codex_progress(&app, &run_id, "Done");
        let assets = asset.iter().cloned().collect();
        Ok(GeneratedImageResult {
            data_url,
            asset,
            assets,
            mask_data_url: None,
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

/// Run local Codex headlessly for an AI retouch request.
#[tauri::command]
async fn generate_codex_retouch_image(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    keep_job_dir: Option<bool>,
    source_png: Vec<u8>,
    edit_target_png: Vec<u8>,
    mask_png: Vec<u8>,
    annotated_source_png: Option<Vec<u8>>,
    reference_png: Option<Vec<u8>>,
    reference_pngs: Vec<WorkflowSourceImage>,
    run_id: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    autonomy_level: Option<String>,
) -> Result<GeneratedImageResult, String> {
    if prompt.trim().is_empty() {
        return Err("Enter an AI retouch prompt.".into());
    }
    if !is_png(&source_png) {
        return Err("AI retouch source is not a PNG image.".into());
    }
    if !is_png(&edit_target_png) {
        return Err("AI retouch edit target is not a PNG image.".into());
    }
    if !is_png(&mask_png) {
        return Err("AI retouch mask is not a PNG image.".into());
    }
    if let Some(annotated_source_png) = &annotated_source_png {
        if !is_png(annotated_source_png) {
            return Err("AI retouch annotated source is not a PNG image.".into());
        }
    }
    if let Some(reference_png) = &reference_png {
        if !is_png(reference_png) {
            return Err("AI retouch reference is not a PNG image.".into());
        }
        png_dimensions_from_bytes(reference_png)
            .ok_or_else(|| "AI retouch reference PNG dimensions are invalid.".to_string())?;
    }
    validate_reference_pngs(&reference_pngs, "AI retouch")?;
    let source_dimensions = png_dimensions_from_bytes(&source_png)
        .ok_or_else(|| "AI retouch source PNG dimensions are invalid.".to_string())?;
    let target_dimensions = png_dimensions_from_bytes(&edit_target_png)
        .ok_or_else(|| "AI retouch edit target PNG dimensions are invalid.".to_string())?;
    let mask_dimensions = png_dimensions_from_bytes(&mask_png)
        .ok_or_else(|| "AI retouch mask PNG dimensions are invalid.".to_string())?;
    let annotated_source_dimensions = match &annotated_source_png {
        Some(annotated_source_png) => Some(
            png_dimensions_from_bytes(annotated_source_png).ok_or_else(|| {
                "AI retouch annotated source PNG dimensions are invalid.".to_string()
            })?,
        ),
        None => None,
    };
    if target_dimensions != source_dimensions {
        return Err(format!(
            "AI retouch edit target must match source dimensions. Source is {}x{}, target is {}x{}.",
            source_dimensions.0, source_dimensions.1, target_dimensions.0, target_dimensions.1
        ));
    }
    if mask_dimensions != source_dimensions {
        return Err(format!(
            "AI retouch mask must match source dimensions. Source is {}x{}, mask is {}x{}.",
            source_dimensions.0, source_dimensions.1, mask_dimensions.0, mask_dimensions.1
        ));
    }
    if let Some(annotated_source_dimensions) = annotated_source_dimensions {
        if annotated_source_dimensions != source_dimensions {
            return Err(format!(
                "AI retouch annotated source must match source dimensions. Source is {}x{}, annotated source is {}x{}.",
                source_dimensions.0, source_dimensions.1, annotated_source_dimensions.0, annotated_source_dimensions.1
            ));
        }
    }
    let working = ai_codex_working_canvas_for_dimensions(source_dimensions);

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let codex_bin = configured_or_default_codex_bin(bin)?;
        let codex_options = codex_command_options(model, reasoning_effort, service_tier);
        let autonomy = ai_autonomy_level(autonomy_level);
        let run_id = if run_id.trim().is_empty() {
            format!("retouch-{}", now_id())
        } else {
            run_id
        };
        let project_dir = optional_project_dir(&project_path);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let job_project_dir = ai_job_project_dir(&app, &project_dir, keep_job_dir)?;
        let cleanup_project_job = cleanup_project_job_enabled(&job_project_dir, keep_job_dir);
        let temp_job;
        let job_path = if let Some(job_project_dir) = &job_project_dir {
            project_agent_run_dir(job_project_dir, CODEX_RUNS_DIR, "retouch")?
        } else {
            temp_job = TempJobDir::new("paintnode-retouch")?;
            temp_job.path().to_path_buf()
        };

        let working_source_png = pad_png_to_ai_working_canvas(
            &source_png,
            &working,
            "AI retouch source image",
            ai_chroma_key_pixel(),
        )?;
        let working_edit_target_png = pad_png_to_ai_working_canvas(
            &edit_target_png,
            &working,
            "AI retouch edit target image",
            ai_chroma_key_pixel(),
        )?;
        let working_mask_png = pad_png_to_ai_working_canvas(
            &mask_png,
            &working,
            "AI retouch mask image",
            ai_mask_padding_pixel(),
        )?;

        fs::write(job_path.join("source.png"), &working_source_png)
            .map_err(|e| format!("Failed to write AI retouch source image: {e}"))?;
        fs::write(job_path.join("edit_target.png"), &working_edit_target_png)
            .map_err(|e| format!("Failed to write AI retouch edit target image: {e}"))?;
        fs::write(job_path.join("mask.png"), &working_mask_png)
            .map_err(|e| format!("Failed to write AI retouch mask image: {e}"))?;
        let has_annotated_source = if let Some(annotated_source_png) = &annotated_source_png {
            let working_annotated_source_png = pad_png_to_ai_working_canvas(
                annotated_source_png,
                &working,
                "AI retouch annotated source image",
                ai_chroma_key_pixel(),
            )?;
            fs::write(job_path.join("annotated_source.png"), working_annotated_source_png)
                .map_err(|e| format!("Failed to write AI retouch annotated source image: {e}"))?;
            true
        } else {
            false
        };
        let has_reference = if let Some(reference_png) = &reference_png {
            fs::write(job_path.join("reference.png"), reference_png)
                .map_err(|e| format!("Failed to write AI retouch reference image: {e}"))?;
            true
        } else {
            false
        };
        let (reference_paths, reference_names) =
            write_reference_pngs(&job_path, &reference_pngs, "AI retouch")?;
        write_ai_job_prompt(
            &job_path,
            &ai_retouch_prompt(
                prompt.trim(),
                has_annotated_source,
                has_reference,
                &reference_names,
                autonomy,
                &working,
            ),
            "Codex AI retouch",
        )?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);

        emit_codex_progress(&app, &run_id, "Starting local Codex AI retouch");
        let codex_started_at = SystemTime::now();
        let mut command = build_ai_retouch_codex_command(
            &codex_bin,
            &job_path,
            prompt.trim(),
            has_annotated_source,
            has_reference,
            &reference_paths,
            &reference_names,
            &codex_options,
            autonomy,
            &working,
            true,
        );
        let mut image_run = run_codex_with_progress_until_cached_png(
            &mut command,
            GENERATION_TIMEOUT,
            app.clone(),
            run_id.clone(),
            codex_started_at,
            &working,
        )
        .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;

        if !image_run.image_cached_before_exit
            && !image_run.run.output.status.success()
            && output_mentions_unsupported_json(&image_run.run.output)
        {
            emit_codex_progress(
                &app,
                &run_id,
                "Codex progress stream unavailable; retrying AI retouch",
            );
            let mut fallback = build_ai_retouch_codex_command(
                &codex_bin,
                &job_path,
                prompt.trim(),
                has_annotated_source,
                has_reference,
                &reference_paths,
                &reference_names,
                &codex_options,
                autonomy,
                &working,
                false,
            );
            image_run = run_codex_with_progress_until_cached_png(
                &mut fallback,
                GENERATION_TIMEOUT,
                app.clone(),
                run_id.clone(),
                codex_started_at,
                &working,
            )
            .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;
        }

        if !image_run.image_cached_before_exit && !image_run.run.output.status.success() {
            if let Some(message) = final_codex_agent_message(&image_run.run.output) {
                return Err(format!("Codex did not generate an AI retouch image.\n\n{message}"));
            }
            return Err(command_failure("Codex AI retouch", &image_run.run.output));
        }

        let cached_results =
            copy_codex_cached_pngs_to_job(&job_path, image_run.run.thread_id.as_deref(), codex_started_at)?;
        let requested_result_path = job_path.join("result.png");
        let (recovered_source_path, staged_result_path) =
            if let Some((recovered_source_path, staged_result_path)) = cached_results.last().cloned()
            {
                (recovered_source_path, staged_result_path)
            } else if requested_result_path.exists() {
                (requested_result_path.clone(), requested_result_path)
            } else {
                if let Some(message) = final_codex_agent_message(&image_run.run.output) {
                    return Err(format!(
                        "Codex did not expose an AI retouch image in its generated-images cache.\n\n{message}"
                    ));
                }
                return Err(
                    "PaintNode could not find an AI retouch PNG in Codex's generated-images cache."
                    .into(),
                );
            };
        let (generated_bytes, result_dimensions, normalized_result) =
            read_png_bytes_cropped_to_ai_working_canvas(
                &staged_result_path,
                &working,
                "AI retouch candidate",
            )?;
        if normalized_result {
            emit_codex_progress(
                &app,
                &run_id,
                &format!(
                    "Normalized AI retouch result from {}x{} {} canvas to {}x{}",
                    result_dimensions.0,
                    result_dimensions.1,
                    working.aspect_label,
                    source_dimensions.0,
                    source_dimensions.1
                ),
            );
        }

        emit_codex_progress(&app, &run_id, "Preparing editable AI retouch mask");
        let mask_data_url = Some(png_data_url(&ai_retouch_editable_mask_png(
            &source_png,
            &mask_png,
            AI_RETOUCH_OUTPUT_MASK_GROW_RADIUS,
            AI_RETOUCH_OUTPUT_MASK_FEATHER_RADIUS,
        )?)?);
        let data_url = png_data_url(&generated_bytes)?;
        let mut assets = Vec::new();
        let asset = if let Some(project_dir) = project_dir {
            let source_file_name = safe_png_source_file_name(&recovered_source_path);
            emit_codex_progress(&app, &run_id, "Saving raw AI retouch result to the project");
            let raw_result_bytes = fs::read(&staged_result_path).map_err(|e| {
                format!(
                    "Failed to read raw AI retouch result at {}: {e}",
                    staged_result_path.display()
                )
            })?;
            let name = ai_retouch_asset_name(prompt.trim(), source_file_name.as_deref());
            let primary_asset = store_generated_png_asset(
                &project_dir,
                &raw_result_bytes,
                name,
                Some(prompt.trim().into()),
                source_file_name,
            )?;
            assets.push(primary_asset.clone());

            Some(primary_asset)
        } else {
            None
        };

        if cleanup_project_job {
            cleanup_project_agent_job(&job_path);
        }

        emit_codex_progress(&app, &run_id, "Done");
        Ok(GeneratedImageResult {
            data_url,
            asset,
            assets,
            mask_data_url,
        })
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
    keep_job_dir: Option<bool>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    autonomy_level: Option<String>,
) -> Result<DecoupleImageResult, String> {
    if !is_png(&source_png) {
        return Err("Asset extraction source must be a PNG image.".into());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<DecoupleImageResult, String> {
        let codex_bin = configured_or_default_codex_bin(bin)?;
        let codex_options = codex_command_options(model, reasoning_effort, service_tier);
        let _autonomy = ai_autonomy_level(autonomy_level);
        let run_id = if run_id.trim().is_empty() {
            format!("decouple-{}", now_id())
        } else {
            run_id
        };
        let project_dir = optional_project_dir(&project_path);
        let store_assets = store_assets.unwrap_or(true);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let job_project_dir = ai_job_project_dir(&app, &project_dir, keep_job_dir)?;
        let cleanup_project_job = cleanup_project_job_enabled(&job_project_dir, keep_job_dir);
        let temp_job;
        let job_path = if let Some(job_project_dir) = &job_project_dir {
            project_agent_run_dir(job_project_dir, CODEX_RUNS_DIR, "decouple")?
        } else {
            temp_job = TempJobDir::new("paintnode-decouple")?;
            temp_job.path().to_path_buf()
        };

        let source_path = job_path.join("source.png");
        fs::write(&source_path, &source_png)
            .map_err(|e| format!("Failed to write decouple source image: {e}"))?;

        emit_codex_progress(&app, &run_id, "Starting local Codex asset extraction");
        let user_prompt = if prompt.trim().is_empty() {
            "Identify the main reusable elements and create a useful recomposition asset pack."
        } else {
            prompt.trim()
        };
        write_ai_job_prompt(
            &job_path,
            &decouple_codex_prompt(user_prompt),
            "Codex asset extraction",
        )?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);
        let mut command =
            build_decouple_codex_command(&codex_bin, &job_path, user_prompt, &codex_options, true);
        let mut run = run_codex_with_progress(
            &mut command,
            GENERATION_TIMEOUT,
            app.clone(),
            run_id.clone(),
        )
        .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;

        if !run.output.status.success() && output_mentions_unsupported_json(&run.output) {
            emit_codex_progress(
                &app,
                &run_id,
                "Codex progress stream unavailable; retrying asset extraction",
            );
            let mut fallback = build_decouple_codex_command(
                &codex_bin,
                &job_path,
                user_prompt,
                &codex_options,
                false,
            );
            run = run_codex_with_progress(
                &mut fallback,
                GENERATION_TIMEOUT,
                app.clone(),
                run_id.clone(),
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

        if cleanup_project_job {
            cleanup_project_agent_job(&job_path);
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
    keep_job_dir: Option<bool>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    autonomy_level: Option<String>,
) -> Result<GeneratedImageResult, String> {
    if prompt.trim().is_empty() {
        return Err("Enter a composition prompt.".into());
    }
    if sources.is_empty() {
        return Err("Add at least one asset node before generating.".into());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let codex_bin = configured_or_default_codex_bin(bin)?;
        let codex_options = codex_command_options(model, reasoning_effort, service_tier);
        let autonomy = ai_autonomy_level(autonomy_level);
        let run_id = if run_id.trim().is_empty() {
            format!("workflow-{}", now_id())
        } else {
            run_id
        };
        let project_dir = optional_project_dir(&project_path);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let job_project_dir = ai_job_project_dir(&app, &project_dir, keep_job_dir)?;
        let cleanup_project_job = cleanup_project_job_enabled(&job_project_dir, keep_job_dir);
        let temp_job;
        let job_path = if let Some(job_project_dir) = &job_project_dir {
            project_agent_run_dir(job_project_dir, CODEX_RUNS_DIR, "workflow")?
        } else {
            temp_job = TempJobDir::new("paintnode-workflow")?;
            temp_job.path().to_path_buf()
        };

        let mut source_names = Vec::new();
        let mut image_paths = Vec::new();
        let input_dir = job_path.join("inputs");
        fs::create_dir_all(&input_dir)
            .map_err(|e| format!("Failed to create workflow input folder: {e}"))?;
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
            let path = input_dir.join(format!("{}-{}.png", index + 1, safe_stem(&name)));
            fs::write(&path, &source.bytes)
                .map_err(|e| format!("Failed to write workflow source image: {e}"))?;
            source_names.push(name);
            image_paths.push(path);
        }
        write_ai_job_prompt(
            &job_path,
            &workflow_compose_prompt(prompt.trim(), &source_names, autonomy),
            "Codex workflow composition",
        )?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);

        emit_codex_progress(&app, &run_id, "Starting local Codex workflow composition");
        let codex_started_at = SystemTime::now();
        let mut command = build_workflow_compose_codex_command(
            &codex_bin,
            &job_path,
            &image_paths,
            prompt.trim(),
            &source_names,
            &codex_options,
            autonomy,
            true,
        );
        let mut run = run_codex_with_progress(
            &mut command,
            GENERATION_TIMEOUT,
            app.clone(),
            run_id.clone(),
        )
        .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;

        if !run.output.status.success() && output_mentions_unsupported_json(&run.output) {
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
                &codex_options,
                autonomy,
                false,
            );
            run = run_codex_with_progress(
                &mut fallback,
                GENERATION_TIMEOUT,
                app.clone(),
                run_id.clone(),
            )
            .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;
        }

        if !run.output.status.success() {
            if let Some(message) = final_codex_agent_message(&run.output) {
                return Err(format!("Codex did not compose an image.\n\n{message}"));
            }
            return Err(command_failure("Codex workflow composition", &run.output));
        }

        let Some((recovered_source_path, staged_result_path)) =
            copy_codex_cached_png_to_job(&job_path, run.thread_id.as_deref(), codex_started_at)?
        else {
            if let Some(message) = final_codex_agent_message(&run.output) {
                return Err(format!(
                    "Codex did not expose a composed image in its generated-images cache.\n\n{message}"
                ));
            }
            return Err("PaintNode could not find a composed PNG in Codex's generated-images cache.".into());
        };

        emit_codex_progress(&app, &run_id, "Reading composed PNG");
        if !staged_result_path.exists() {
            if let Some(message) = final_codex_agent_message(&run.output) {
                return Err(format!(
                    "Codex did not expose a composed image.\n\n{message}\n\nInternal copy path: {}",
                    staged_result_path.display()
                ));
            }
            return Err(format!(
                "PaintNode could not find a composed PNG at {}.",
                staged_result_path.display()
            ));
        }

        let data_url = read_png_data_url(&staged_result_path)?;
        let asset = if let Some(project_dir) = project_dir {
            emit_codex_progress(&app, &run_id, "Saving composed image to the project");
            let bytes = fs::read(&staged_result_path)
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
                    .file_name()
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
            cleanup_project_agent_job(&job_path);
        }

        emit_codex_progress(&app, &run_id, "Done");
        let assets = asset.iter().cloned().collect();
        Ok(GeneratedImageResult {
            data_url,
            asset,
            assets,
            mask_data_url: None,
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

fn project_or_temp_job_path(
    app: &AppHandle,
    project_path: &Option<String>,
    prefix: &str,
    keep_job_dir: bool,
) -> Result<
    (
        Option<PathBuf>,
        Option<PathBuf>,
        PathBuf,
        bool,
        Option<TempJobDir>,
    ),
    String,
> {
    let project_dir = optional_project_dir(project_path);
    let job_project_dir = ai_job_project_dir(app, &project_dir, keep_job_dir)?;
    if let Some(job_project_dir) = &job_project_dir {
        let run_dir = project_agent_run_dir(job_project_dir, ANTIGRAVITY_RUNS_DIR, prefix)?;
        Ok((
            project_dir,
            Some(job_project_dir.clone()),
            run_dir,
            !keep_job_dir,
            None,
        ))
    } else {
        let temp_job = TempJobDir::new(&format!("paintnode-{prefix}"))?;
        let path = temp_job.path().to_path_buf();
        Ok((None, None, path, false, Some(temp_job)))
    }
}

fn run_antigravity(
    antigravity_bin: &str,
    workspace_path: &Path,
    job_path: &Path,
    prompt: &str,
    options: &AntigravityCommandOptions,
    new_project: bool,
    timeout: Duration,
    app: AppHandle,
    run_id: String,
    required_output: Option<&str>,
) -> Result<CodexRunResult, String> {
    let mut command = build_antigravity_command(
        antigravity_bin,
        workspace_path,
        job_path,
        prompt,
        options,
        new_project,
        true,
    );
    run_antigravity_with_progress(
        &mut command,
        timeout,
        app,
        run_id,
        workspace_path,
        job_path,
        required_output,
    )
    .map_err(|e| format!("Failed to run Antigravity at '{antigravity_bin}': {e}"))
}

#[tauri::command]
async fn generate_antigravity_image(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    keep_job_dir: Option<bool>,
    reference_pngs: Vec<WorkflowSourceImage>,
    run_id: String,
    model: Option<String>,
    approval_mode: Option<String>,
    autonomy_level: Option<String>,
    target_width: Option<u32>,
    target_height: Option<u32>,
) -> Result<GeneratedImageResult, String> {
    if prompt.trim().is_empty() {
        return Err("Enter a prompt.".into());
    }
    validate_reference_pngs(&reference_pngs, "Generate image")?;
    let target_dimensions = validate_optional_target_dimensions(target_width, target_height)?;

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let antigravity_bin = configured_or_default_antigravity_bin(bin)?;
        let options = antigravity_command_options(model, approval_mode);
        let autonomy = ai_autonomy_level(autonomy_level);
        let working = target_dimensions.map(ai_working_canvas_for_dimensions);
        let run_id = if run_id.trim().is_empty() {
            format!("antigravity-{}", now_id())
        } else {
            run_id
        };
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let (project_dir, job_project_dir, job_path, cleanup_project_job, _temp_job) =
            project_or_temp_job_path(&app, &project_path, "antigravity", keep_job_dir)?;
        let workspace_path = project_dir
            .as_ref()
            .map(PathBuf::as_path)
            .or_else(|| job_project_dir.as_ref().map(PathBuf::as_path))
            .unwrap_or(job_path.as_path())
            .to_path_buf();
        let new_antigravity_project = job_project_dir.is_none();
        let job_dir = antigravity_job_dir_label(&workspace_path, &job_path);
        let (_reference_paths, reference_names) =
            write_reference_pngs(&job_path, &reference_pngs, "Generate image")?;
        let prompt_text = antigravity_generate_prompt(
            prompt.trim(),
            &job_dir,
            autonomy,
            working.as_ref(),
            &reference_names,
        );
        write_ai_job_prompt(&job_path, &prompt_text, "Antigravity image generation")?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);

        emit_codex_progress(&app, &run_id, "Starting local Antigravity");
        let run = run_antigravity(
            &antigravity_bin,
            &workspace_path,
            &job_path,
            &prompt_text,
            &options,
            new_antigravity_project,
            GENERATION_TIMEOUT,
            app.clone(),
            run_id.clone(),
            Some("result.png"),
        )?;
        if !run.output.status.success() && !run.satisfied_required_output {
            return Err(command_failure_with_required_output(
                "Antigravity",
                &run.output,
                &job_path,
                "result.png",
            ));
        }

        let result_path = job_path.join("result.png");
        emit_codex_progress(&app, &run_id, "Reading Antigravity result");
        let (bytes, result_dimensions, normalized_result) = if let Some(working) = &working {
            read_png_bytes_cropped_to_ai_working_canvas(
                &result_path,
                working,
                "Antigravity generated image",
            )?
        } else {
            let bytes = fs::read(&result_path)
                .map_err(|e| format!("Failed to read Antigravity image: {e}"))?;
            let dimensions = png_dimensions_from_bytes(&bytes)
                .ok_or_else(|| "Antigravity image PNG dimensions are invalid.".to_string())?;
            (bytes, dimensions, false)
        };
        if normalized_result {
            if let Some(working) = &working {
                emit_codex_progress(
                    &app,
                    &run_id,
                    &format!(
                        "Normalized Antigravity result from {}x{} {} canvas to {}x{}",
                        result_dimensions.0,
                        result_dimensions.1,
                        working.aspect_label,
                        working.original_dimensions.0,
                        working.original_dimensions.1
                    ),
                );
            }
        }
        let data_url = png_data_url(&bytes)?;
        let asset = if let Some(project_dir) = project_dir {
            emit_codex_progress(&app, &run_id, "Saving Antigravity image to the project");
            let (id, relative_path) =
                write_asset_file(&project_dir, "generated", prompt.trim(), "png", &bytes)?;
            Some(add_asset(
                &project_dir,
                ProjectAsset {
                    id,
                    kind: "generated".into(),
                    name: prompt.trim().chars().take(48).collect::<String>(),
                    relative_path,
                    created_at: now_id(),
                    prompt: Some(prompt.trim().into()),
                    source_file_name: Some("result.png".into()),
                    width: None,
                    height: None,
                    mime: Some("image/png".into()),
                },
            )?)
        } else {
            None
        };
        if cleanup_project_job {
            cleanup_project_agent_job(&job_path);
        }
        emit_codex_progress(&app, &run_id, "Done");
        let assets = asset.iter().cloned().collect();
        Ok(GeneratedImageResult {
            data_url,
            asset,
            assets,
            mask_data_url: None,
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
async fn generate_antigravity_fill_image(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    keep_job_dir: Option<bool>,
    store_asset: Option<bool>,
    source_png: Vec<u8>,
    edit_target_png: Vec<u8>,
    mask_png: Vec<u8>,
    reference_pngs: Vec<WorkflowSourceImage>,
    run_id: String,
    model: Option<String>,
    approval_mode: Option<String>,
    autonomy_level: Option<String>,
) -> Result<GeneratedImageResult, String> {
    if prompt.trim().is_empty() {
        return Err("Enter a generative fill prompt.".into());
    }
    if !is_png(&source_png) || !is_png(&edit_target_png) || !is_png(&mask_png) {
        return Err("Generative fill inputs must be PNG images.".into());
    }
    validate_reference_pngs(&reference_pngs, "Generative fill")?;
    let source_dimensions = png_dimensions_from_bytes(&source_png)
        .ok_or_else(|| "Generative fill source PNG dimensions are invalid.".to_string())?;
    let target_dimensions = png_dimensions_from_bytes(&edit_target_png)
        .ok_or_else(|| "Generative fill edit target PNG dimensions are invalid.".to_string())?;
    let mask_dimensions = png_dimensions_from_bytes(&mask_png)
        .ok_or_else(|| "Generative fill mask PNG dimensions are invalid.".to_string())?;
    if target_dimensions != source_dimensions || mask_dimensions != source_dimensions {
        return Err(
            "Generative fill source, edit target, and mask must have identical dimensions.".into(),
        );
    }
    let working = ai_working_canvas_for_dimensions(source_dimensions);

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let antigravity_bin = configured_or_default_antigravity_bin(bin)?;
        let options = antigravity_command_options(model, approval_mode);
        let autonomy = ai_autonomy_level(autonomy_level);
        let run_id = if run_id.trim().is_empty() {
            format!("antigravity-fill-{}", now_id())
        } else {
            run_id
        };
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let (project_dir, job_project_dir, job_path, cleanup_project_job, _temp_job) =
            project_or_temp_job_path(&app, &project_path, "antigravity-fill", keep_job_dir)?;
        let store_asset = store_asset.unwrap_or(true);
        let workspace_path = project_dir
            .as_ref()
            .map(PathBuf::as_path)
            .or_else(|| job_project_dir.as_ref().map(PathBuf::as_path))
            .unwrap_or(job_path.as_path())
            .to_path_buf();
        let new_antigravity_project = job_project_dir.is_none();
        let job_dir = antigravity_job_dir_label(&workspace_path, &job_path);
        let working_source_png = pad_png_to_ai_working_canvas(
            &source_png,
            &working,
            "generative fill source image",
            ai_chroma_key_pixel(),
        )?;
        let working_edit_target_png = pad_png_to_ai_working_canvas(
            &edit_target_png,
            &working,
            "generative fill edit target image",
            ai_chroma_key_pixel(),
        )?;
        let working_mask_png = pad_png_to_ai_working_canvas(
            &mask_png,
            &working,
            "generative fill mask image",
            ai_mask_padding_pixel(),
        )?;
        fs::write(job_path.join("source.png"), &working_source_png)
            .map_err(|e| format!("Failed to write generative fill source image: {e}"))?;
        fs::write(job_path.join("edit_target.png"), &working_edit_target_png)
            .map_err(|e| format!("Failed to write generative fill edit target image: {e}"))?;
        fs::write(job_path.join("mask.png"), &working_mask_png)
            .map_err(|e| format!("Failed to write generative fill mask image: {e}"))?;
        let (_reference_paths, reference_names) =
            write_reference_pngs(&job_path, &reference_pngs, "Generative fill")?;
        let prompt_text = antigravity_fill_prompt(
            prompt.trim(),
            &job_dir,
            autonomy,
            &working,
            &reference_names,
        );
        write_ai_job_prompt(&job_path, &prompt_text, "Antigravity generative fill")?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);

        emit_codex_progress(&app, &run_id, "Starting local Antigravity generative fill");
        let run = run_antigravity(
            &antigravity_bin,
            &workspace_path,
            &job_path,
            &prompt_text,
            &options,
            new_antigravity_project,
            GENERATION_TIMEOUT,
            app.clone(),
            run_id.clone(),
            Some("result.png"),
        )?;
        if !run.output.status.success() && !run.satisfied_required_output {
            return Err(command_failure_with_required_output(
                "Antigravity generative fill",
                &run.output,
                &job_path,
                "result.png",
            ));
        }
        let result_path = job_path.join("result.png");
        let (bytes, result_dimensions, normalized_result) =
            read_png_bytes_cropped_to_ai_working_canvas(
                &result_path,
                &working,
                "Antigravity generative fill",
            )?;
        if normalized_result {
            emit_codex_progress(
                &app,
                &run_id,
                &format!(
                    "Normalized Antigravity fill from {}x{} {} canvas to {}x{}",
                    result_dimensions.0,
                    result_dimensions.1,
                    working.aspect_label,
                    source_dimensions.0,
                    source_dimensions.1
                ),
            );
        }
        let data_url = png_data_url(&bytes)?;
        let asset = if store_asset {
            if let Some(project_dir) = project_dir {
                let (id, relative_path) =
                    write_asset_file(&project_dir, "generated", prompt.trim(), "png", &bytes)?;
                Some(add_asset(
                    &project_dir,
                    ProjectAsset {
                        id,
                        kind: "generated".into(),
                        name: prompt.trim().chars().take(48).collect::<String>(),
                        relative_path,
                        created_at: now_id(),
                        prompt: Some(prompt.trim().into()),
                        source_file_name: Some("result.png".into()),
                        width: None,
                        height: None,
                        mime: Some("image/png".into()),
                    },
                )?)
            } else {
                None
            }
        } else {
            None
        };
        if cleanup_project_job {
            cleanup_project_agent_job(&job_path);
        }
        emit_codex_progress(&app, &run_id, "Done");
        let assets = asset.iter().cloned().collect();
        Ok(GeneratedImageResult {
            data_url,
            asset,
            assets,
            mask_data_url: None,
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
async fn generate_antigravity_retouch_image(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    keep_job_dir: Option<bool>,
    source_png: Vec<u8>,
    edit_target_png: Vec<u8>,
    mask_png: Vec<u8>,
    annotated_source_png: Option<Vec<u8>>,
    reference_png: Option<Vec<u8>>,
    reference_pngs: Vec<WorkflowSourceImage>,
    run_id: String,
    model: Option<String>,
    approval_mode: Option<String>,
    autonomy_level: Option<String>,
) -> Result<GeneratedImageResult, String> {
    if prompt.trim().is_empty() {
        return Err("Enter an AI retouch prompt.".into());
    }
    if !is_png(&source_png) || !is_png(&edit_target_png) || !is_png(&mask_png) {
        return Err("AI retouch inputs must be PNG images.".into());
    }
    validate_reference_pngs(&reference_pngs, "AI retouch")?;
    let source_dimensions = png_dimensions_from_bytes(&source_png)
        .ok_or_else(|| "AI retouch source PNG dimensions are invalid.".to_string())?;
    let target_dimensions = png_dimensions_from_bytes(&edit_target_png)
        .ok_or_else(|| "AI retouch edit target PNG dimensions are invalid.".to_string())?;
    let mask_dimensions = png_dimensions_from_bytes(&mask_png)
        .ok_or_else(|| "AI retouch mask PNG dimensions are invalid.".to_string())?;
    if target_dimensions != source_dimensions || mask_dimensions != source_dimensions {
        return Err(
            "AI retouch source, edit target, and mask must have identical dimensions.".into(),
        );
    }
    let working = ai_working_canvas_for_dimensions(source_dimensions);

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let antigravity_bin = configured_or_default_antigravity_bin(bin)?;
        let options = antigravity_command_options(model, approval_mode);
        let autonomy = ai_autonomy_level(autonomy_level);
        let run_id = if run_id.trim().is_empty() {
            format!("antigravity-retouch-{}", now_id())
        } else {
            run_id
        };
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let (project_dir, job_project_dir, job_path, cleanup_project_job, _temp_job) =
            project_or_temp_job_path(&app, &project_path, "antigravity-retouch", keep_job_dir)?;
        let workspace_path = project_dir
            .as_ref()
            .map(PathBuf::as_path)
            .or_else(|| job_project_dir.as_ref().map(PathBuf::as_path))
            .unwrap_or(job_path.as_path())
            .to_path_buf();
        let new_antigravity_project = job_project_dir.is_none();
        let job_dir = antigravity_job_dir_label(&workspace_path, &job_path);
        let working_source_png = pad_png_to_ai_working_canvas(
            &source_png,
            &working,
            "AI retouch source image",
            ai_chroma_key_pixel(),
        )?;
        let working_edit_target_png = pad_png_to_ai_working_canvas(
            &edit_target_png,
            &working,
            "AI retouch edit target image",
            ai_chroma_key_pixel(),
        )?;
        let working_mask_png = pad_png_to_ai_working_canvas(
            &mask_png,
            &working,
            "AI retouch mask image",
            ai_mask_padding_pixel(),
        )?;
        fs::write(job_path.join("source.png"), &working_source_png)
            .map_err(|e| format!("Failed to write AI retouch source image: {e}"))?;
        fs::write(job_path.join("edit_target.png"), &working_edit_target_png)
            .map_err(|e| format!("Failed to write AI retouch edit target image: {e}"))?;
        fs::write(job_path.join("mask.png"), &working_mask_png)
            .map_err(|e| format!("Failed to write AI retouch mask image: {e}"))?;
        fs::write(
            job_path.join("paintnode_contract.txt"),
            antigravity_retouch_contract_text(&job_dir, autonomy, &working),
        )
        .map_err(|e| format!("Failed to write AI retouch PaintNode contract: {e}"))?;
        let has_annotated_source = if let Some(annotated_source_png) = &annotated_source_png {
            let working_annotated_source_png = pad_png_to_ai_working_canvas(
                annotated_source_png,
                &working,
                "AI retouch annotated source image",
                ai_chroma_key_pixel(),
            )?;
            fs::write(
                job_path.join("annotated_source.png"),
                working_annotated_source_png,
            )
            .map_err(|e| format!("Failed to write AI retouch annotated source image: {e}"))?;
            true
        } else {
            false
        };
        let has_reference = if let Some(reference_png) = &reference_png {
            fs::write(job_path.join("reference.png"), reference_png)
                .map_err(|e| format!("Failed to write AI retouch reference image: {e}"))?;
            true
        } else {
            false
        };
        let (_reference_paths, reference_names) =
            write_reference_pngs(&job_path, &reference_pngs, "AI retouch")?;
        let prompt_text = antigravity_retouch_prompt(
            prompt.trim(),
            has_annotated_source,
            has_reference,
            &reference_names,
            &job_dir,
            autonomy,
            &working,
        );
        write_ai_job_prompt(&job_path, &prompt_text, "Antigravity AI retouch")?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);

        emit_codex_progress(&app, &run_id, "Starting local Antigravity AI retouch");
        let run = run_antigravity(
            &antigravity_bin,
            &workspace_path,
            &job_path,
            &prompt_text,
            &options,
            new_antigravity_project,
            GENERATION_TIMEOUT,
            app.clone(),
            run_id.clone(),
            Some("result.png"),
        )?;
        if !run.output.status.success() && !run.satisfied_required_output {
            return Err(command_failure_with_required_output(
                "Antigravity AI retouch",
                &run.output,
                &job_path,
                "result.png",
            ));
        }
        let result_path = job_path.join("result.png");
        emit_codex_progress(&app, &run_id, "Reading Antigravity AI retouch result");
        let (generated_bytes, result_dimensions, normalized_result) =
            read_png_bytes_cropped_to_ai_working_canvas(
                &result_path,
                &working,
                "AI retouch candidate",
            )?;
        if normalized_result {
            emit_codex_progress(
                &app,
                &run_id,
                &format!(
                    "Normalized Antigravity AI retouch from {}x{} {} canvas to {}x{}",
                    result_dimensions.0,
                    result_dimensions.1,
                    working.aspect_label,
                    source_dimensions.0,
                    source_dimensions.1
                ),
            );
        }
        emit_codex_progress(&app, &run_id, "Preparing editable AI retouch mask");
        let mask_data_url = Some(png_data_url(&ai_retouch_editable_mask_png(
            &source_png,
            &mask_png,
            AI_RETOUCH_OUTPUT_MASK_GROW_RADIUS,
            AI_RETOUCH_OUTPUT_MASK_FEATHER_RADIUS,
        )?)?);
        let data_url = png_data_url(&generated_bytes)?;
        let mut assets = Vec::new();
        let asset = if let Some(project_dir) = project_dir {
            emit_codex_progress(&app, &run_id, "Saving raw Antigravity AI retouch result");
            let raw_result_bytes = fs::read(&result_path).map_err(|e| {
                format!(
                    "Failed to read raw Antigravity AI retouch result at {}: {e}",
                    result_path.display()
                )
            })?;
            let primary_asset = store_generated_png_asset(
                &project_dir,
                &raw_result_bytes,
                ai_retouch_asset_name(prompt.trim(), Some("result.png")),
                Some(prompt.trim().into()),
                Some("result.png".into()),
            )?;
            assets.push(primary_asset.clone());
            Some(primary_asset)
        } else {
            None
        };
        if cleanup_project_job {
            cleanup_project_agent_job(&job_path);
        }
        emit_codex_progress(&app, &run_id, "Done");
        Ok(GeneratedImageResult {
            data_url,
            asset,
            assets,
            mask_data_url,
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
async fn decouple_antigravity_image(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    source_png: Vec<u8>,
    run_id: String,
    store_assets: Option<bool>,
    keep_job_dir: Option<bool>,
    model: Option<String>,
    approval_mode: Option<String>,
    autonomy_level: Option<String>,
) -> Result<DecoupleImageResult, String> {
    if !is_png(&source_png) {
        return Err("Asset extraction source must be a PNG image.".into());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<DecoupleImageResult, String> {
        let antigravity_bin = configured_or_default_antigravity_bin(bin)?;
        let options = antigravity_command_options(model, approval_mode);
        let _autonomy = ai_autonomy_level(autonomy_level);
        let run_id = if run_id.trim().is_empty() {
            format!("antigravity-decouple-{}", now_id())
        } else {
            run_id
        };
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let (project_dir, job_project_dir, job_path, cleanup_project_job, _temp_job) =
            project_or_temp_job_path(&app, &project_path, "antigravity-decouple", keep_job_dir)?;
        let workspace_path = project_dir
            .as_ref()
            .map(PathBuf::as_path)
            .or_else(|| job_project_dir.as_ref().map(PathBuf::as_path))
            .unwrap_or(job_path.as_path())
            .to_path_buf();
        let new_antigravity_project = job_project_dir.is_none();
        let job_dir = antigravity_job_dir_label(&workspace_path, &job_path);
        let store_assets = store_assets.unwrap_or(true);
        fs::write(job_path.join("source.png"), &source_png)
            .map_err(|e| format!("Failed to write decouple source image: {e}"))?;
        let user_prompt = if prompt.trim().is_empty() {
            "Identify the main reusable elements and create a useful recomposition asset pack."
        } else {
            prompt.trim()
        };
        let prompt_text = antigravity_decouple_prompt(user_prompt, &job_dir);
        write_ai_job_prompt(&job_path, &prompt_text, "Antigravity asset extraction")?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);

        emit_codex_progress(&app, &run_id, "Starting local Antigravity asset extraction");
        let run = run_antigravity(
            &antigravity_bin,
            &workspace_path,
            &job_path,
            &prompt_text,
            &options,
            new_antigravity_project,
            GENERATION_TIMEOUT,
            app.clone(),
            run_id.clone(),
            Some("manifest.json"),
        )?;
        if !run.output.status.success() {
            return Err(command_failure_with_required_output(
                "Antigravity asset extraction",
                &run.output,
                &job_path,
                "manifest.json",
            ));
        }
        let manifest_path = job_path.join("manifest.json");
        let manifest_text = fs::read_to_string(&manifest_path).map_err(|e| {
            format!(
                "Antigravity did not create manifest.json at {}: {e}",
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
            let name = if layer.name.trim().is_empty() {
                format!("Extracted Asset {}", index + 1)
            } else {
                layer.name.trim().chars().take(80).collect::<String>()
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
            let data_url = png_data_url(&bytes)?;
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
        if cleanup_project_job {
            cleanup_project_agent_job(&job_path);
        }
        emit_codex_progress(&app, &run_id, "Done");
        Ok(DecoupleImageResult {
            layers,
            thread_id: None,
            notes: manifest.notes,
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
async fn compose_antigravity_workflow(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    sources: Vec<WorkflowSourceImage>,
    run_id: String,
    keep_job_dir: Option<bool>,
    model: Option<String>,
    approval_mode: Option<String>,
    autonomy_level: Option<String>,
) -> Result<GeneratedImageResult, String> {
    if prompt.trim().is_empty() {
        return Err("Enter a composition prompt.".into());
    }
    if sources.is_empty() {
        return Err("Add at least one asset node before generating.".into());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let antigravity_bin = configured_or_default_antigravity_bin(bin)?;
        let options = antigravity_command_options(model, approval_mode);
        let autonomy = ai_autonomy_level(autonomy_level);
        let run_id = if run_id.trim().is_empty() {
            format!("antigravity-workflow-{}", now_id())
        } else {
            run_id
        };
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let (project_dir, job_project_dir, job_path, cleanup_project_job, _temp_job) =
            project_or_temp_job_path(&app, &project_path, "antigravity-workflow", keep_job_dir)?;
        let workspace_path = project_dir
            .as_ref()
            .map(PathBuf::as_path)
            .or_else(|| job_project_dir.as_ref().map(PathBuf::as_path))
            .unwrap_or(job_path.as_path())
            .to_path_buf();
        let new_antigravity_project = job_project_dir.is_none();
        let job_dir = antigravity_job_dir_label(&workspace_path, &job_path);
        let input_dir = job_path.join("inputs");
        fs::create_dir_all(&input_dir)
            .map_err(|e| format!("Failed to create workflow input folder: {e}"))?;
        let mut source_names = Vec::new();
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
            let path = input_dir.join(format!("{}-{}.png", index + 1, safe_stem(&name)));
            fs::write(&path, &source.bytes)
                .map_err(|e| format!("Failed to write workflow source image: {e}"))?;
            source_names.push(name);
        }
        let prompt_text =
            antigravity_workflow_prompt(prompt.trim(), &source_names, &job_dir, autonomy);
        write_ai_job_prompt(&job_path, &prompt_text, "Antigravity workflow composition")?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);

        emit_codex_progress(
            &app,
            &run_id,
            "Starting local Antigravity workflow composition",
        );
        let run = run_antigravity(
            &antigravity_bin,
            &workspace_path,
            &job_path,
            &prompt_text,
            &options,
            new_antigravity_project,
            GENERATION_TIMEOUT,
            app.clone(),
            run_id.clone(),
            Some("result.png"),
        )?;
        if !run.output.status.success() && !run.satisfied_required_output {
            return Err(command_failure_with_required_output(
                "Antigravity workflow composition",
                &run.output,
                &job_path,
                "result.png",
            ));
        }
        let result_path = job_path.join("result.png");
        let data_url = read_png_data_url(&result_path)?;
        let asset = if let Some(project_dir) = project_dir {
            let bytes = fs::read(&result_path).map_err(|e| {
                format!("Failed to read Antigravity composed image for project storage: {e}")
            })?;
            let (id, relative_path) =
                write_asset_file(&project_dir, "generated", prompt.trim(), "png", &bytes)?;
            Some(add_asset(
                &project_dir,
                ProjectAsset {
                    id,
                    kind: "generated".into(),
                    name: format!(
                        "Workflow: {}",
                        prompt.trim().chars().take(48).collect::<String>()
                    ),
                    relative_path,
                    created_at: now_id(),
                    prompt: Some(prompt.trim().into()),
                    source_file_name: Some("result.png".into()),
                    width: None,
                    height: None,
                    mime: Some("image/png".into()),
                },
            )?)
        } else {
            None
        };
        if cleanup_project_job {
            cleanup_project_agent_job(&job_path);
        }
        emit_codex_progress(&app, &run_id, "Done");
        let assets = asset.iter().cloned().collect();
        Ok(GeneratedImageResult {
            data_url,
            asset,
            assets,
            mask_data_url: None,
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
async fn project_open_folder(project_path: String) -> Result<ProjectState, String> {
    let path = PathBuf::from(project_path.trim());
    tauri::async_runtime::spawn_blocking(move || project_state(&path))
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
async fn read_dropped_file(path: String) -> Result<NativeDroppedFile, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<NativeDroppedFile, String> {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err("Dropped file path is empty.".into());
        }

        let path = PathBuf::from(trimmed);
        if !path.is_file() {
            return Err(format!("Dropped path is not a file: {}", path.display()));
        }

        let metadata = fs::metadata(&path).map_err(|e| {
            format!(
                "Failed to read dropped file metadata at {}: {e}",
                path.display()
            )
        })?;
        let modified_at = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let bytes = fs::read(&path)
            .map_err(|e| format!("Failed to read dropped file at {}: {e}", path.display()))?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("untitled")
            .to_string();

        Ok(NativeDroppedFile {
            path: path.to_string_lossy().to_string(),
            name,
            bytes,
            size: metadata.len(),
            modified_at,
            mime: mime_for_path(&path),
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
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
            let trash = project_dir
                .join(PAINTNODE_WORK_DIR)
                .join("trash")
                .join(format!(
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

fn build_app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let new = MenuItem::with_id(app, "app:new", "New...", true, Some("CmdOrCtrl+N"))?;
    let open = MenuItem::with_id(app, "app:open", "Open...", true, Some("CmdOrCtrl+O"))?;
    let close_document = MenuItem::with_id(
        app,
        "app:close-document",
        "Close Document",
        true,
        Some("CmdOrCtrl+W"),
    )?;
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
    let export_psd = MenuItem::with_id(app, "app:export-psd", "Export PSD...", true, None::<&str>)?;

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
    let free_transform = MenuItem::with_id(
        app,
        "app:free-transform",
        "Free Transform",
        true,
        Some("CmdOrCtrl+T"),
    )?;

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
    let about = MenuItem::with_id(app, "app:about", "About PaintNode", true, None::<&str>)?;
    let settings = MenuItem::with_id(
        app,
        "app:settings",
        "Settings...",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let app_check_updates = MenuItem::with_id(
        app,
        "app:check-updates",
        "Check for Updates...",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "app:quit", "Quit PaintNode", true, Some("CmdOrCtrl+Q"))?;

    let app_menu = Submenu::with_items(
        app,
        "PaintNode",
        true,
        &[
            &about,
            &settings,
            &app_check_updates,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

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
            &export_psd,
            &PredefinedMenuItem::separator(app)?,
            &close_document,
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
            &PredefinedMenuItem::separator(app)?,
            &free_transform,
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
    Menu::with_items(
        app,
        &[
            &app_menu, &file, &edit, &image, &layer, &select, &filter, &ai, &view,
        ],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PendingOpenPaths::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

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
            clipboard_read_text,
            clipboard_write_text,
            app_memory_info,
            generate_image,
            detect_codex,
            detect_antigravity,
            generate_codex_image,
            generate_codex_fill_image,
            generate_codex_retouch_image,
            decouple_codex_image,
            compose_codex_workflow,
            generate_antigravity_image,
            generate_antigravity_fill_image,
            generate_antigravity_retouch_image,
            decouple_antigravity_image,
            compose_antigravity_workflow,
            project_open_folder,
            project_refresh,
            project_store_asset_bytes,
            project_read_asset,
            project_reveal,
            project_reveal_file,
            project_read_file,
            read_dropped_file,
            take_pending_open_paths,
            quit_app,
            project_delete_asset,
            project_write_document,
            project_write_document_path,
            project_save_document_as
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let RunEvent::Opened { urls } = event {
                let paths = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect::<Vec<_>>();
                queue_native_open_paths(app, paths);
            }
        });
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

    fn test_rgba_png(width: u32, height: u32, pixels: &[[u8; 4]]) -> Vec<u8> {
        let image = image::RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba(pixels[(y * width + x) as usize])
        });
        encode_rgba_png(image, "test image").expect("test png")
    }

    fn png_dimensions_from_data_url(data_url: &str) -> (u32, u32) {
        let (_, b64) = data_url.split_once(',').expect("data url comma");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .expect("thumbnail base64");
        png_dimensions_from_bytes(&bytes).expect("thumbnail png dimensions")
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
    fn ai_retouch_editable_mask_png_grows_and_feathers_mask() {
        let source = test_rgba_png(7, 1, &[[0, 0, 0, 255]; 7]);
        let mask = test_rgba_png(
            7,
            1,
            &[
                [0, 0, 0, 0],
                [0, 0, 0, 0],
                [0, 0, 0, 0],
                [255, 255, 255, 255],
                [0, 0, 0, 0],
                [0, 0, 0, 0],
                [0, 0, 0, 0],
            ],
        );

        let result = ai_retouch_editable_mask_png(&source, &mask, 1, 1).expect("editable mask");
        let layer = decode_png_rgba(&result, "result").expect("decoded mask");

        assert_eq!(layer.get_pixel(3, 0).0[3], 255);
        assert!(layer.get_pixel(2, 0).0[3] > 0);
        assert!(layer.get_pixel(4, 0).0[3] > 0);
        assert_eq!(layer.get_pixel(0, 0).0[3], 0);
        assert_eq!(layer.get_pixel(6, 0).0[3], 0);
    }

    #[test]
    fn ai_retouch_editable_mask_png_rejects_size_mismatch() {
        let source = test_rgba_png(2, 1, &[[1, 2, 3, 255], [4, 5, 6, 255]]);
        let mask = test_rgba_png(1, 1, &[[255, 255, 255, 255]]);

        let err = ai_retouch_editable_mask_png(&source, &mask, 1, 1)
            .expect_err("size mismatch should fail");

        assert!(err.contains("Source is 2x1, mask is 1x1"));
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
    fn temp_job_dir_removes_directory_on_drop() {
        let path = {
            let job = TempJobDir::new("paintnode-test").expect("temp dir");
            let marker = job.path().join("marker.txt");
            fs::write(&marker, b"ok").expect("write marker");
            assert!(marker.exists());
            job.path().to_path_buf()
        };

        assert!(!path.exists());
    }

    #[test]
    fn codex_progress_message_maps_json_events() {
        let message = provider_progress_message(r#"{"type":"turn.started"}"#, false, "Codex")
            .expect("turn event should map to progress");
        assert_eq!(message, "Codex is working on the image");

        let message = provider_progress_message(
            r#"{"type":"item.started","item":{"type":"image_generation_call","name":"imagegen"}}"#,
            false,
            "Codex",
        )
        .expect("image event should map to progress");
        assert_eq!(message, "Generating image with Codex");

        let message = provider_progress_message(
            r#"{"type":"item.completed","item":{"type":"image_generation_call","name":"imagegen"}}"#,
            false,
            "Codex",
        )
        .expect("completed image event should map to progress");
        assert_eq!(
            message,
            "Image generation step completed; waiting for Codex"
        );

        let message = provider_progress_message(
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"I’ll keep this as a preview/cache generation only, so I won’t touch the workspace. I’m also phrasing the person as a clearly adult young woman."}}"#,
            false,
            "Codex",
        )
        .expect("agent message should map to progress");
        assert!(message.starts_with("Codex:"));
        assert!(message.contains("preview/cache generation"));
    }

    #[test]
    fn codex_progress_message_sanitizes_plain_text() {
        let message = provider_progress_message("  generating image\n", true, "Codex")
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
{"type":"item.completed","item":{"type":"agent_message","text":"Generated one raster PNG for PaintNode and kept it in Codex’s generated-images cache."}}"#;

        let message = final_codex_agent_message_from_text(stdout, "")
            .expect("should extract final agent message");
        assert!(message.starts_with("Generated one raster PNG"));
    }

    #[test]
    fn codex_command_applies_selected_model_effort_and_fast_mode() {
        let job = TempJobDir::new("paintnode-codex-options-test").expect("temp dir");
        for model in ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"] {
            let options = codex_command_options(
                Some(model.to_string()),
                Some("high".to_string()),
                Some("fast".to_string()),
            );
            let command = build_codex_command(
                "codex",
                job.path(),
                "make an image",
                &[],
                &[],
                &options,
                AiAutonomyLevel::Low,
                None,
                true,
            );
            let args = command
                .get_args()
                .map(|arg| arg.to_string_lossy().to_string())
                .collect::<Vec<_>>();

            let model_idx = args
                .iter()
                .position(|arg| arg == "-m")
                .expect("model flag should be present");
            assert_eq!(args[model_idx + 1], model);
            assert!(args.contains(&"model_reasoning_effort=\"high\"".to_string()));
            assert!(args.contains(&"service_tier=\"fast\"".to_string()));
            assert!(args.contains(&"features.fast_mode=true".to_string()));
        }
    }

    #[test]
    fn codex_generate_command_attaches_reference_images_before_prompt() {
        let job = TempJobDir::new("paintnode-codex-reference-test").expect("temp dir");
        let reference_paths = vec![job.path().join("references").join("reference-1-style.png")];
        let reference_names = vec!["references/reference-1-style.png".to_string()];
        let command = build_codex_command(
            "codex",
            job.path(),
            "make an image",
            &reference_paths,
            &reference_names,
            &CodexCommandOptions::default(),
            AiAutonomyLevel::Low,
            None,
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
        assert_eq!(args[image_idx + 1], reference_paths[0].to_string_lossy());
        assert_eq!(args[image_idx + 2], "--");
        assert!(args[image_idx + 3].contains("Additional user reference images"));
        assert!(args[image_idx + 3].contains("`references/reference-1-style.png`"));
    }

    #[test]
    fn generate_image_prompts_do_not_expose_canvas_geometry() {
        let working = ai_working_canvas_for_dimensions((1280, 800));
        let codex = codex_prompt("make an image", AiAutonomyLevel::Low, Some(&working), &[]);
        assert!(codex.contains("Use $imagegen to generate one raster PNG for PaintNode"));
        assert!(codex.contains("User image prompt:\nmake an image"));
        assert!(!codex.contains("1280x800"));
        assert!(!codex.contains("1296x864"));
        assert!(!codex.contains("Working PNG"));
        assert!(!codex.contains("Document rectangle"));
        assert!(!codex.contains("chroma"));
        assert!(!codex.contains("#00ff00"));

        let antigravity = antigravity_generate_prompt(
            "make an image",
            "paintnode/antigravity-runs/job-1",
            AiAutonomyLevel::Low,
            Some(&working),
            &[],
        );
        assert!(antigravity.contains("Generate one raster PNG for PaintNode"));
        assert!(antigravity.contains("User image prompt:\nmake an image"));
        assert!(!antigravity.contains("1280x800"));
        assert!(!antigravity.contains("1296x864"));
        assert!(!antigravity.contains("Working PNG"));
        assert!(!antigravity.contains("Document rectangle"));
        assert!(!antigravity.contains("chroma"));
        assert!(!antigravity.contains("#00ff00"));
    }

    #[test]
    fn antigravity_command_applies_model_and_skip_permission_options() {
        let job = TempJobDir::new("paintnode-antigravity-options-test").expect("temp dir");
        let options = antigravity_command_options(
            Some("Gemini 3.5 Flash (High)".to_string()),
            Some("skipPermissions".to_string()),
        );
        let command = build_antigravity_command(
            "agy",
            job.path(),
            job.path(),
            "make an image",
            &options,
            true,
            true,
        );
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert_eq!(command.get_current_dir(), Some(job.path()));
        assert!(args.contains(&"--new-project".to_string()));
        let add_dir_idx = args
            .iter()
            .position(|arg| arg == "--add-dir")
            .expect("Antigravity workspace dir flag should be present");
        assert_eq!(
            args[add_dir_idx + 1],
            job.path().to_string_lossy().to_string()
        );
        assert!(args.contains(&"--dangerously-skip-permissions".to_string()));
        let model_idx = args
            .iter()
            .position(|arg| arg == "--model")
            .expect("model flag should be present");
        assert_eq!(args[model_idx + 1], "Gemini 3.5 Flash (High)");
        assert!(args.contains(&"-p".to_string()));
    }

    #[test]
    fn antigravity_auto_model_omits_model_flag() {
        let job = TempJobDir::new("paintnode-antigravity-auto-test").expect("temp dir");
        let options =
            antigravity_command_options(Some("auto".to_string()), Some("default".to_string()));
        let command = build_antigravity_command(
            "agy",
            job.path(),
            job.path(),
            "make an image",
            &options,
            true,
            false,
        );
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert_eq!(command.get_current_dir(), Some(job.path()));
        assert!(args.contains(&"--new-project".to_string()));
        assert!(args.contains(&"--add-dir".to_string()));
        assert!(!args.contains(&"--model".to_string()));
        assert!(!args.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(args.contains(&"-p".to_string()));
    }

    #[test]
    fn antigravity_project_runs_use_project_root_without_new_project() {
        let project = TempJobDir::new("paintnode-antigravity-project-test").expect("project dir");
        let job_path = project
            .path()
            .join(PAINTNODE_WORK_DIR)
            .join(ANTIGRAVITY_RUNS_DIR)
            .join("antigravity-test");
        fs::create_dir_all(&job_path).expect("job dir");
        let options = antigravity_command_options(None, Some("skipPermissions".to_string()));
        let command = build_antigravity_command(
            "agy",
            project.path(),
            &job_path,
            "make an image",
            &options,
            false,
            false,
        );
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();

        assert_eq!(command.get_current_dir(), Some(project.path()));
        assert!(!args.contains(&"--new-project".to_string()));
        let add_dir_idx = args
            .iter()
            .position(|arg| arg == "--add-dir")
            .expect("Antigravity job dir flag should be present");
        assert_eq!(
            args[add_dir_idx + 1],
            job_path.to_string_lossy().to_string()
        );
    }

    #[test]
    fn project_agent_job_paths_are_visible_and_vendor_specific() {
        let project = TempJobDir::new("paintnode-visible-agent-job-test").expect("project dir");
        let codex_job = project_agent_run_dir(project.path(), CODEX_RUNS_DIR, "codex-retouch")
            .expect("codex job");
        let antigravity_job =
            project_agent_run_dir(project.path(), ANTIGRAVITY_RUNS_DIR, "antigravity-retouch")
                .expect("antigravity job");

        for (job_path, vendor_dir) in [
            (codex_job.as_path(), CODEX_RUNS_DIR),
            (antigravity_job.as_path(), ANTIGRAVITY_RUNS_DIR),
        ] {
            let relative = job_path
                .strip_prefix(project.path())
                .expect("relative job path");
            let mut components = relative.components();
            let first_component = components.next().expect("work dir component");
            let first_name = first_component.as_os_str().to_string_lossy();
            let second_component = components.next().expect("vendor dir component");
            let second_name = second_component.as_os_str().to_string_lossy();

            assert_eq!(first_name, PAINTNODE_WORK_DIR);
            assert!(!first_name.starts_with('.'));
            assert_eq!(second_name, vendor_dir);
            assert!(!second_name.starts_with('.'));
        }
    }

    #[test]
    fn project_job_helpers_trim_paths_and_respect_keep_flag() {
        let project = Some("  /tmp/PaintNode Project  ".to_string());
        assert_eq!(
            optional_project_dir(&project),
            Some(PathBuf::from("/tmp/PaintNode Project"))
        );
        assert!(optional_project_dir(&Some("   ".to_string())).is_none());
        assert!(optional_project_dir(&None).is_none());

        let project_dir = Some(PathBuf::from("/tmp/PaintNode Project"));
        assert!(cleanup_project_job_enabled(&project_dir, false));
        assert!(!cleanup_project_job_enabled(&project_dir, true));
        assert!(!cleanup_project_job_enabled(&None, false));
    }

    #[test]
    fn antigravity_prompts_require_result_file_without_codex_cache_contract() {
        let working = ai_working_canvas_for_dimensions((1280, 800));
        let retouch = antigravity_retouch_prompt(
            "remove glare",
            false,
            false,
            &[],
            "paintnode/antigravity-runs/job-1",
            AiAutonomyLevel::Low,
            &working,
        );
        assert!(retouch.contains("result.png"));
        assert!(retouch.contains("paintnode/antigravity-runs/job-1/source.png"));
        assert!(retouch.contains("paintnode/antigravity-runs/job-1/edit_target.png"));
        assert!(retouch.contains("paintnode/antigravity-runs/job-1/mask.png"));
        assert!(retouch.contains("paintnode/antigravity-runs/job-1/paintnode_contract.txt"));
        assert!(retouch.contains("PaintNode image geometry"));
        assert!(retouch.contains("Keep the final PNG exactly 1296x864"));
        assert!(retouch.contains("left=8px, top=32px, right=8px, bottom=32px"));
        assert!(retouch.contains("flat PaintNode chroma-key matte: #00ff00"));
        assert!(retouch.contains("not a green-screen/key-removal request"));
        assert!(retouch.contains("Keep every matte pixel exactly #00ff00"));
        assert!(retouch
            .contains("Black or transparent pixels are protected context and are not editable"));
        assert!(!retouch.contains("PaintNode will crop"));
        assert!(!retouch.contains("image-generation tool accepts the aspect ratio"));
        assert!(retouch.contains("Do not write or run Python"));
        assert!(retouch.contains("maximum allowed edit area"));
        assert!(retouch.contains(
            "every newly generated, removed, replaced, reconstructed, relit, recolored, cleaned, extended, blended, shadowed, reflected, or otherwise changed visible pixel inside the white/gray mask footprint"
        ));
        assert!(retouch.contains("visible change extends outside the mask is a failed retouch"));
        assert!(retouch.contains("preserve the person's identity, face, hair, skin, hands"));
        assert!(retouch.contains("all unrequested surrounding content"));
        assert!(!retouch.contains("nearby bag"));
        assert!(!retouch.contains("seat, window"));
        assert!(!retouch.contains("Codex's generated-images cache"));
        assert!(!retouch.contains("Use $imagegen"));
        assert!(!retouch.contains(
            "Do not create, edit, copy, verify, or delete files in the working directory"
        ));

        let contract = antigravity_retouch_contract_text(
            "paintnode/antigravity-runs/job-1",
            AiAutonomyLevel::Low,
            &working,
        );
        assert!(contract.contains("Crop the centered content rectangle"));
        assert!(contract.contains("Restore protected black-mask pixels"));
        assert!(contract.contains("Do not run Python, OpenCV, Pillow"));
        assert!(contract.contains("Do not keep working after"));

        let unmanaged_contract = antigravity_retouch_contract_text(
            "paintnode/antigravity-runs/job-1",
            AiAutonomyLevel::Unmanaged,
            &working,
        );
        assert!(unmanaged_contract.contains("Crop the centered content rectangle"));
        assert!(!unmanaged_contract.contains("Do not run Python, OpenCV, Pillow"));
        assert!(!unmanaged_contract.contains("Do not keep working after"));

        let workflow = antigravity_workflow_prompt(
            "compose scene",
            &["asset".to_string()],
            "paintnode/antigravity-runs/job-2",
            AiAutonomyLevel::Low,
        );
        assert!(workflow.contains("result.png"));
        assert!(workflow.contains("paintnode/antigravity-runs/job-2/inputs/"));
        assert!(!workflow.contains("Codex's generated-images cache"));
        assert!(!workflow.contains("Do not create, edit, or delete files in the working directory"));
    }

    #[test]
    fn unmanaged_autonomy_prompts_omit_method_guardrails() {
        let working = ai_working_canvas_for_dimensions((1280, 800));
        let prompt = codex_prompt(
            "make an image",
            AiAutonomyLevel::Unmanaged,
            Some(&working),
            &[],
        );
        assert!(prompt.contains("Autonomy level: Unmanaged"));
        assert!(prompt.contains("Use $imagegen"));
        assert!(prompt.contains("normal Codex image-generation flow"));
        assert!(!prompt.contains("PaintNode image geometry"));
        assert!(!prompt.contains("Working PNG"));
        assert!(!prompt.contains("Document rectangle"));
        assert!(!prompt.contains("chroma"));
        assert!(!prompt.contains("Do not create, edit, or delete files in the working directory"));
        assert!(!prompt.contains("Do not write or run Python"));

        let retouch = ai_retouch_prompt(
            "remove glare",
            false,
            false,
            &[],
            AiAutonomyLevel::Unmanaged,
            &working,
        );
        assert!(retouch.contains("Autonomy level: Unmanaged"));
        assert!(retouch.contains("Use $imagegen"));
        assert!(retouch.contains("normal Codex image-generation flow"));
        assert!(!retouch.contains("Do not create, edit, copy, verify, or delete files"));
        assert!(!retouch.contains("write helper scripts"));

        let fill =
            generative_fill_prompt("extend photo", AiAutonomyLevel::Unmanaged, &working, &[]);
        assert!(fill.contains("Autonomy level: Unmanaged"));
        assert!(fill.contains("Use $imagegen"));
        assert!(fill.contains("normal Codex image-generation flow"));
        assert!(!fill.contains("Do not create, edit, or delete files"));
    }

    #[test]
    fn decouple_codex_command_delimits_image_args_before_prompt() {
        let job = TempJobDir::new("paintnode-decouple-command-test").expect("temp dir");
        let command = build_decouple_codex_command(
            "codex",
            job.path(),
            "separate objects",
            &CodexCommandOptions::default(),
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
        assert!(prompt.contains("PaintNode accepts only `#00ff00`"));
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
        let job = TempJobDir::new("paintnode-workflow-command-test").expect("temp dir");
        let image_paths = vec![job.path().join("girl.png"), job.path().join("truck.png")];
        let names = vec!["girl".to_string(), "truck".to_string()];
        let command = build_workflow_compose_codex_command(
            "codex",
            job.path(),
            &image_paths,
            "compose scene",
            &names,
            &CodexCommandOptions::default(),
            AiAutonomyLevel::Low,
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
    fn generative_fill_command_attaches_source_and_mask_before_prompt() {
        let job = TempJobDir::new("paintnode-fill-command-test").expect("temp dir");
        let working = ai_working_canvas_for_dimensions((1280, 800));
        let reference_paths = vec![job.path().join("references").join("reference-1-style.png")];
        let reference_names = vec!["references/reference-1-style.png".to_string()];
        let command = build_generative_fill_codex_command(
            "codex",
            job.path(),
            "extend photo",
            &reference_paths,
            &reference_names,
            &CodexCommandOptions::default(),
            AiAutonomyLevel::Low,
            &working,
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
        assert_eq!(
            args[image_idx + 1],
            job.path().join("source.png").to_string_lossy()
        );
        assert_eq!(
            args[image_idx + 2],
            job.path().join("edit_target.png").to_string_lossy()
        );
        assert_eq!(
            args[image_idx + 3],
            job.path().join("mask.png").to_string_lossy()
        );
        assert_eq!(args[image_idx + 4], reference_paths[0].to_string_lossy());
        assert_eq!(args[image_idx + 5], "--");
        assert!(args[image_idx + 6].contains("Use the centered content rectangle"));
        assert!(args[image_idx + 6].contains("Keep the final PNG exactly 1296x864"));
        assert!(args[image_idx + 6].contains("left=8px, top=32px, right=8px, bottom=32px"));
        assert!(args[image_idx + 6].contains("not a green-screen/key-removal request"));
        assert!(args[image_idx + 6].contains("leave those matte pixels exactly `#00ff00`"));
        assert!(args[image_idx + 6]
            .contains("Black or transparent pixels are protected context and are not editable"));
        assert!(!args[image_idx + 6].contains("PaintNode will crop"));
        assert!(args[image_idx + 6].contains("Save the final PNG as `result.png`"));
        assert!(args[image_idx + 6].contains("White pixels are the full editable/generated area"));
        assert!(
            args[image_idx + 6].contains("Gray pixels are a narrow seam-blending transition zone")
        );
        assert!(args[image_idx + 6].contains("`references/reference-1-style.png`"));
        assert!(args[image_idx + 6].contains("User edit prompt:\nextend photo"));
    }

    #[test]
    fn ai_retouch_command_attaches_optional_guidance_before_reference() {
        let job = TempJobDir::new("paintnode-retouch-command-test").expect("temp dir");
        let working = ai_working_canvas_for_dimensions((1280, 800));
        let command = build_ai_retouch_codex_command(
            "codex",
            job.path(),
            "remove glare",
            true,
            true,
            &[],
            &[],
            &CodexCommandOptions::default(),
            AiAutonomyLevel::Low,
            &working,
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
        assert_eq!(
            args[image_idx + 1],
            job.path().join("source.png").to_string_lossy()
        );
        assert_eq!(
            args[image_idx + 2],
            job.path().join("edit_target.png").to_string_lossy()
        );
        assert_eq!(
            args[image_idx + 3],
            job.path().join("mask.png").to_string_lossy()
        );
        assert_eq!(
            args[image_idx + 4],
            job.path().join("annotated_source.png").to_string_lossy()
        );
        assert_eq!(
            args[image_idx + 5],
            job.path().join("reference.png").to_string_lossy()
        );
        assert_eq!(args[image_idx + 6], "--");
        assert!(args[image_idx + 7].contains("Use $imagegen to perform one AI retouch edit"));
        assert!(args[image_idx + 7].contains("flat PaintNode chroma-key matte: #00ff00"));
        assert!(args[image_idx + 7].contains("Keep the final PNG exactly 1296x864"));
        assert!(args[image_idx + 7].contains("left=8px, top=32px, right=8px, bottom=32px"));
        assert!(args[image_idx + 7].contains("not a green-screen/key-removal request"));
        assert!(args[image_idx + 7].contains("leave those matte pixels exactly `#00ff00`"));
        assert!(args[image_idx + 7]
            .contains("Black or transparent pixels are protected context and are not editable"));
        assert!(!args[image_idx + 7].contains("PaintNode will crop"));
        assert!(!args[image_idx + 7].contains("Do not fill those margins with train"));
        assert!(args[image_idx + 7].contains("`annotated_source.png` is the clean source image"));
        assert!(args[image_idx + 7].contains("arrows, labels, and callout positions as guidance"));
        assert!(args[image_idx + 7].contains("red arrows, yellow callout boxes, annotation text"));
        assert!(args[image_idx + 7].contains("User retouch prompt:\nremove glare"));
        assert!(args[image_idx + 7].contains("PaintNode will apply `mask.png` after you finish"));
        assert!(args[image_idx + 7].contains(
            "visually identical to `source.png` everywhere `mask.png` is black or transparent"
        ));
        assert!(args[image_idx + 7].contains("Do not clean up, enhance, crop out, remove"));
        assert!(args[image_idx + 7].contains("maximum allowed edit area"));
        assert!(args[image_idx + 7].contains(
            "every newly generated, removed, replaced, reconstructed, relit, recolored, cleaned, extended, blended, shadowed, reflected, or otherwise changed visible pixel inside the white/gray mask footprint"
        ));
        assert!(args[image_idx + 7]
            .contains("visible change extends outside the mask is a failed retouch"));
        assert!(
            args[image_idx + 7].contains("preserve the person's identity, face, hair, skin, hands")
        );
        assert!(args[image_idx + 7].contains("all unrequested surrounding content"));
        assert!(!args[image_idx + 7].contains("nearby bag"));
        assert!(!args[image_idx + 7].contains("seat, window"));
        assert!(args[image_idx + 7].contains("Those are deterministic PaintNode responsibilities"));
        assert!(args[image_idx + 7].contains("generated image in Codex's generated-images cache"));
        assert!(!args[image_idx + 7].contains("Save the final exact-size PNG as `result.png`"));
    }

    #[test]
    fn ai_retouch_exact_ratio_prompt_avoids_padding_geometry() {
        let working = ai_codex_working_canvas_for_dimensions((1280, 800));
        assert_eq!(working.aspect_label, "codex");
        assert_eq!(working.working_dimensions, (1280, 800));
        assert!(!working.has_padding());

        let prompt = ai_retouch_prompt(
            "remove glare",
            false,
            false,
            &[],
            AiAutonomyLevel::Low,
            &working,
        );

        assert!(prompt.contains("Use $imagegen to perform one in-place PaintNode retouch"));
        assert!(prompt.contains(
            "This is a fixed-canvas image editing task, not a new image generation task"
        ));
        assert!(prompt.contains("Critical registration rule"));
        assert!(prompt
            .contains("identify the actual stable registration anchors from the visible pixels"));
        assert!(prompt.contains(
            "include only those image-specific anchors you observed from the attached inputs"
        ));
        assert!(!prompt.contains("The following anchors must remain in the same pixel positions"));
        assert!(!prompt.contains("window frame"));
        assert!(!prompt.contains("train seat"));
        assert!(!prompt.contains("subject eye position"));
        assert!(!prompt.contains("nearby bag"));
        assert!(prompt
            .contains("Return one full-canvas PNG candidate with the same dimensions and framing"));
        assert!(prompt.contains("Do not translate, shift, crop, zoom, rotate"));
        assert!(prompt.contains("User retouch prompt:\nremove glare"));
        assert!(!prompt.contains("PaintNode image geometry:\n- Working PNG"));
        assert!(!prompt.contains("Document rectangle: x="));
        assert!(!prompt.contains("chroma"));
        assert!(!prompt.contains("#00ff00"));
        assert!(!prompt.contains("1280x800"));
        assert!(!prompt.contains("No annotated source guide"));
        assert!(!prompt.contains("No reference image is attached"));
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
            AiAutonomyLevel::Low,
        );

        assert!(prompt.contains("Connected workflow inputs"));
        assert!(prompt.contains("Treat every attached image as intentionally connected"));
        assert!(
            prompt.contains("The final PNG must visibly include every mandatory connected asset")
        );
        assert!(prompt.contains("This is a generative synthesis task"));
        assert!(prompt.contains("Reconstruct the final scene naturally"));
        assert!(prompt.contains(
            "Do not satisfy the task by copying or lightly editing only one source image"
        ));
        assert!(prompt.contains("Unless the user explicitly asks for surreal or impossible"));
        assert!(prompt.contains("Human anatomy is a hard quality requirement"));
        assert!(prompt.contains("no duplicated palms"));
        assert!(prompt.contains("treat that image as the primary spatial plan"));
        assert!(prompt.contains("rough semantic diagrams"));
        assert!(prompt.contains("left/right ordering"));
        assert!(prompt.contains("subject centered in the left third/left half"));
        assert!(prompt.contains("do not mirror, recenter, or shift it to the opposite side"));
        assert!(prompt.contains("follow the storyboard's composition and placement"));
        assert!(prompt.contains("internally audit the storyboard into a concrete composition plan"));
        assert!(prompt.contains("arm/hand poses"));
        assert!(prompt.contains("when the storyboard provides a more specific pose or layout"));
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
    fn ai_working_canvas_chooses_small_supported_canvas_for_unsupported_ratio() {
        let working = ai_working_canvas_for_dimensions((1280, 800));

        assert_eq!(working.aspect_label, "3:2");
        assert_eq!(working.working_dimensions, (1296, 864));
        assert_eq!(
            working.content_rect,
            PixelRect {
                x: 8,
                y: 32,
                width: 1280,
                height: 800,
            }
        );
    }

    #[test]
    fn ai_working_canvas_uses_provider_bucket_for_small_exact_ratio() {
        let working = ai_working_canvas_for_dimensions((1024, 768));

        assert_eq!(working.aspect_label, "4:3");
        assert_eq!(working.working_dimensions, (1448, 1086));
        assert_eq!(
            working.content_rect,
            PixelRect {
                x: 212,
                y: 159,
                width: 1024,
                height: 768,
            }
        );
        assert!(working.has_padding());

        let working = ai_working_canvas_for_dimensions((1280, 960));
        assert_eq!(working.aspect_label, "4:3");
        assert_eq!(working.working_dimensions, (1448, 1086));
        assert_eq!(
            working.content_rect,
            PixelRect {
                x: 84,
                y: 63,
                width: 1280,
                height: 960,
            }
        );
        assert!(working.has_padding());
    }

    #[test]
    fn codex_retouch_working_canvas_uses_unpadded_exact_supported_ratio() {
        let working = ai_codex_working_canvas_for_dimensions((1280, 960));

        assert_eq!(working.aspect_label, "codex");
        assert_eq!(working.working_dimensions, (1280, 960));
        assert_eq!(
            working.content_rect,
            PixelRect {
                x: 0,
                y: 0,
                width: 1280,
                height: 960,
            }
        );
        assert!(!working.has_padding());

        let default_canvas = ai_codex_working_canvas_for_dimensions((1280, 800));
        assert_eq!(default_canvas.aspect_label, "codex");
        assert_eq!(default_canvas.working_dimensions, (1280, 800));
        assert_eq!(
            default_canvas.content_rect,
            PixelRect {
                x: 0,
                y: 0,
                width: 1280,
                height: 800,
            }
        );
        assert!(!default_canvas.has_padding());

        let unsupported = ai_codex_working_canvas_for_dimensions((1281, 800));
        assert_eq!(unsupported.aspect_label, "3:2");
        assert!(unsupported.has_padding());
    }

    #[test]
    fn pad_png_to_ai_working_canvas_centers_original_pixels() {
        let working = ai_working_canvas_for_dimensions((32, 20));
        let source =
            image::RgbaImage::from_fn(32, 20, |x, y| image::Rgba([x as u8, y as u8, 200, 255]));
        let source_bytes = encode_rgba_png(source, "source").expect("encode source");

        let padded =
            pad_png_to_ai_working_canvas(&source_bytes, &working, "source", ai_chroma_key_pixel())
                .expect("pad source");
        let padded_image = decode_png_rgba(&padded, "padded source").expect("decode padded");

        assert_eq!(padded_image.dimensions(), working.working_dimensions);
        assert_eq!(padded_image.get_pixel(0, 0).0, AI_CHROMA_KEY_RGBA);
        assert_eq!(
            padded_image
                .get_pixel(working.content_rect.x + 7, working.content_rect.y + 3)
                .0,
            [7, 3, 200, 255]
        );

        let padded_mask =
            pad_png_to_ai_working_canvas(&source_bytes, &working, "mask", ai_mask_padding_pixel())
                .expect("pad mask");
        let padded_mask_image =
            decode_png_rgba(&padded_mask, "padded mask").expect("decode padded mask");

        assert_eq!(padded_mask_image.dimensions(), working.working_dimensions);
        assert_eq!(padded_mask_image.get_pixel(0, 0).0, [0, 0, 0, 0]);
        assert_eq!(
            padded_mask_image
                .get_pixel(working.content_rect.x + 7, working.content_rect.y + 3)
                .0,
            [7, 3, 200, 255]
        );
    }

    #[test]
    fn crop_png_bytes_to_ai_content_extracts_centered_document_rect() {
        let working = ai_working_canvas_for_dimensions((32, 20));
        let output = image::RgbaImage::from_fn(
            working.working_dimensions.0,
            working.working_dimensions.1,
            |x, y| {
                let inside = x >= working.content_rect.x
                    && x < working.content_rect.x + working.content_rect.width
                    && y >= working.content_rect.y
                    && y < working.content_rect.y + working.content_rect.height;
                if inside {
                    image::Rgba([
                        (x - working.content_rect.x) as u8,
                        (y - working.content_rect.y) as u8,
                        77,
                        255,
                    ])
                } else {
                    ai_chroma_key_pixel()
                }
            },
        );
        let output_bytes = encode_rgba_png(output, "provider output").expect("encode output");

        let (cropped_bytes, provider_dimensions, cropped) =
            crop_png_bytes_to_ai_content(&output_bytes, &working, "provider output")
                .expect("crop output");
        let cropped_image = decode_png_rgba(&cropped_bytes, "cropped output").expect("decode crop");

        assert_eq!(provider_dimensions, working.working_dimensions);
        assert!(cropped);
        assert_eq!(cropped_image.dimensions(), working.original_dimensions);
        assert_eq!(cropped_image.get_pixel(0, 0).0, [0, 0, 77, 255]);
        assert_eq!(cropped_image.get_pixel(31, 19).0, [31, 19, 77, 255]);
    }

    #[test]
    fn crop_png_bytes_to_ai_content_resizes_full_frame_when_chroma_padding_is_removed() {
        let working = ai_working_canvas_for_dimensions((32, 20));
        let output = image::RgbaImage::from_fn(
            working.working_dimensions.0,
            working.working_dimensions.1,
            |x, y| {
                let inside = x >= working.content_rect.x
                    && x < working.content_rect.x + working.content_rect.width
                    && y >= working.content_rect.y
                    && y < working.content_rect.y + working.content_rect.height;
                if inside {
                    image::Rgba([20, 40, 220, 255])
                } else {
                    image::Rgba([220, 20, 40, 255])
                }
            },
        );
        let output_bytes = encode_rgba_png(output, "provider output").expect("encode output");

        let (cropped_bytes, provider_dimensions, cropped) =
            crop_png_bytes_to_ai_content(&output_bytes, &working, "provider output")
                .expect("normalize output");
        let cropped_image =
            decode_png_rgba(&cropped_bytes, "normalized output").expect("decode normalized");

        assert_eq!(provider_dimensions, working.working_dimensions);
        assert!(cropped);
        assert_eq!(cropped_image.dimensions(), working.original_dimensions);
        assert_eq!(cropped_image.get_pixel(0, 0).0, [220, 20, 40, 255]);
    }

    #[test]
    fn ai_working_canvas_accepts_scaled_same_ratio_outputs() {
        let working = ai_working_canvas_for_dimensions((1280, 800));

        assert!(ai_working_canvas_accepts_result_dimensions(
            &working,
            working.original_dimensions
        ));
        assert!(ai_working_canvas_accepts_result_dimensions(
            &working,
            working.working_dimensions
        ));
        assert!(ai_working_canvas_accepts_result_dimensions(
            &working,
            (1536, 1024)
        ));
        assert!(!ai_working_canvas_accepts_result_dimensions(
            &working,
            (1024, 1024)
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

    #[test]
    fn find_newest_png_since_filters_old_cache_images() {
        let cache = TempJobDir::new("paintnode-cache-png-test").expect("cache dir");
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
        let cache = TempJobDir::new("paintnode-thread-cache-png-test").expect("cache dir");
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

    #[test]
    fn find_codex_cached_pngs_returns_all_thread_pngs_in_order() {
        let cache = TempJobDir::new("paintnode-thread-cache-all-png-test").expect("cache dir");
        let thread_id = "019ef9e6-cc0a-79b3-9464-c2d16354e957";
        let thread_dir = cache.path().join(thread_id);
        let nested_dir = thread_dir.join("nested");
        let inputs_dir = thread_dir.join("inputs");
        fs::create_dir_all(&nested_dir).expect("nested dir");
        fs::create_dir_all(&inputs_dir).expect("inputs dir");

        let since = SystemTime::now();
        thread::sleep(Duration::from_millis(20));
        let first = thread_dir.join("first.png");
        fs::write(&first, ONE_PIXEL_PNG).expect("first png");
        thread::sleep(Duration::from_millis(20));
        let second = nested_dir.join("second.png");
        fs::write(&second, ONE_PIXEL_PNG).expect("second png");
        fs::write(inputs_dir.join("ignored-input.png"), ONE_PIXEL_PNG).expect("input png");
        fs::write(thread_dir.join("not-a-real.png"), b"not png").expect("invalid png");
        fs::write(thread_dir.join("notes.txt"), b"hello").expect("text file");

        let result_path = cache.path().join("result.png");
        let found = find_codex_cached_pngs_in_roots(
            vec![cache.path().to_path_buf()],
            Some(thread_id),
            since,
            &result_path,
        );

        assert_eq!(found, vec![first, second]);
    }

    #[test]
    fn find_codex_cached_pngs_ignores_old_or_unsafe_thread_inputs() {
        let cache = TempJobDir::new("paintnode-thread-cache-safe-png-test").expect("cache dir");
        let thread_id = "019ef9e6-cc0a-79b3-9464-c2d16354e957";
        let thread_dir = cache.path().join(thread_id);
        fs::create_dir_all(&thread_dir).expect("thread dir");
        fs::write(thread_dir.join("old.png"), ONE_PIXEL_PNG).expect("old png");

        let future_since = SystemTime::now() + Duration::from_secs(30);
        let result_path = cache.path().join("result.png");
        let old_matches = find_codex_cached_pngs_in_roots(
            vec![cache.path().to_path_buf()],
            Some(thread_id),
            future_since,
            &result_path,
        );
        assert!(old_matches.is_empty());

        let unsafe_matches = find_codex_cached_pngs_in_roots(
            vec![cache.path().to_path_buf()],
            Some("../outside"),
            SystemTime::UNIX_EPOCH,
            &result_path,
        );
        assert!(unsafe_matches.is_empty());
    }

    #[test]
    fn copy_codex_cached_png_to_job_preserves_cache_file_name() {
        let cache = TempJobDir::new("paintnode-cache-copy-test").expect("cache dir");
        let job = TempJobDir::new("paintnode-cache-copy-job-test").expect("job dir");
        let thread_id = "019ef9e6-cc0a-79b3-9464-c2d16354e957";
        let thread_dir = cache.path().join(thread_id);
        fs::create_dir_all(&thread_dir).expect("thread dir");

        let since = SystemTime::now();
        thread::sleep(Duration::from_millis(20));
        let source = thread_dir.join("ig_original_result_name.png");
        fs::write(&source, ONE_PIXEL_PNG).expect("cache png");

        let (found_source, staged_path) = copy_codex_cached_png_in_roots_to_job(
            vec![cache.path().to_path_buf()],
            job.path(),
            Some(thread_id),
            since,
        )
        .expect("copy should not fail")
        .expect("generated png");

        assert_eq!(found_source, source);
        assert_eq!(
            staged_path,
            job.path()
                .join("generated")
                .join("ig_original_result_name.png")
        );
        assert!(file_has_png_signature(&staged_path));
    }

    #[test]
    fn copy_codex_cached_pngs_to_job_copies_each_generated_png() {
        let cache = TempJobDir::new("paintnode-cache-copy-all-test").expect("cache dir");
        let job = TempJobDir::new("paintnode-cache-copy-all-job-test").expect("job dir");
        let thread_id = "019ef9e6-cc0a-79b3-9464-c2d16354e957";
        let thread_dir = cache.path().join(thread_id);
        fs::create_dir_all(&thread_dir).expect("thread dir");

        let since = SystemTime::now();
        thread::sleep(Duration::from_millis(20));
        let first = thread_dir.join("first.png");
        fs::write(&first, ONE_PIXEL_PNG).expect("first png");
        thread::sleep(Duration::from_millis(20));
        let second = thread_dir.join("second.png");
        fs::write(&second, ONE_PIXEL_PNG).expect("second png");

        let copied = copy_codex_cached_pngs_in_roots_to_job(
            vec![cache.path().to_path_buf()],
            job.path(),
            Some(thread_id),
            since,
        )
        .expect("copy should not fail");

        assert_eq!(copied.len(), 2);
        assert_eq!(copied[0].0, first);
        assert_eq!(copied[1].0, second);
        assert!(file_has_png_signature(&copied[0].1));
        assert!(file_has_png_signature(&copied[1].1));
    }
}
