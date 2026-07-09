//! Shared AI-job infrastructure: job dirs, process running, progress events, common types.

pub(crate) mod antigravity;
pub(crate) mod canvas;
pub(crate) mod claude;
pub(crate) mod codex;
pub(crate) mod director;
pub(crate) mod fill_storyboard;
pub(crate) mod placement;

use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Output;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;

use serde::Deserialize;
use serde::Serialize;
use tauri::AppHandle;
use tauri::Emitter;

use crate::png::{file_has_png_signature, is_png, png_dimensions_from_bytes, PNG_SIGNATURE};
use crate::project::{
    default_documents_project_dir, ensure_project_dirs, safe_file_name, safe_stem, ProjectAssetView,
};

pub(crate) const AI_RUN_STOPPED_MESSAGE: &str = "The task was stopped.";

static CANCELLED_AI_RUNS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancelled_ai_runs() -> &'static Mutex<HashSet<String>> {
    CANCELLED_AI_RUNS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Flag a running AI job for cancellation; its CLI process is killed at the
/// runner's next poll and the task fails with [`AI_RUN_STOPPED_MESSAGE`].
#[tauri::command]
pub(crate) async fn cancel_ai_run(run_id: String) -> Result<(), String> {
    let run_id = run_id.trim().to_string();
    if run_id.is_empty() {
        return Err("Missing run id.".into());
    }
    cancelled_ai_runs()
        .lock()
        .map_err(|_| "Cancellation registry is unavailable.".to_string())?
        .insert(run_id);
    Ok(())
}

/// Commands clear any stale flag when they start so a retry with the same run
/// id is not stopped by the previous attempt's cancellation.
pub(crate) fn clear_ai_run_cancelled(run_id: &str) {
    if let Ok(mut runs) = cancelled_ai_runs().lock() {
        runs.remove(run_id);
    }
}

pub(crate) fn ai_run_cancelled(run_id: &str) -> bool {
    cancelled_ai_runs()
        .lock()
        .map(|runs| runs.contains(run_id))
        .unwrap_or(false)
}

pub(crate) const POLL_INTERVAL: Duration = Duration::from_millis(100);

const CODEX_PROGRESS_EVENT: &str = "codex-generation-progress";

pub(crate) const PAINTNODE_WORK_DIR: &str = "paintnode";
pub(crate) const CODEX_RUNS_DIR: &str = "codex-runs";
pub(crate) const CLAUDE_RUNS_DIR: &str = "claude-runs";
pub(crate) const ANTIGRAVITY_RUNS_DIR: &str = "antigravity-runs";

fn ai_cli_path() -> String {
    let mut entries: Vec<String> = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .map(|entry| entry.to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default();

    if let Ok(home) = std::env::var("HOME") {
        entries.extend([
            format!("{home}/.local/bin"),
            format!("{home}/.npm-global/bin"),
            format!("{home}/.volta/bin"),
            format!("{home}/.bun/bin"),
            format!("{home}/.antigravity/antigravity/bin"),
        ]);
    }

    entries.extend([
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ]);

    let mut seen = HashSet::new();
    entries.retain(|entry| !entry.is_empty() && seen.insert(entry.clone()));
    std::env::join_paths(entries.iter().map(Path::new))
        .unwrap_or_else(|_| "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into())
        .to_string_lossy()
        .to_string()
}

pub(crate) fn apply_ai_cli_environment(command: &mut Command) -> &mut Command {
    command.env("PATH", ai_cli_path())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneratedImageResult {
    data_url: String,
    asset: Option<ProjectAssetView>,
    assets: Vec<ProjectAssetView>,
    mask_data_url: Option<String>,
    layers: Vec<GeneratedImageLayerResult>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneratedImageLayerResult {
    name: String,
    data_url: String,
    asset: Option<ProjectAssetView>,
    mask_data_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexDetectionResult {
    found: bool,
    path: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecoupledLayerResult {
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
pub(crate) struct DecoupleImageResult {
    layers: Vec<DecoupledLayerResult>,
    thread_id: Option<String>,
    notes: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecoupleManifest {
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
pub(crate) struct WorkflowSourceImage {
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

pub(crate) fn validate_reference_pngs(
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

pub(crate) fn write_reference_pngs(
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

pub(crate) fn reference_prompt_note(reference_names: &[String], prefix: &str) -> String {
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
    /// 1-based position of the placement part this message belongs to.
    #[serde(skip_serializing_if = "Option::is_none")]
    part_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    part_count: Option<usize>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AiAutonomyLevel {
    Low,
    Guided,
    Open,
    Unmanaged,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AiDirectorMode {
    Auto,
    Skip,
    Force,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AiDirectorProvider {
    Codex,
    Antigravity,
    Claude,
}

impl AiDirectorProvider {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Antigravity => "Antigravity",
            Self::Claude => "Claude",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AiDirectorInvolvement {
    PlanOnly,
    EnsureCompletion,
    FullReview,
}

pub(crate) struct TempJobDir {
    path: PathBuf,
}

impl TempJobDir {
    pub(crate) fn new(prefix: &str) -> Result<Self, String> {
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

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempJobDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

pub(crate) fn now_id() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

pub(crate) fn ensure_agent_run_dirs(project_path: &Path) -> Result<(), String> {
    fs::create_dir_all(project_path.join(PAINTNODE_WORK_DIR).join(CODEX_RUNS_DIR))
        .map_err(|e| format!("Failed to create Codex runs folder: {e}"))?;
    fs::create_dir_all(project_path.join(PAINTNODE_WORK_DIR).join(CLAUDE_RUNS_DIR))
        .map_err(|e| format!("Failed to create Claude runs folder: {e}"))?;
    fs::create_dir_all(
        project_path
            .join(PAINTNODE_WORK_DIR)
            .join(ANTIGRAVITY_RUNS_DIR),
    )
    .map_err(|e| format!("Failed to create Antigravity runs folder: {e}"))?;
    Ok(())
}

pub(crate) fn project_agent_run_dir(
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

/// Deterministic job folder for a run id: a retry of the same task lands in
/// the same folder, so it can resume from the previous attempt's part results.
pub(crate) fn project_agent_run_dir_for_run(
    project_dir: &Path,
    vendor_dir: &str,
    prefix: &str,
    run_id: &str,
) -> Result<PathBuf, String> {
    ensure_project_dirs(project_dir)?;
    let run_dir = project_dir
        .join(PAINTNODE_WORK_DIR)
        .join(vendor_dir)
        .join(format!("{prefix}-{}", safe_stem(run_id)));
    fs::create_dir_all(&run_dir).map_err(|e| format!("Failed to create AI job folder: {e}"))?;
    Ok(run_dir)
}

pub(crate) fn optional_project_dir(project_path: &Option<String>) -> Option<PathBuf> {
    project_path
        .as_ref()
        .map(|p| PathBuf::from(p.trim()))
        .filter(|p| !p.as_os_str().is_empty())
}

pub(crate) fn ai_job_project_dir(
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

pub(crate) fn cleanup_project_agent_job(job_path: &Path) {
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

pub(crate) fn should_keep_job_dir(keep_job_dir: Option<bool>) -> bool {
    keep_job_dir.unwrap_or(false)
}

pub(crate) fn cleanup_project_job_enabled(
    project_dir: &Option<PathBuf>,
    keep_job_dir: bool,
) -> bool {
    project_dir.is_some() && !keep_job_dir
}

pub(crate) fn write_ai_job_prompt(
    job_path: &Path,
    prompt: &str,
    label: &str,
) -> Result<(), String> {
    fs::write(job_path.join("prompt.txt"), prompt)
        .map_err(|e| format!("Failed to write {label} prompt file: {e}"))
}

pub(crate) fn remove_legacy_generative_fill_agent_inputs(part_path: &Path) {
    let _ = fs::remove_file(part_path.join("edit_target.png"));
    let _ = fs::remove_file(part_path.join("mask.png"));
}

pub(crate) fn emit_kept_job_dir(
    app: &AppHandle,
    run_id: &str,
    job_path: &Path,
    keep_job_dir: bool,
) {
    if keep_job_dir {
        emit_codex_progress(
            app,
            run_id,
            &format!("Saved AI run inputs: {}", job_path.display()),
        );
    }
}

pub(crate) fn safe_png_source_file_name(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| *name != "result.png")
        .filter(|name| safe_file_name(name).is_some())
        .map(str::to_string)
}

pub(crate) fn ai_retouch_asset_name(prompt: &str, source_file_name: Option<&str>) -> String {
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

pub(crate) fn required_png_output_is_ready(
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

pub(crate) fn copy_png_candidate(candidate: &Path, result_path: &Path) -> bool {
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

pub(crate) fn unique_child_path(dir: &Path, file_name: &str) -> PathBuf {
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

pub(crate) fn safe_job_child_path(job_path: &Path, file_name: &str) -> Result<PathBuf, String> {
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

pub(crate) fn sanitize_progress_line(line: &str) -> Option<String> {
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

pub(crate) fn json_string_at<'a>(value: &'a serde_json::Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

pub(crate) fn codex_agent_message_text(line: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
    let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let item_type = json_string_at(&value, &["item", "type"]).unwrap_or("");
    if !event_type.contains("item.completed") || !item_type.contains("agent_message") {
        return None;
    }
    let text = json_string_at(&value, &["item", "text"])?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

pub(crate) fn codex_thread_id_from_line(line: &str) -> Option<String> {
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

pub(crate) fn watched_job_files(job_path: &Path) -> HashMap<String, Option<SystemTime>> {
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

pub(crate) fn emit_job_file_progress(
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

fn generated_job_outputs(job_path: &Path, required_output: &str) -> Vec<String> {
    let mut outputs = watched_job_files(job_path)
        .into_keys()
        .filter(|name| {
            let lower = name.to_ascii_lowercase();
            name != required_output
                && lower.ends_with(".png")
                && !matches!(
                    lower.as_str(),
                    "source.png" | "edit_target.png" | "mask.png" | "part_result.png"
                )
        })
        .collect::<Vec<_>>();
    outputs.sort();
    outputs
}

pub(crate) fn command_failure_with_required_output(
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

fn is_fallback_decouple_asset_png(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    if !lower.ends_with(".png") {
        return false;
    }
    if matches!(
        lower.as_str(),
        "source.png" | "edit_target.png" | "mask.png" | "part_result.png" | "result.png"
    ) {
        return false;
    }
    let stem = lower.strip_suffix(".png").unwrap_or(lower.as_str());
    let debug_tokens = [
        "alpha",
        "annotated",
        "bbox",
        "comparison",
        "coordinate",
        "coordinates",
        "debug",
        "grid",
        "guide",
        "histogram",
        "mask",
        "overlay",
        "preview",
    ];
    !stem
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .any(|token| debug_tokens.contains(&token))
}

fn fallback_decouple_asset_name(file_name: &str, index: usize) -> String {
    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("");
    let mut name = String::new();
    let mut uppercase_next = true;
    for ch in stem.chars() {
        if ch.is_ascii_alphanumeric() {
            let ch = ch.to_ascii_lowercase();
            name.push(if uppercase_next {
                ch.to_ascii_uppercase()
            } else {
                ch
            });
            uppercase_next = false;
        } else if !name.ends_with(' ') {
            name.push(' ');
            uppercase_next = true;
        }
    }
    let name = name.trim();
    if name.is_empty() {
        format!("Extracted Asset {}", index + 1)
    } else {
        name.chars().take(80).collect()
    }
}

fn fallback_decouple_asset_pngs(job_path: &Path) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    let entries = fs::read_dir(job_path).map_err(|e| {
        format!(
            "Failed to inspect asset extraction outputs at {}: {e}",
            job_path.display()
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|e| {
            format!(
                "Failed to inspect asset extraction output at {}: {e}",
                job_path.display()
            )
        })?;
        let file_type = entry.file_type().map_err(|e| {
            format!(
                "Failed to inspect asset extraction output type at {}: {e}",
                entry.path().display()
            )
        })?;
        if !file_type.is_file() {
            continue;
        }
        let Some(file_name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !is_fallback_decouple_asset_png(&file_name) {
            continue;
        }
        let bytes = fs::read(entry.path()).map_err(|e| {
            format!(
                "Failed to read asset extraction output at {}: {e}",
                entry.path().display()
            )
        })?;
        if is_png(&bytes) && png_dimensions_from_bytes(&bytes).is_some() {
            files.push(file_name);
        }
    }
    files.sort_by_key(|name| name.to_ascii_lowercase());
    Ok(files)
}

pub(crate) fn synthesize_decouple_asset_manifest(job_path: &Path) -> Result<Option<usize>, String> {
    let files = fallback_decouple_asset_pngs(job_path)?;
    if files.is_empty() {
        return Ok(None);
    }
    let layers = files
        .iter()
        .enumerate()
        .map(|(index, file)| {
            serde_json::json!({
                "name": fallback_decouple_asset_name(file, index),
                "file": file,
                "alphaMask": serde_json::Value::Null,
                "keyColor": serde_json::Value::Null,
                "opacity": 1,
                "visible": true,
            })
        })
        .collect::<Vec<_>>();
    let manifest = serde_json::json!({
        "layers": layers,
        "notes": "PaintNode synthesized this manifest from extracted PNG outputs because manifest.json was missing.",
    });
    let manifest_text = serde_json::to_string_pretty(&manifest)
        .map_err(|e| format!("Failed to serialize fallback asset manifest: {e}"))?;
    fs::write(job_path.join("manifest.json"), manifest_text)
        .map_err(|e| format!("Failed to write fallback asset manifest: {e}"))?;
    Ok(Some(files.len()))
}

pub(crate) fn emit_codex_progress(app: &AppHandle, run_id: &str, message: impl Into<String>) {
    let _ = app.emit(
        CODEX_PROGRESS_EVENT,
        CodexProgressPayload {
            run_id: run_id.to_string(),
            message: message.into(),
            part_index: None,
            part_count: None,
        },
    );
}

/// Progress for one placement part; carries the part position so the task
/// list can render a sub-task progress indicator.
pub(crate) fn emit_codex_part_progress(
    app: &AppHandle,
    run_id: &str,
    part_index: usize,
    part_count: usize,
    message: impl Into<String>,
) {
    let _ = app.emit(
        CODEX_PROGRESS_EVENT,
        CodexProgressPayload {
            run_id: run_id.to_string(),
            message: message.into(),
            part_index: Some(part_index + 1),
            part_count: Some(part_count),
        },
    );
}

#[derive(Debug)]
pub(crate) struct AgentRunResult {
    pub(crate) output: Output,
    pub(crate) thread_id: Option<String>,
    pub(crate) satisfied_required_output: bool,
}

pub(crate) fn spawn_output_reader<R: Read + Send + 'static>(
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

pub(crate) fn output_tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim();
    let char_count = trimmed.chars().count();
    if char_count <= 2000 {
        trimmed.to_string()
    } else {
        trimmed.chars().skip(char_count - 2000).collect()
    }
}

pub(crate) fn command_failure(prefix: &str, output: &Output) -> String {
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

pub(crate) fn clean_option(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub(crate) fn ai_autonomy_level(value: Option<String>) -> AiAutonomyLevel {
    match clean_option(value).as_deref() {
        Some("guided") => AiAutonomyLevel::Guided,
        Some("open") => AiAutonomyLevel::Open,
        Some("unmanaged") => AiAutonomyLevel::Unmanaged,
        _ => AiAutonomyLevel::Low,
    }
}

pub(crate) fn ai_director_mode(value: Option<String>) -> AiDirectorMode {
    match clean_option(value).as_deref() {
        Some("skip") => AiDirectorMode::Skip,
        Some("force") => AiDirectorMode::Force,
        _ => AiDirectorMode::Auto,
    }
}

pub(crate) fn ai_director_provider(value: Option<String>) -> AiDirectorProvider {
    match clean_option(value)
        .as_deref()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("antigravity") | Some("agy") | Some("gemini") => AiDirectorProvider::Antigravity,
        Some("claude") => AiDirectorProvider::Claude,
        _ => AiDirectorProvider::Codex,
    }
}

pub(crate) fn ai_director_involvement(value: Option<String>) -> AiDirectorInvolvement {
    match clean_option(value).as_deref() {
        Some("planOnly") => AiDirectorInvolvement::PlanOnly,
        Some("ensureCompletion") => AiDirectorInvolvement::EnsureCompletion,
        _ => AiDirectorInvolvement::FullReview,
    }
}

pub(crate) fn ai_director_restore_contract(
    provider: AiDirectorProvider,
    mode: AiDirectorMode,
    involvement: AiDirectorInvolvement,
) -> String {
    ai_director_workflow_contract(provider, mode, involvement, "detail restoration")
}

pub(crate) fn ai_director_workflow_contract(
    provider: AiDirectorProvider,
    mode: AiDirectorMode,
    involvement: AiDirectorInvolvement,
    workflow: &str,
) -> String {
    if mode == AiDirectorMode::Skip {
        return String::new();
    }
    let label = provider.label();
    match involvement {
        AiDirectorInvolvement::PlanOnly => format!(
            "AI Director provider: {label}.\nAI Director participation: Plan only. Treat this prompt as the Director's plan for the {workflow} workflow; do not run a separate blocked-prompt or quality-review loop."
        ),
        AiDirectorInvolvement::EnsureCompletion => format!(
            "AI Director provider: {label}.\nAI Director participation: Ensure completion. If a provider safety or quality issue blocks the exact wording during the {workflow} workflow, make the smallest compliant prompt adjustment while preserving the user's intent, source-image facts, protected areas, and intentional medium character."
        ),
        AiDirectorInvolvement::FullReview => format!(
            "AI Director provider: {label}.\nAI Director participation: Full review. Supervise the {workflow} workflow from planning through completion: preserve the user's intent, recover from blocked wording with the smallest faithful prompt adjustment, and before returning compare the candidate against the source/task requirements. Revise internally until content, framing, grain/texture, exposure character, local detail, and protected areas remain faithful. Return only the final accepted result."
        ),
    }
}

pub(crate) fn image_agent_autonomy_contract(
    level: AiAutonomyLevel,
    _provider: &str,
) -> &'static str {
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

pub(crate) fn project_or_temp_job_path(
    app: &AppHandle,
    project_path: &Option<String>,
    prefix: &str,
    run_id: &str,
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
        let run_dir =
            project_agent_run_dir_for_run(job_project_dir, ANTIGRAVITY_RUNS_DIR, prefix, run_id)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::antigravity::antigravity_generate_prompt;
    use crate::ai::codex::codex_direct_generate_prompt;

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
    fn generate_image_prompts_do_not_expose_canvas_geometry() {
        let codex = codex_direct_generate_prompt("make an image", &[]);
        assert!(codex.contains("Generate exactly one raster PNG for PaintNode"));
        assert!(codex.contains("User image prompt:\nmake an image"));
        assert!(!codex.contains("$imagegen"));
        assert!(!codex.contains("generated-images cache"));
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
            &[],
        );
        assert!(antigravity.contains("Generate one raster PNG for PaintNode"));
        assert!(antigravity.contains("User image prompt:\nmake an image"));
        assert!(antigravity.contains("largest image size / highest output resolution"));
        assert!(!antigravity.contains("1280x800"));
        assert!(!antigravity.contains("1296x864"));
        assert!(!antigravity.contains("Working PNG"));
        assert!(!antigravity.contains("Document rectangle"));
        assert!(!antigravity.contains("chroma"));
        assert!(!antigravity.contains("#00ff00"));
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
    fn ai_cli_path_includes_common_gui_missing_tool_dirs() {
        let path = ai_cli_path();
        let entries: Vec<String> = std::env::split_paths(&path)
            .map(|entry| entry.to_string_lossy().to_string())
            .collect();

        assert!(entries.contains(&"/opt/homebrew/bin".to_string()));
        assert!(entries.contains(&"/usr/local/bin".to_string()));
        assert!(entries.contains(&"/usr/bin".to_string()));
        assert!(entries.contains(&"/bin".to_string()));
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
    fn fallback_decouple_manifest_uses_asset_pngs_and_skips_debug_outputs() {
        let job = TempJobDir::new("paintnode-decouple-fallback-test").expect("temp dir");
        let png = crate::test_util::test_rgba_png(1, 1, &[[20, 40, 80, 255]]);
        for name in [
            "source.png",
            "background.png",
            "bag.png",
            "computer.png",
            "girl.png",
            "guide.png",
            "girl-mask.png",
            "lunchbox.png",
        ] {
            fs::write(job.path().join(name), &png).expect("write test png");
        }

        let count = synthesize_decouple_asset_manifest(job.path())
            .expect("synthesize manifest")
            .expect("fallback assets");
        assert_eq!(count, 5);

        let manifest_text =
            fs::read_to_string(job.path().join("manifest.json")).expect("read manifest");
        let manifest: DecoupleManifest =
            serde_json::from_str(&manifest_text).expect("manifest parses");
        let names = manifest
            .layers
            .iter()
            .map(|layer| layer.name.as_str())
            .collect::<Vec<_>>();
        let files = manifest
            .layers
            .iter()
            .map(|layer| layer.file.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec!["Background", "Bag", "Computer", "Girl", "Lunchbox"]
        );
        assert_eq!(
            files,
            vec![
                "background.png",
                "bag.png",
                "computer.png",
                "girl.png",
                "lunchbox.png"
            ]
        );
        assert!(manifest
            .notes
            .as_deref()
            .unwrap_or("")
            .contains("synthesized"));
    }
}
