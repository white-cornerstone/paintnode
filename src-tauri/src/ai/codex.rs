//! Codex CLI provider: prompts, command building, cached-PNG discovery, commands.

use std::error::Error as StdError;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Output;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use std::time::SystemTime;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use reqwest::blocking::Client;
use serde::Deserialize;
use serde_json::json;
use tauri::AppHandle;

use crate::ai::antigravity::{run_antigravity_director_request, run_antigravity_owned_image_edit};
use crate::ai::canvas::{
    ai_candidate_rejection, ai_edit_checks_level, ai_retouch_editable_mask_png,
    read_png_bytes_cropped_to_ai_working_canvas, remove_rejected_ai_candidate,
    validate_optional_target_dimensions, AiWorkingCanvas, AI_CHROMA_KEY_HEX,
    AI_PROTECTED_DRIFT_MAX_ATTEMPTS, AI_RETOUCH_OUTPUT_MASK_FEATHER_RADIUS,
    AI_RETOUCH_OUTPUT_MASK_GROW_RADIUS, AI_SEAM_RETRY_NOTE,
};
use crate::ai::claude::{
    build_director_claude_command, build_generative_fill_claude_command, claude_command_failure,
    claude_command_label, claude_command_options, final_claude_agent_message,
    run_claude_with_progress, ClaudeCommandOptions,
};
use crate::ai::director::{
    director_candidate_file, director_uses_agentic_loop, image_request_prompt,
    run_candidate_director_loop, workflow_review_criteria, DirectorCandidate, DirectorImageRequest,
    DirectorLoopSpec, PAINTNODE_DIRECTOR_ACTION_FILE, PAINTNODE_DIRECTOR_OBSERVATION_FILE,
};
use crate::ai::fill_storyboard::{
    fill_storyboard_master_prompt, fill_storyboard_part_is_anchor, fill_storyboard_part_prompt,
    preserve_invalid_fill_storyboard_file, read_fill_storyboard_file,
    record_fill_storyboard_failure, should_storyboard_fill, FillStoryboard,
    FILL_STORYBOARD_DRAFT_FILE, FILL_STORYBOARD_FILE, FILL_STORYBOARD_OVERVIEW_FILE,
};
use crate::ai::placement::{
    ai_orchestrated_part_prompt_context, ai_part_geometry_note, ai_part_progress_message,
    ai_part_prompt_context, ai_upscale_target_dimensions, correct_part_result_drift,
    cover_crop_png_to_dimensions, fill_part_needs_overview, fill_placement_returns_layer_results,
    normalize_storyboard_draft_png, plan_ai_edit_placement, plan_ai_fill_placement,
    plan_ai_restore_placement, plan_ai_upscale_placement, prepare_ai_job_dir_for_placement,
    resize_png_to_dimensions, reuse_part_result, AiEditComposer, AiEditPlacement, AiEditProvider,
    AiFillMethod, AiFillRedundancy, AI_RESTORE_UPSCALE_THRESHOLD,
};
use crate::ai::{
    ai_autonomy_level, ai_director_involvement, ai_director_mode, ai_director_provider,
    ai_director_restore_contract, ai_director_workflow_contract, ai_job_project_dir,
    ai_retouch_asset_name, ai_run_cancelled, apply_ai_cli_environment, clean_option,
    cleanup_project_agent_job, cleanup_project_job_enabled, clear_ai_run_cancelled,
    codex_agent_message_text, command_failure, copy_png_candidate, emit_codex_part_progress,
    emit_codex_progress, emit_kept_job_dir, now_id, optional_project_dir, output_tail,
    project_agent_run_dir, project_agent_run_dir_for_run, reference_prompt_note,
    remove_legacy_generative_fill_agent_inputs, safe_job_child_path, safe_png_source_file_name,
    should_keep_job_dir, spawn_output_reader, synthesize_decouple_asset_manifest,
    unique_child_path, validate_reference_pngs, write_ai_job_prompt, write_reference_pngs,
    AgentRunResult, AiAutonomyLevel, AiDirectorInvolvement, AiDirectorMode, AiDirectorProvider,
    AiModelCapability, AiProviderCapabilitiesResult, AiReasoningCapability, CodexDetectionResult,
    DecoupleImageResult, DecoupleManifest, DecoupledLayerResult, GeneratedImageLayerResult,
    GeneratedImageResult, TempJobDir, WorkflowSourceImage, AI_RUN_STOPPED_MESSAGE,
    ANTIGRAVITY_RUNS_DIR, CLAUDE_RUNS_DIR, CODEX_RUNS_DIR, POLL_INTERVAL,
};
use crate::png::{
    file_has_png_signature, is_png, png_data_url, png_dimensions, png_dimensions_from_bytes,
};
use crate::project::{
    add_asset, safe_file_name, safe_stem, store_generated_png_asset, write_asset_file,
    write_asset_file_with_file_name, ProjectAsset,
};

/// Appended to the prompt when a candidate fails the protected-region drift
/// gate: the model regenerated the scene instead of editing in place.
const CODEX_IN_PLACE_RETRY_NOTE: &str = r#"IMPORTANT — previous candidate rejected:
- The previous candidate repainted pixels outside the editable mask, which means the scene was regenerated instead of edited in place. PaintNode discarded it.
- This is a strict in-place edit of `edit_target.png`: apply the requested change only inside the white mask area and reproduce every pixel outside the mask exactly as it appears in `edit_target.png`.
- If the requested change cannot be honored inside the mask, make the closest faithful change rather than re-imagining the scene."#;
const PAINTNODE_IMAGE_REQUEST_FILE: &str = "paintnode-image-request.json";
const PAINTNODE_CODEX_IMAGE_REQUEST_FILE: &str = "paintnode-codex-image-request.json";
const PAINTNODE_CODEX_IMAGE_RESPONSE_FILE: &str = "paintnode-codex-image-response.json";

#[derive(Debug)]
struct CodexCommandOptions {
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    image_quality: Option<String>,
    image_moderation: Option<String>,
    keep_debug_artifacts: bool,
}

impl Default for CodexCommandOptions {
    fn default() -> Self {
        Self {
            model: None,
            reasoning_effort: None,
            service_tier: None,
            image_quality: None,
            image_moderation: None,
            keep_debug_artifacts: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PaintNodeImageProvider {
    Codex,
    Antigravity,
}

impl PaintNodeImageProvider {
    fn from_option(value: Option<String>) -> Self {
        match value
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("antigravity") | Some("agy") | Some("gemini") => Self::Antigravity,
            _ => Self::Codex,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum PaintNodeDirectorProvider {
    Codex,
    Antigravity,
    Claude,
}

impl PaintNodeDirectorProvider {
    fn from_options(director_provider: Option<String>, planner_provider: Option<String>) -> Self {
        let provider = ai_director_provider(director_provider.or(planner_provider));
        Self::from_director_provider(provider)
    }

    fn from_director_provider(provider: AiDirectorProvider) -> Self {
        match provider {
            AiDirectorProvider::Codex => Self::Codex,
            AiDirectorProvider::Antigravity => Self::Antigravity,
            AiDirectorProvider::Claude => Self::Claude,
        }
    }

    fn as_director_provider(&self) -> AiDirectorProvider {
        match self {
            Self::Codex => AiDirectorProvider::Codex,
            Self::Antigravity => AiDirectorProvider::Antigravity,
            Self::Claude => AiDirectorProvider::Claude,
        }
    }

    fn label(&self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Antigravity => "Antigravity",
            Self::Claude => "Claude",
        }
    }

    fn runs_dir(&self) -> &'static str {
        match self {
            Self::Codex => CODEX_RUNS_DIR,
            Self::Antigravity => ANTIGRAVITY_RUNS_DIR,
            Self::Claude => CLAUDE_RUNS_DIR,
        }
    }
}

#[derive(Clone, Debug)]
struct PaintNodeImageProviderOptions {
    provider: PaintNodeImageProvider,
    keep_debug_artifacts: bool,
    antigravity_bin: Option<String>,
    antigravity_model: Option<String>,
    antigravity_approval_mode: Option<String>,
    antigravity_image_model: Option<String>,
    antigravity_image_size: Option<String>,
    antigravity_person_generation: Option<String>,
    antigravity_prominent_people: Option<String>,
    antigravity_compression_quality: Option<u8>,
    antigravity_advanced_json: Option<String>,
    antigravity_safety_filtering: Option<String>,
    antigravity_safety_harassment: Option<String>,
    antigravity_safety_hate_speech: Option<String>,
    antigravity_safety_sexually_explicit: Option<String>,
    antigravity_safety_dangerous_content: Option<String>,
}

fn codex_image_provider_options(keep_debug_artifacts: bool) -> PaintNodeImageProviderOptions {
    PaintNodeImageProviderOptions {
        provider: PaintNodeImageProvider::Codex,
        keep_debug_artifacts,
        antigravity_bin: None,
        antigravity_model: None,
        antigravity_approval_mode: None,
        antigravity_image_model: None,
        antigravity_image_size: None,
        antigravity_person_generation: None,
        antigravity_prominent_people: None,
        antigravity_compression_quality: None,
        antigravity_advanced_json: None,
        antigravity_safety_filtering: None,
        antigravity_safety_harassment: None,
        antigravity_safety_hate_speech: None,
        antigravity_safety_sexually_explicit: None,
        antigravity_safety_dangerous_content: None,
    }
}

#[derive(Debug, Deserialize)]
struct CodexAuthJson {
    tokens: Option<CodexAuthTokens>,
}

#[derive(Debug, Deserialize)]
struct CodexAuthTokens {
    access_token: String,
    account_id: Option<String>,
}

#[derive(Debug)]
struct CodexChatGptAuth {
    access_token: String,
    account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexImageResponse {
    data: Vec<CodexImageData>,
}

#[derive(Debug, Deserialize)]
struct CodexImageData {
    b64_json: String,
}

type PaintNodeImageRequest = DirectorImageRequest;

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

/// Newest valid staged PNG from a previous attempt of this job, if any.
fn newest_previous_generated_png(job_path: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(job_path.join("generated")).ok()?;
    let mut candidates: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| file_has_png_signature(path) && png_dimensions(path).is_ok())
        .collect();
    candidates.sort_by_key(|path| {
        std::cmp::Reverse(
            fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok(),
        )
    });
    candidates.into_iter().next()
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

pub(crate) fn final_codex_agent_message(output: &Output) -> Option<String> {
    final_codex_agent_message_from_text(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    )
}

fn run_codex_with_progress(
    command: &mut Command,
    app: AppHandle,
    run_id: String,
) -> Result<AgentRunResult, String> {
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

    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("Failed to wait for command: {e}"))?
        {
            break status;
        }

        if ai_run_cancelled(&run_id) {
            let _ = child.kill();
            let _ = child.wait();
            clear_ai_run_cancelled(&run_id);
            return Err(AI_RUN_STOPPED_MESSAGE.into());
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

    Ok(AgentRunResult {
        output: Output {
            status,
            stdout,
            stderr,
        },
        thread_id,
        satisfied_required_output: false,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_codex_director_request(
    app: &AppHandle,
    run_id: &str,
    bin: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    keep_debug_artifacts: bool,
    job_path: &Path,
    prompt_text: &str,
    image_paths: &[PathBuf],
) -> Result<AgentRunResult, String> {
    let codex_bin = configured_codex_bin_or_sdk_default(bin);
    let mut options = codex_command_options(model, reasoning_effort, service_tier, None, None);
    options.keep_debug_artifacts = keep_debug_artifacts;
    let mut command =
        build_codex_sdk_command(&codex_bin, job_path, prompt_text, image_paths, &options);
    let run =
        run_codex_with_progress(&mut command, app.clone(), run_id.to_string()).map_err(|e| {
            format!(
                "Failed to run Codex at '{}': {e}",
                codex_command_label(&codex_bin)
            )
        })?;
    if run.output.status.success() {
        Ok(run)
    } else if let Some(message) = final_codex_agent_message(&run.output) {
        Err(format!("Codex Director failed.\n\n{message}"))
    } else {
        Err(command_failure("Codex Director", &run.output))
    }
}

fn configured_or_default_codex_bin(bin: Option<String>) -> Result<String, String> {
    if let Some(bin) = configured_codex_bin(bin) {
        return Ok(bin);
    }

    let candidates = ["codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"];
    for candidate in candidates {
        let mut command = Command::new(candidate);
        apply_ai_cli_environment(&mut command)
            .arg("--version")
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_API_KEY");
        if command.output().is_ok() {
            return Ok(candidate.to_string());
        }
    }

    Err(
        "Codex CLI was not found. Install Codex, or enter the full path to the `codex` binary."
            .into(),
    )
}

fn configured_codex_bin(bin: Option<String>) -> Option<String> {
    bin.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn configured_codex_bin_or_sdk_default(bin: Option<String>) -> String {
    configured_codex_bin(bin).unwrap_or_default()
}

fn codex_command_label(codex_bin: &str) -> &str {
    if codex_bin.trim().is_empty() {
        "Codex SDK bundled CLI"
    } else {
        codex_bin
    }
}

fn codex_command_options(
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    image_quality: Option<String>,
    image_moderation: Option<String>,
) -> CodexCommandOptions {
    CodexCommandOptions {
        model: clean_option(model),
        reasoning_effort: clean_option(reasoning_effort),
        service_tier: clean_option(service_tier),
        image_quality: codex_image_quality(image_quality),
        image_moderation: codex_image_moderation(image_moderation),
        keep_debug_artifacts: false,
    }
}

fn remove_codex_debug_artifacts(job_path: &Path) {
    for file_name in [
        PAINTNODE_CODEX_IMAGE_REQUEST_FILE,
        PAINTNODE_CODEX_IMAGE_RESPONSE_FILE,
    ] {
        let _ = fs::remove_file(job_path.join(file_name));
    }
}

fn codex_image_quality(value: Option<String>) -> Option<String> {
    clean_option(value).and_then(|value| match value.as_str() {
        "auto" | "low" | "medium" | "high" => Some(value),
        _ => None,
    })
}

fn codex_image_moderation(value: Option<String>) -> Option<String> {
    clean_option(value).and_then(|value| match value.as_str() {
        "auto" | "low" => Some(value),
        _ => None,
    })
}

fn codex_sdk_runner_script() -> PathBuf {
    if let Some(path) = crate::managed_runtime::managed_runner("codex") {
        return path;
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(|root| root.join("scripts").join("codex-sdk-runner.mjs"))
        .unwrap_or_else(|| PathBuf::from("scripts").join("codex-sdk-runner.mjs"))
}

fn codex_sdk_node() -> PathBuf {
    crate::managed_runtime::managed_node("codex").unwrap_or_else(|| PathBuf::from("node"))
}

fn managed_codex_bin_or<'a>(configured: &'a str) -> std::borrow::Cow<'a, str> {
    if !configured.trim().is_empty() {
        return std::borrow::Cow::Borrowed(configured);
    }
    crate::managed_runtime::managed_executable("codex")
        .map(|path| std::borrow::Cow::Owned(path.to_string_lossy().into_owned()))
        .unwrap_or_else(|| std::borrow::Cow::Borrowed(configured))
}

fn codex_capabilities_runner_script() -> PathBuf {
    if let Some(path) = crate::managed_runtime::managed_capabilities_runner("codex") {
        return path;
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(|root| root.join("scripts").join("codex-capabilities.mjs"))
        .unwrap_or_else(|| PathBuf::from("scripts").join("codex-capabilities.mjs"))
}

fn fallback_codex_capabilities(warning: Option<String>) -> AiProviderCapabilitiesResult {
    let efforts = || {
        [
            ("low", "Low"),
            ("medium", "Medium"),
            ("high", "High"),
            ("xhigh", "Extra High"),
        ]
        .into_iter()
        .map(|(value, label)| AiReasoningCapability {
            value: value.into(),
            label: label.into(),
        })
        .collect()
    };
    AiProviderCapabilitiesResult {
        models: [
            ("gpt-5.5", "GPT-5.5"),
            ("gpt-5.4", "GPT-5.4"),
            ("gpt-5.4-mini", "GPT-5.4-Mini"),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (id, label))| AiModelCapability {
            id: id.into(),
            label: label.into(),
            description: None,
            supported_reasoning_efforts: efforts(),
            default_reasoning_effort: Some("medium".into()),
            is_default: index == 0,
        })
        .collect(),
        source: "fallback".into(),
        warning,
    }
}

fn parse_codex_capabilities(output: &Output) -> Result<AiProviderCapabilitiesResult, String> {
    if !output.status.success() {
        return Err(command_failure("Codex capability discovery", output));
    }
    parse_codex_capabilities_payload(&output.stdout)
}

fn parse_codex_capabilities_payload(bytes: &[u8]) -> Result<AiProviderCapabilitiesResult, String> {
    let payload: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("Codex returned invalid capability data: {error}"))?;
    let data = payload
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "Codex capability data did not include a model list.".to_string())?;
    let mut models = Vec::new();
    for item in data {
        if item.get("hidden").and_then(serde_json::Value::as_bool) == Some(true) {
            continue;
        }
        let id = item
            .get("model")
            .or_else(|| item.get("id"))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Codex returned a model without an id.".to_string())?;
        let supports_images = item
            .get("inputModalities")
            .and_then(serde_json::Value::as_array)
            .map(|modalities| {
                modalities
                    .iter()
                    .any(|modality| modality.as_str() == Some("image"))
            })
            .unwrap_or(true);
        if !supports_images {
            continue;
        }
        let label = item
            .get("displayName")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(id);
        let supported_reasoning_efforts = item
            .get("supportedReasoningEfforts")
            .and_then(serde_json::Value::as_array)
            .map(|efforts| {
                efforts
                    .iter()
                    .filter_map(|effort| {
                        let value = effort
                            .get("reasoningEffort")
                            .and_then(serde_json::Value::as_str)?;
                        Some(AiReasoningCapability {
                            value: value.into(),
                            label: codex_reasoning_effort_label(value),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        models.push(AiModelCapability {
            id: id.into(),
            label: label.into(),
            description: item
                .get("description")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            supported_reasoning_efforts,
            default_reasoning_effort: item
                .get("defaultReasoningEffort")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            is_default: item
                .get("isDefault")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        });
    }
    if models.is_empty() {
        return Err("Codex did not advertise any available models.".into());
    }
    Ok(AiProviderCapabilitiesResult {
        models,
        source: "appServer".into(),
        warning: None,
    })
}

fn codex_reasoning_effort_label(value: &str) -> String {
    match value {
        "none" => "None".into(),
        "minimal" => "Minimal".into(),
        "low" => "Low".into(),
        "medium" => "Medium".into(),
        "high" => "High".into(),
        "xhigh" => "Extra High".into(),
        other => other.into(),
    }
}

fn build_codex_sdk_command(
    codex_bin: &str,
    job_path: &Path,
    prompt_text: &str,
    image_paths: &[PathBuf],
    options: &CodexCommandOptions,
) -> Command {
    let codex_bin = managed_codex_bin_or(codex_bin);
    let mut command = Command::new(codex_sdk_node());
    apply_ai_cli_environment(&mut command)
        .current_dir(job_path)
        .arg(codex_sdk_runner_script())
        .arg("--cwd")
        .arg(job_path)
        .arg("--sandbox")
        .arg("workspace-write")
        .arg("--approval")
        .arg("never")
        .arg("--skip-git-repo-check");
    if !codex_bin.trim().is_empty() {
        command.arg("--codex-path").arg(codex_bin.as_ref());
    }
    if let Some(model) = options.model.as_deref() {
        command.arg("--model").arg(model);
    }
    if let Some(reasoning_effort) = options.reasoning_effort.as_deref() {
        command.arg("--reasoning").arg(reasoning_effort);
    }
    if matches!(options.service_tier.as_deref(), Some("fast")) {
        command.arg("--service-tier").arg("fast");
    }
    for path in image_paths {
        command.arg("--image").arg(path);
    }
    command
        .arg("--")
        .arg(prompt_text)
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY");
    command
}

fn gpt_image2_size_for_dimensions(dimensions: (u32, u32)) -> Option<String> {
    let (width, height) = dimensions;
    if width == 0 || height == 0 || width % 16 != 0 || height % 16 != 0 {
        return None;
    }
    let long = width.max(height);
    let short = width.min(height);
    let pixels = u64::from(width) * u64::from(height);
    if long > 3840 || long > short * 3 || pixels < 655_360 || pixels > 8_294_400 {
        return None;
    }
    Some(format!("{width}x{height}"))
}

fn write_codex_imagegen_options(
    job_path: &Path,
    dimensions: (u32, u32),
    options: &CodexCommandOptions,
) -> Result<(), String> {
    let payload = serde_json::json!({
        "model": "gpt-image-2",
        "size": gpt_image2_size_for_dimensions(dimensions).unwrap_or_else(|| "auto".to_string()),
        "quality": options.image_quality.as_deref().unwrap_or("auto"),
        "moderation": options.image_moderation.as_deref().unwrap_or("auto"),
        "background": "auto",
        "output_format": "png"
    });
    let text = serde_json::to_string_pretty(&payload)
        .map_err(|e| format!("Failed to encode Codex image-generation options: {e}"))?;
    fs::write(job_path.join("imagegen-options.json"), text)
        .map_err(|e| format!("Failed to write Codex image-generation options: {e}"))
}

fn codex_fill_director_contract(autonomy: AiAutonomyLevel) -> &'static str {
    match autonomy {
        AiAutonomyLevel::Unmanaged => {
            "Autonomy level: Unmanaged. Act only as the AI Director for PaintNode's owned image-generation runner. Do not invoke image generation yourself."
        }
        AiAutonomyLevel::Open => {
            "Autonomy level: Open. You may inspect the attached images visually, but do not run tools, write scripts, or invoke image generation. PaintNode owns image synthesis, resizing, masking, validation, and import."
        }
        AiAutonomyLevel::Guided => {
            "Autonomy level: Guided. Inspect the attached images visually and write the requested image-generation request file only. Do not run shell, Python, image-processing tools, or image generation."
        }
        AiAutonomyLevel::Low => {
            "Autonomy level: Low. Inspect the attached images visually and write the requested image-generation request file only. Do not call image-generation tools, do not run shell/Python/OpenCV/Pillow, and do not create helper scripts. PaintNode owns synthesis, resizing, masking, validation, and import."
        }
    }
}

fn director_action_file_contract(base_image: &str, prompt_label: &str) -> String {
    format!(
        r#"PaintNode Director tool loop:
- Do not create image pixels yourself and do not create `result.png`.
- Write `{PAINTNODE_DIRECTOR_ACTION_FILE}` as UTF-8 JSON in the current working directory.
- Choose exactly one Director action: `generateCandidate`, `acceptResult`, or `fail`.
- For the first turn, normally write a `generateCandidate` action that asks PaintNode's owned image tool to create the candidate.
- Allowed PaintNode tool action: `generateCandidate`. PaintNode will run the image model, write an observation naming the full candidate file, and attach a downscaled review preview of that candidate when your participation level requires review.

JSON schema:
{{
  "version": 1,
  "action": "generateCandidate",
  "baseImage": "{base_image}",
  "prompt": "{prompt_label}",
  "constraints": ["short constraints the image tool must obey"],
  "avoid": ["short negative constraints"],
  "notes": "optional short note for PaintNode"
}}"#
    )
}

fn director_review_criteria_section(
    workflow: &str,
    director_mode: AiDirectorMode,
    director_involvement: AiDirectorInvolvement,
) -> String {
    if director_mode == AiDirectorMode::Skip {
        return String::new();
    }
    let label = match director_involvement {
        AiDirectorInvolvement::PlanOnly => "Director planning criteria",
        AiDirectorInvolvement::EnsureCompletion | AiDirectorInvolvement::FullReview => {
            "Director review criteria"
        }
    };
    format!("\n{label}:\n{}\n", workflow_review_criteria(workflow))
}

fn codex_auth_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(codex_home) = std::env::var_os("CODEX_HOME") {
        paths.push(PathBuf::from(codex_home).join("auth.json"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        paths.push(PathBuf::from(home).join(".codex").join("auth.json"));
    }
    paths.sort();
    paths.dedup();
    paths
}

fn load_codex_chatgpt_auth_from_paths<I>(paths: I) -> Result<CodexChatGptAuth, String>
where
    I: IntoIterator<Item = PathBuf>,
{
    let mut checked_paths = Vec::new();
    for path in paths {
        checked_paths.push(path.display().to_string());
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let auth: CodexAuthJson = serde_json::from_str(&text)
            .map_err(|e| format!("Codex auth file at {} is invalid JSON: {e}", path.display()))?;
        let Some(tokens) = auth.tokens else {
            continue;
        };
        if tokens.access_token.trim().is_empty() {
            continue;
        }
        return Ok(CodexChatGptAuth {
            access_token: tokens.access_token,
            account_id: tokens.account_id.filter(|id| !id.trim().is_empty()),
        });
    }

    let suffix = if checked_paths.is_empty() {
        String::new()
    } else {
        format!(" Checked: {}.", checked_paths.join(", "))
    };
    Err(format!(
        "Codex ChatGPT login was not found.{suffix} Run `codex login` in Terminal, choose ChatGPT login, then try again."
    ))
}

fn load_codex_chatgpt_auth() -> Result<CodexChatGptAuth, String> {
    load_codex_chatgpt_auth_from_paths(codex_auth_paths())
}

fn codex_image_backend_base_url() -> String {
    std::env::var("PAINTNODE_CODEX_IMAGE_BASE_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "https://chatgpt.com/backend-api/codex".into())
}

fn image_edit_url(image_base_url: &str) -> String {
    format!("{}/images/edits", image_base_url.trim_end_matches('/'))
}

fn image_generation_url(image_base_url: &str) -> String {
    format!(
        "{}/images/generations",
        image_base_url.trim_end_matches('/')
    )
}

fn format_codex_image_request_error(context: &str, error: &reqwest::Error) -> String {
    let mut message = format!("{context}: {error}");
    let mut causes = Vec::new();
    let mut source = error.source();
    while let Some(cause) = source {
        causes.push(cause.to_string());
        source = cause.source();
    }
    if !causes.is_empty() {
        message.push_str("\n\nCause: ");
        message.push_str(&causes.join(": "));
    }
    if error.is_timeout() {
        message.push_str("\n\nThe request timed out while contacting ChatGPT. Check the network connection, VPN/proxy, and access to chatgpt.com, then retry.");
    } else if error.is_connect() {
        message.push_str("\n\nPaintNode could not connect to ChatGPT. Check the network connection, VPN/proxy, firewall, and access to chatgpt.com, then retry.");
    } else if error.is_request() || error.is_body() {
        message.push_str("\n\nThe image upload failed before ChatGPT returned a response. Retry once; if it repeats, try a smaller selected area or reference image.");
    }
    message
}

fn codex_image_http_client() -> Result<Client, String> {
    Client::builder()
        .http1_only()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(300))
        .user_agent("PaintNode Codex image generation")
        .build()
        .map_err(|e| {
            format_codex_image_request_error(
                "Failed to create Codex image generation HTTP client",
                &e,
            )
        })
}

fn codex_image_moderation_request_value(options: &CodexCommandOptions) -> &'static str {
    match options.image_moderation.as_deref() {
        Some("low") => "low",
        _ => "default",
    }
}

fn codex_image_size_request_value(size: (u32, u32)) -> String {
    gpt_image2_size_for_dimensions(size).unwrap_or_else(|| "auto".to_string())
}

fn codex_image_generation_request_json(
    prompt: &str,
    size: (u32, u32),
    options: &CodexCommandOptions,
) -> serde_json::Value {
    json!({
        "prompt": prompt,
        "background": "auto",
        "model": "gpt-image-2",
        "size": codex_image_size_request_value(size),
        "quality": options.image_quality.as_deref().unwrap_or("auto"),
        "moderation": codex_image_moderation_request_value(options),
        "output_format": "png",
    })
}

fn codex_image_edit_request_json(
    prompt: &str,
    image_data_urls: Vec<String>,
    size: (u32, u32),
    options: &CodexCommandOptions,
) -> serde_json::Value {
    let images = image_data_urls
        .into_iter()
        .map(|image_url| json!({ "image_url": image_url }))
        .collect::<Vec<_>>();
    json!({
        "images": images,
        "prompt": prompt,
        "background": "auto",
        "model": "gpt-image-2",
        "size": codex_image_size_request_value(size),
        "moderation": codex_image_moderation_request_value(options),
    })
}

fn png_data_url_from_bytes(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", BASE64_STANDARD.encode(bytes))
}

fn decode_generated_image_response(response: CodexImageResponse) -> Result<Vec<u8>, String> {
    let b64 = response
        .data
        .into_iter()
        .next()
        .map(|data| data.b64_json)
        .ok_or_else(|| "Codex image generation returned no image data.".to_string())?;
    BASE64_STANDARD
        .decode(b64.trim().as_bytes())
        .map_err(|e| format!("Codex image generation returned invalid PNG data: {e}"))
}

fn run_codex_direct_image_request(
    prompt: &str,
    image_paths: &[PathBuf],
    size: (u32, u32),
    options: &CodexCommandOptions,
    job_path: Option<&Path>,
) -> Result<Vec<u8>, String> {
    let auth = load_codex_chatgpt_auth()?;
    let image_data_urls = image_paths
        .iter()
        .map(|path| {
            let bytes = fs::read(path)
                .map_err(|e| format!("Failed to read image input at {}: {e}", path.display()))?;
            if !is_png(&bytes) {
                return Err(format!("Image input at {} is not a PNG.", path.display()));
            }
            Ok(png_data_url_from_bytes(&bytes))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let image_base_url = codex_image_backend_base_url();
    let (url, request_body) = if image_data_urls.is_empty() {
        (
            image_generation_url(&image_base_url),
            codex_image_generation_request_json(prompt, size, options),
        )
    } else {
        (
            image_edit_url(&image_base_url),
            codex_image_edit_request_json(prompt, image_data_urls, size, options),
        )
    };
    if let Some(job_path) = job_path {
        if !options.keep_debug_artifacts {
            remove_codex_debug_artifacts(job_path);
        }
    }
    if let Some(job_path) = job_path.filter(|_| options.keep_debug_artifacts) {
        let request_text = serde_json::to_vec_pretty(&request_body)
            .map_err(|e| format!("Failed to encode Codex image request for inspection: {e}"))?;
        fs::write(
            job_path.join(PAINTNODE_CODEX_IMAGE_REQUEST_FILE),
            request_text,
        )
        .map_err(|e| format!("Failed to write Codex image request: {e}"))?;
    }
    let client = codex_image_http_client()?;
    let mut request = client
        .post(url)
        .bearer_auth(auth.access_token)
        .json(&request_body);
    if let Some(account_id) = auth.account_id {
        request = request.header("ChatGPT-Account-ID", account_id);
    }
    let response = request.send().map_err(|e| {
        format_codex_image_request_error("Codex image generation request failed", &e)
    })?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Codex image generation response could not be read: {e}"))?;
    if let Some(job_path) = job_path.filter(|_| options.keep_debug_artifacts) {
        let _ = fs::write(job_path.join(PAINTNODE_CODEX_IMAGE_RESPONSE_FILE), &text);
    }
    if !status.is_success() {
        let detail = output_tail(text.as_bytes());
        let auth_hint = if status.as_u16() == 401 || status.as_u16() == 403 {
            " Run `codex login` in Terminal to refresh your ChatGPT session."
        } else {
            ""
        };
        return Err(format!(
            "Codex image generation failed with HTTP {status}.{auth_hint}\n\n{detail}"
        ));
    }
    let parsed: CodexImageResponse = serde_json::from_str(&text)
        .map_err(|e| format!("Codex image generation response was invalid JSON: {e}"))?;
    decode_generated_image_response(parsed)
}

#[cfg(test)]
pub(crate) fn codex_direct_generate_prompt(
    user_prompt: &str,
    reference_names: &[String],
) -> String {
    codex_direct_generate_director_prompt(
        user_prompt,
        reference_names,
        AiDirectorProvider::Codex,
        AiDirectorMode::Auto,
        AiDirectorInvolvement::FullReview,
    )
}

pub(crate) fn codex_direct_generate_director_prompt(
    user_prompt: &str,
    reference_names: &[String],
    director_provider: AiDirectorProvider,
    director_mode: AiDirectorMode,
    director_involvement: AiDirectorInvolvement,
) -> String {
    let reference_note = reference_prompt_note(reference_names, "");
    let director_contract = ai_director_workflow_contract(
        director_provider,
        director_mode,
        director_involvement,
        "image generation",
    );
    format!(
        r#"Generate exactly one raster PNG for PaintNode.

User image prompt:
{user_prompt}

{reference_note}

{director_contract}

Requirements:
- Create one polished image from the user prompt.
- Use any attached images as visual references for style, identity, composition, subject matter, or materials as implied by the prompt.
- Do not create a collage, contact sheet, process diagram, UI screenshot, watermark, caption, or border unless the user explicitly asks for that.
- Do not ask follow-up questions; make reasonable visual choices from the prompt.
- If the prompt needs a safety or quality adjustment, make the smallest compliant adjustment while preserving the user's intent."#
    )
}

#[cfg(test)]
fn decouple_codex_prompt(user_prompt: &str) -> String {
    decouple_codex_director_prompt(
        user_prompt,
        AiDirectorProvider::Codex,
        AiDirectorMode::Auto,
        AiDirectorInvolvement::FullReview,
    )
}

fn decouple_codex_director_prompt(
    user_prompt: &str,
    director_provider: AiDirectorProvider,
    director_mode: AiDirectorMode,
    director_involvement: AiDirectorInvolvement,
) -> String {
    let director_contract = ai_director_workflow_contract(
        director_provider,
        director_mode,
        director_involvement,
        "asset decoupling",
    );
    let director_review_criteria =
        director_review_criteria_section("decouple", director_mode, director_involvement);
    format!(
        r##"Use the attached `source.png` to create a PaintNode recomposition asset pack.

User guidance:
{user_prompt}

{director_contract}
{director_review_criteria}

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

#[cfg(test)]
fn build_decouple_codex_command(
    codex_bin: &str,
    job_path: &Path,
    prompt: &str,
    options: &CodexCommandOptions,
    json_progress: bool,
) -> Command {
    build_decouple_codex_director_command(
        codex_bin,
        job_path,
        prompt,
        options,
        AiDirectorProvider::Codex,
        AiDirectorMode::Auto,
        AiDirectorInvolvement::FullReview,
        json_progress,
    )
}

fn build_decouple_codex_director_command(
    codex_bin: &str,
    job_path: &Path,
    prompt: &str,
    options: &CodexCommandOptions,
    director_provider: AiDirectorProvider,
    director_mode: AiDirectorMode,
    director_involvement: AiDirectorInvolvement,
    _json_progress: bool,
) -> Command {
    let prompt_text = decouple_codex_director_prompt(
        prompt.trim(),
        director_provider,
        director_mode,
        director_involvement,
    );
    let image_paths = vec![job_path.join("source.png")];
    build_codex_sdk_command(codex_bin, job_path, &prompt_text, &image_paths, options)
}

fn codex_direct_workflow_compose_prompt(prompt: &str, source_names: &[String]) -> String {
    let sources = source_names
        .iter()
        .enumerate()
        .map(|(i, name)| format!("{}. {}", i + 1, name))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"Compose exactly one new raster PNG for PaintNode from the attached workflow asset images.

Connected workflow inputs:
{sources}

Composition prompt:
{prompt}

Requirements:
- Treat every attached image as intentionally connected to the composition node.
- The final PNG must visibly include every mandatory connected asset unless the prompt explicitly says to omit it.
- This is a generative synthesis task, not a cut-and-paste compositing task: use the attached assets as references for identity, appearance, objects, environment, style, layout, lighting, and scale.
- Reconstruct the final scene naturally instead of making a collage, contact sheet, sticker-board, or obvious paste-up.
- Preserve normal real-world structure unless the prompt asks for surreal or impossible results.
- If a storyboard sketch is attached, treat it as the primary spatial plan: preserve relative placement, left/right ordering, scale relationships, pose, prop positions, environment zones, and major negative space without copying the sketch style.
- If the prompt describes a person holding or interacting with a prop, the person and prop must both be visible and physically connected in the final image.
- Pay special attention to human anatomy, hands, held objects, contact shadows, perspective, and lighting.
- Do not include PaintNode UI, borders, labels, watermarks, or explanatory text unless explicitly requested.
- If a safety or quality adjustment is needed, make the smallest compliant adjustment while preserving the composition intent."#
    )
}

#[cfg(test)]
fn generative_fill_prompt(
    prompt: &str,
    autonomy: AiAutonomyLevel,
    geometry_note: &str,
    storyboard_note: &str,
    storyboard_anchor: bool,
    storyboard_fallback: bool,
    has_overview: bool,
    has_storyboard_draft: bool,
    reference_names: &[String],
) -> String {
    generative_fill_director_prompt(
        prompt,
        autonomy,
        AiDirectorProvider::Codex,
        AiDirectorMode::Auto,
        AiDirectorInvolvement::FullReview,
        geometry_note,
        storyboard_note,
        storyboard_anchor,
        storyboard_fallback,
        has_overview,
        has_storyboard_draft,
        reference_names,
    )
}

fn generative_fill_director_prompt(
    prompt: &str,
    autonomy: AiAutonomyLevel,
    director_provider: AiDirectorProvider,
    director_mode: AiDirectorMode,
    director_involvement: AiDirectorInvolvement,
    geometry_note: &str,
    storyboard_note: &str,
    storyboard_anchor: bool,
    storyboard_fallback: bool,
    has_overview: bool,
    has_storyboard_draft: bool,
    reference_names: &[String],
) -> String {
    let autonomy_contract = codex_fill_director_contract(autonomy);
    let director_contract = ai_director_workflow_contract(
        director_provider,
        director_mode,
        director_involvement,
        "generative fill",
    );
    let agentic_tool_loop = director_uses_agentic_loop(director_mode, director_involvement);
    let task_intro =
        "Plan one PaintNode-controlled generative fill image request from the attached frame.";
    let request_file_requirement = if agentic_tool_loop {
        format!(
            "- Write `{PAINTNODE_DIRECTOR_ACTION_FILE}` as UTF-8 JSON in the current working directory.\n- Choose exactly one Director action: `generateCandidate`, `acceptResult`, or `fail`.\n"
        )
    } else {
        format!(
            "- Write `{PAINTNODE_IMAGE_REQUEST_FILE}` as UTF-8 JSON in the current working directory.\n"
        )
    };
    let request_subject = if agentic_tool_loop {
        "The `generateCandidate` action"
    } else {
        "The request"
    };
    let managed_method_requirements = if agentic_tool_loop {
        format!(
            "- Do not invoke image-generation tools yourself and do not create `result.png`. PaintNode will execute the image tool after reading `{PAINTNODE_DIRECTOR_ACTION_FILE}`.\n- Do not create `{PAINTNODE_IMAGE_REQUEST_FILE}` directly while using the Director tool loop.\n- Do not create, edit, or delete any other files in the working directory except `{PAINTNODE_DIRECTOR_ACTION_FILE}`.\n"
        )
    } else if autonomy == AiAutonomyLevel::Unmanaged {
        format!(
            "- Do not invoke image-generation tools yourself and do not create `result.png`. Write only `{PAINTNODE_IMAGE_REQUEST_FILE}`; PaintNode will run its owned image generator after reading that request.\n"
        )
    } else {
        format!(
            "- Do not invoke image-generation tools yourself and do not create `result.png`. Write only `{PAINTNODE_IMAGE_REQUEST_FILE}`; PaintNode will run its owned image generator after reading that request.\n- Do not create, edit, or delete any other files in the working directory.\n"
        )
    };
    let reference_note = reference_prompt_note(reference_names, "");
    let has_storyboard = !storyboard_note.trim().is_empty();
    let director_json_schema = if agentic_tool_loop {
        format!(
            r#"{{
  "version": 1,
  "action": "generateCandidate",
  "baseImage": "source.png",
  "prompt": "image prompt for PaintNode's owned generator",
  "constraints": ["short constraints the generator must obey"],
  "avoid": ["short negative constraints"],
  "notes": "optional short note for PaintNode"
}}

After PaintNode writes `{PAINTNODE_DIRECTOR_OBSERVATION_FILE}` and attaches a downscaled review preview on a full-review turn, inspect `source.png`, the observation, and the preview of the latest candidate. If the full candidate named in the observation is faithful, write:
{{
  "version": 1,
  "action": "acceptResult",
  "candidate": "latest",
  "notes": "short acceptance note"
}}

If the candidate is blocked, missing, over-retouched, compositionally wrong, or otherwise unfaithful, write another `generateCandidate` action with the smallest revised prompt needed. If the task cannot be completed faithfully, write:
{{
  "version": 1,
  "action": "fail",
  "reason": "short reason"
}}"#
        )
    } else {
        String::new()
    };
    let legacy_json_schema = |kind: &str| {
        format!(
            r#"{{
  "version": 1,
  "kind": "{kind}",
  "baseImage": "source.png",
  "prompt": "enhanced image prompt for PaintNode's owned generator",
  "constraints": ["short constraints the generator must obey"],
  "avoid": ["short negative constraints"],
  "notes": "optional short note for PaintNode"
}}"#
        )
    };
    let final_response_file = if agentic_tool_loop {
        PAINTNODE_DIRECTOR_ACTION_FILE
    } else {
        PAINTNODE_IMAGE_REQUEST_FILE
    };
    let review_requirement = if agentic_tool_loop {
        match director_involvement {
            AiDirectorInvolvement::EnsureCompletion => {
                "- If PaintNode reports that the image tool failed, recover by writing another `generateCandidate` action with the smallest faithful prompt adjustment. PaintNode will accept the first completed candidate without a separate quality-review turn.\n"
            }
            AiDirectorInvolvement::FullReview => {
                "- After PaintNode generates a candidate and reports the observation, review the candidate against `source.png`, the prompt, protected context, grain/texture, exposure character, and style intent before accepting. Retry with a revised `generateCandidate` action when the candidate is not faithful enough.\n"
            }
            AiDirectorInvolvement::PlanOnly => "",
        }
    } else {
        ""
    };
    let overview_note = if has_overview {
        "\n2. `overview.png` may be present as a downscaled surrounding-document preview with a red outline around this local frame. Use it only as non-editable composition and continuity guidance. `source.png` is the only base/edit image; never use `overview.png` as the source or base image, never copy its pixels or resolution, and never reproduce the red outline."
    } else {
        ""
    };
    if has_storyboard_draft {
        return format!(
            r#"Plan one PaintNode draft enhancement image request controlled by PaintNode.

Input files:
1. `source.png` is the PaintNode edit frame to enhance. It already contains the orchestrator's rough low-detail visual draft.
{overview_note}

{geometry_note}

{director_contract}

Task:
- This is an image enhancement/restoration pass at the same size, not a new composition, new generative fill, outpaint, story continuation, or scene redesign.
- Improve clarity, texture, natural detail, edge quality, lighting consistency, and local realism only for pixels already visible in the low-detail draft.
- Preserve the exact subject count, object count, identities/classes, poses, placement, scale, camera angle, horizon, shoreline, lighting, colors, and activities already visible in `source.png`.
- Do not add, remove, duplicate, replace, move, resize, re-pose, or reinterpret any visible person, object, prop, landform, wave, cloud, or scene element.
- If a draft area is soft or ambiguous, refine the existing visible shapes conservatively instead of inventing extra content.

{autonomy_contract}

Requirements:
{request_file_requirement}- {request_subject} must describe an in-place enhancement of `source.png`, not a newly composed independent image.
- {request_subject} must instruct PaintNode's owned generator to use `source.png` as the only base image. Do not use `overview.png` as the image source, edit target, or output template.
- Keep the attached frame registered: no crop, zoom, reframe, or shift.
- PaintNode will crop, paste, and apply the editable mask after import. Do not draw mask edges, gray buffers, borders, or guides into the pixels.
- Do not include PaintNode UI, checkerboard transparency pattern, selection outlines, red guide marks, borders, labels, or mask visualization in the output.
{managed_method_requirements}
{review_requirement}
- Do not ask follow-up questions.
- If a safety or quality adjustment is needed, make a reasonable compliant rephrasing while preserving the existing visible draft content and composition.

JSON schema:
{}

Final response should be one short sentence confirming `{final_response_file}` was created."#,
            if agentic_tool_loop {
                director_json_schema.clone()
            } else {
                legacy_json_schema("draft_enhancement")
            }
        );
    }
    if has_storyboard {
        let source_input_note = if has_storyboard_draft {
            "is the current PaintNode content for this edit frame. In unpainted editable areas, it already contains the orchestrator's rough visual draft."
        } else {
            "is the current PaintNode content for this edit frame."
        };
        let storyboard_instruction_note = if has_storyboard_draft {
            "- Use the orchestrator note only to identify what the visible low-detail draft is meant to contain.\n- Retouch/up-res the low-detail draft already present in `source.png`; do not ignore it, replace it with a new composition, or start from blank.\n- The visible draft is the composition authority. Preserve its subject count, placement, pose, activity, horizon, shoreline, lighting, camera, and scale, and add no new people, props, activities, story beats, or separate scenes beyond what is already visible in the draft."
        } else {
            "- Use the orchestrator subtask prompt above as the local image instruction."
        };
        let fallback_prompt = if storyboard_fallback && storyboard_anchor {
            format!(
                "\nFallback anchor user prompt:\n{prompt}\n\nUse this only because the orchestrator plan fell back; the orchestrator subtask prompt remains the main local instruction.\n"
            )
        } else {
            String::new()
        };
        return format!(
            r#"{task_intro}

Input files:
1. `source.png` {source_input_note}
{overview_note}

{reference_note}

{geometry_note}

{director_contract}

{storyboard_note}{fallback_prompt}

{autonomy_contract}

Requirements:
{request_file_requirement}- {request_subject} must describe an in-place edit of `source.png`, not a newly composed independent image.
{storyboard_instruction_note}
- {request_subject} must instruct PaintNode's owned generator to use `source.png` as the only base image. Do not use `overview.png` as the image source, edit target, or output template.
- Keep the attached frame registered: no crop, zoom, reframe, or shift.
- PaintNode will crop, paste, and apply the editable mask after import. Do not draw mask edges, gray buffers, borders, or guides into the pixels.
- Do not include PaintNode UI, checkerboard transparency pattern, selection outlines, red guide marks, borders, labels, or mask visualization in the output.
{managed_method_requirements}
{review_requirement}
- Do not ask follow-up questions.
- If a safety or quality adjustment is needed, make a reasonable compliant rephrasing and continue.

JSON schema:
{}

Final response should be one short sentence confirming `{final_response_file}` was created."#,
            if agentic_tool_loop {
                director_json_schema.clone()
            } else {
                legacy_json_schema("generative_fill")
            }
        );
    }
    let user_prompt_heading = "Original user edit prompt:";
    format!(
        r#"{task_intro}

Input files:
1. `source.png` is the current content of the document area being edited.
{overview_note}

{reference_note}

{geometry_note}

{director_contract}

{storyboard_note}

{user_prompt_heading}
{prompt}

{autonomy_contract}

Requirements:
- Prefer one full PNG with the exact same framing as `source.png`.
{request_file_requirement}- {request_subject} must describe an in-place edit of `source.png`, not a newly composed photograph.
- {request_subject} must instruct PaintNode's owned generator to use `source.png` as the only base image. Do not use `overview.png` as the image source, edit target, or output template.
- Fill the intended editable/empty area implied by the attached frame and prompt, matching surrounding scene, perspective, lighting, focus, color, grain, and camera style.
- Keep existing visible context stable and registered. PaintNode will crop, paste, and apply the editable mask after import.
- Do not include PaintNode UI, checkerboard transparency pattern, selection outlines, red guide marks, borders, labels, or mask visualization in the output.
- If extending a real photo, avoid inventing crisp readable text in newly generated distant signs or advertisements; partial or indistinct text is preferable.
{managed_method_requirements}
{review_requirement}
- Do not ask follow-up questions.
- If a safety or quality adjustment is needed, make a reasonable compliant rephrasing and continue.

JSON schema:
{}

Final response should be one short sentence confirming `{final_response_file}` was created."#,
        if agentic_tool_loop {
            director_json_schema
        } else {
            legacy_json_schema("generative_fill")
        }
    )
}

fn build_generative_fill_codex_command(
    codex_bin: &str,
    job_path: &Path,
    prompt_text: &str,
    has_overview: bool,
    storyboard_draft_paths: &[PathBuf],
    reference_paths: &[PathBuf],
    options: &CodexCommandOptions,
    _json_progress: bool,
) -> Command {
    let mut image_paths = vec![job_path.join("source.png")];
    if has_overview {
        image_paths.push(job_path.join("overview.png"));
    }
    image_paths.extend(storyboard_draft_paths.iter().cloned());
    image_paths.extend(reference_paths.iter().cloned());
    build_codex_sdk_command(codex_bin, job_path, prompt_text, &image_paths, options)
}

fn build_fill_storyboard_codex_command(
    codex_bin: &str,
    job_path: &Path,
    prompt_text: &str,
    has_overview: bool,
    reference_paths: &[PathBuf],
    options: &CodexCommandOptions,
    _json_progress: bool,
) -> Command {
    let mut image_paths = Vec::new();
    if has_overview {
        image_paths.push(job_path.join(FILL_STORYBOARD_OVERVIEW_FILE));
    }
    image_paths.extend(reference_paths.iter().cloned());
    build_codex_sdk_command(codex_bin, job_path, prompt_text, &image_paths, options)
}

fn ai_retouch_attached_image_notes(
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

#[cfg(test)]
fn codex_direct_retouch_prompt(
    prompt: &str,
    has_annotated_source: bool,
    has_reference: bool,
    reference_names: &[String],
    geometry_note: &str,
) -> String {
    codex_direct_retouch_director_prompt(
        prompt,
        has_annotated_source,
        has_reference,
        reference_names,
        geometry_note,
        AiDirectorProvider::Codex,
        AiDirectorMode::Auto,
        AiDirectorInvolvement::FullReview,
    )
}

fn codex_direct_retouch_director_prompt(
    prompt: &str,
    has_annotated_source: bool,
    has_reference: bool,
    reference_names: &[String],
    geometry_note: &str,
    director_provider: AiDirectorProvider,
    director_mode: AiDirectorMode,
    director_involvement: AiDirectorInvolvement,
) -> String {
    let attached_image_notes =
        ai_retouch_attached_image_notes(has_annotated_source, has_reference, reference_names);
    let director_contract = ai_director_workflow_contract(
        director_provider,
        director_mode,
        director_involvement,
        "AI retouch",
    );
    let agentic_tool_loop = director_uses_agentic_loop(director_mode, director_involvement);
    let director_tool_contract = if agentic_tool_loop {
        format!(
            "\n{}\n{}",
            director_action_file_contract(
                "edit_target.png",
                "in-place retouch prompt for PaintNode's owned image tool"
            ),
            director_review_criteria_section("retouch", director_mode, director_involvement)
        )
    } else {
        director_review_criteria_section("retouch", director_mode, director_involvement)
    };
    let opening = if agentic_tool_loop {
        "Act as PaintNode's AI Director for one in-place PaintNode retouch."
    } else {
        "Perform one in-place PaintNode retouch and return exactly one full-canvas PNG candidate."
    };
    let output_requirements = if agentic_tool_loop {
        "- The `generateCandidate` action must request one full-canvas PNG candidate with the same dimensions and framing as `edit_target.png`.\n- The candidate must not include PaintNode UI, checkerboard transparency, selection outlines, borders, labels, red arrows, yellow callout boxes, annotation text, guide marks, or mask visualization.\n- If a safety or quality adjustment is needed, make the smallest compliant prompt adjustment while keeping the edit inside the mask."
    } else {
        "- Return one full-canvas PNG candidate with the same dimensions and framing as `edit_target.png`.\n- Do not include PaintNode UI, checkerboard transparency, selection outlines, borders, labels, red arrows, yellow callout boxes, annotation text, guide marks, or mask visualization.\n- If a safety or quality adjustment is needed, make the smallest compliant adjustment while keeping the edit inside the mask."
    };
    format!(
        r#"{opening}

This is a fixed-canvas image editing task, not a new image generation task.

Attached images:
1. `source.png` is the original source image.
2. `edit_target.png` is the exact base image to edit in place.
3. `mask.png` is the edit permission mask:
   - White pixels are editable.
   - Gray pixels are a feathered blend buffer.
   - Black pixels are locked context.
   - Transparent pixels are locked context and must remain unchanged.{attached_image_notes}

{geometry_note}

{director_contract}
{director_tool_contract}

Critical registration rule:
Do not translate, shift, crop, zoom, rotate, scale, stretch, warp, resize, reframe, straighten, or change the camera perspective.
The output must stay registered to `edit_target.png`.

User retouch prompt:
{prompt}

Retouch scope:
- Only change pixels necessary to satisfy the user retouch prompt.
- The visible edit must stay inside the white/gray mask footprint.
- Do not use the mask as an instruction to repaint everything inside it.
- Do not change unrequested content inside the mask.
- Make the candidate visually identical to `source.png` everywhere `mask.png` is black or transparent.
- If the requested edit cannot be completed without moving, resizing, or reframing the subject or camera, simplify the edit instead.

Person preservation:
You may redraw clothing inside the editable area, but do not move or rescale the person.
Preserve identity, face, hair, skin, hands, pose, body proportions, expression, gaze, lighting direction, focus, grain, and camera style unless the user explicitly asks to alter those details.

Output requirements:
{output_requirements}"#
    )
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
pub(crate) async fn detect_codex(bin: Option<String>) -> Result<CodexDetectionResult, String> {
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

        let mut command = Command::new(&codex_bin);
        apply_ai_cli_environment(&mut command)
            .arg("--version")
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_API_KEY");

        match command.output() {
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
pub(crate) async fn discover_codex_capabilities(
    bin: Option<String>,
) -> Result<AiProviderCapabilitiesResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(codex_sdk_node());
        apply_ai_cli_environment(&mut command).arg(codex_capabilities_runner_script());
        if let Some(bin) = configured_codex_bin(bin).or_else(|| {
            crate::managed_runtime::managed_executable("codex")
                .map(|path| path.to_string_lossy().into_owned())
        }) {
            command.arg("--codex-path").arg(bin);
        }
        command
            .env_remove("OPENAI_API_KEY")
            .env_remove("CODEX_API_KEY");
        match command.output() {
            Ok(output) => parse_codex_capabilities(&output)
                .unwrap_or_else(|error| fallback_codex_capabilities(Some(error))),
            Err(error) => fallback_codex_capabilities(Some(format!(
                "Failed to launch Codex capability discovery: {error}"
            ))),
        }
    })
    .await
    .map_err(|error| format!("Task error: {error}"))
}

/// Run local Codex headlessly to generate an image into a temp job folder.
///
/// Auth is intentionally left to the user's local Codex installation. This command never reads
/// Codex auth files and strips API-key environment variables so this provider prefers the user's
/// existing ChatGPT/Codex sign-in rather than accidental API billing.
#[tauri::command]
pub(crate) async fn generate_codex_image(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    keep_job_dir: Option<bool>,
    keep_debug_artifacts: Option<bool>,
    reference_pngs: Vec<WorkflowSourceImage>,
    run_id: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    image_quality: Option<String>,
    image_moderation: Option<String>,
    autonomy_level: Option<String>,
    director_mode: Option<String>,
    director_provider: Option<String>,
    director_involvement: Option<String>,
    target_width: Option<u32>,
    target_height: Option<u32>,
) -> Result<GeneratedImageResult, String> {
    if prompt.trim().is_empty() {
        return Err("Enter a prompt.".into());
    }
    validate_reference_pngs(&reference_pngs, "Generate image")?;
    let target_dimensions = validate_optional_target_dimensions(target_width, target_height)?;

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let mut codex_options = codex_command_options(
            model,
            reasoning_effort,
            service_tier,
            image_quality,
            image_moderation,
        );
        codex_options.keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        let codex_bin = configured_codex_bin_or_sdk_default(bin);
        let _ = autonomy_level;
        let director_mode = ai_director_mode(director_mode);
        let director_provider = ai_director_provider(director_provider);
        let director_involvement = ai_director_involvement(director_involvement);
        let run_id = if run_id.trim().is_empty() {
            format!("codex-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
        let project_dir = optional_project_dir(&project_path);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let job_project_dir = ai_job_project_dir(&app, &project_dir, keep_job_dir)?;
        let cleanup_project_job = cleanup_project_job_enabled(&job_project_dir, keep_job_dir);
        let temp_job;
        let job_path = if let Some(job_project_dir) = &job_project_dir {
            project_agent_run_dir_for_run(job_project_dir, CODEX_RUNS_DIR, "run", &run_id)?
        } else {
            temp_job = TempJobDir::new("paintnode-codex")?;
            temp_job.path().to_path_buf()
        };
        write_codex_imagegen_options(
            &job_path,
            target_dimensions.unwrap_or((0, 0)),
            &codex_options,
        )?;
        let (reference_paths, reference_names) =
            write_reference_pngs(&job_path, &reference_pngs, "Generate image")?;
        let prompt_text = codex_direct_generate_director_prompt(
            prompt.trim(),
            &reference_names,
            director_provider,
            director_mode,
            director_involvement,
        );
        write_ai_job_prompt(&job_path, &prompt_text, "Codex image generation")?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);
        // A failed previous attempt may have gotten past generation; reuse its
        // image instead of paying for another one.
        let result_path = job_path.join("result.png");
        let (recovered_source_path, staged_result_path) = if result_path.exists()
            && file_has_png_signature(&result_path)
            && png_dimensions(&result_path).is_ok()
        {
            emit_codex_progress(&app, &run_id, "Reusing the previously generated image");
            (result_path.clone(), result_path)
        } else if let Some(previous) = newest_previous_generated_png(&job_path) {
            emit_codex_progress(&app, &run_id, "Reusing the previously generated image");
            (previous.clone(), previous)
        } else {
            emit_codex_progress(&app, &run_id, "Requesting PaintNode Codex image generation");
            let raw_bytes = run_codex_direct_image_request(
                &prompt_text,
                &reference_paths,
                target_dimensions.unwrap_or((0, 0)),
                &codex_options,
                Some(&job_path),
            )?;
            fs::write(&result_path, &raw_bytes)
                .map_err(|e| format!("Failed to write generated image: {e}"))?;
            (result_path.clone(), result_path)
        };

        emit_codex_progress(&app, &run_id, "Reading generated PNG");
        let raw_bytes = fs::read(&staged_result_path)
            .map_err(|e| format!("Failed to read generated image: {e}"))?;
        png_dimensions_from_bytes(&raw_bytes)
            .ok_or_else(|| "Codex generated image PNG dimensions are invalid.".to_string())?;
        let bytes = if let Some(target) = target_dimensions {
            let (mut bytes, source_dimensions, upscale_factor) =
                cover_crop_png_to_dimensions(&raw_bytes, target, "Codex generated image")?;
            if source_dimensions != target {
                emit_codex_progress(
                    &app,
                    &run_id,
                    &format!(
                        "Cover-cropped Codex result from {}x{} to {}x{}",
                        source_dimensions.0, source_dimensions.1, target.0, target.1
                    ),
                );
            }
            if upscale_factor > AI_RESTORE_UPSCALE_THRESHOLD {
                emit_codex_progress(
                    &app,
                    &run_id,
                    &format!("Result enlarged {upscale_factor:.2}x; restoring image detail"),
                );
                let (restored, _) = codex_restore_image_details(
                    &app,
                    &run_id,
                    &codex_bin,
                    &codex_options,
                    &job_path.join("restore"),
                    &bytes,
                    "Generated image restoration",
                    false,
                    true,
                    director_provider,
                    director_mode,
                    director_involvement,
                )?;
                bytes = restored.ok_or_else(|| {
                    "Generated image restoration did not return a composed result.".to_string()
                })?;
                fs::write(job_path.join("restore").join("result.png"), &bytes)
                    .map_err(|e| format!("Failed to write restored generated image: {e}"))?;
            }
            bytes
        } else {
            raw_bytes
        };
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
            let asset = ProjectAsset::generated_png(
                id,
                relative_path,
                source_file_name
                    .map(str::to_string)
                    .unwrap_or_else(|| prompt.trim().chars().take(48).collect::<String>()),
                Some(prompt.trim().into()),
                source_file_name.map(str::to_string),
            );
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
            layers: Vec::new(),
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

struct CodexPartRun {
    normalized_png: Vec<u8>,
    result_dimensions: (u32, u32),
    normalized: bool,
    recovered_source_path: PathBuf,
}

fn read_storyboard_draft(job_path: &Path) -> Result<Option<Vec<u8>>, String> {
    let draft_path = job_path.join(FILL_STORYBOARD_DRAFT_FILE);
    let Ok(draft_png) = fs::read(&draft_path) else {
        return Ok(None);
    };
    if !is_png(&draft_png) {
        return Ok(None);
    }
    Ok(Some(draft_png))
}

fn remove_legacy_storyboard_part_guides(part_path: &Path) {
    let _ = fs::remove_file(part_path.join(FILL_STORYBOARD_DRAFT_FILE));
    let _ = fs::remove_file(part_path.join("storyboard-draft-crop.png"));
}

fn normalize_storyboard_draft_result(
    job_path: &Path,
    placement: &AiEditPlacement,
) -> Result<bool, String> {
    let draft_path = job_path.join(FILL_STORYBOARD_DRAFT_FILE);
    let Ok(draft_png) = fs::read(&draft_path) else {
        return Ok(false);
    };
    if !is_png(&draft_png) {
        return Ok(false);
    }
    let (normalized, _source_dimensions, changed) = normalize_storyboard_draft_png(
        &draft_png,
        placement.document_dimensions,
        "Codex fill storyboard draft",
    )?;
    if changed {
        fs::write(&draft_path, normalized).map_err(|e| {
            format!(
                "Failed to normalize generative fill storyboard draft at {}: {e}",
                draft_path.display()
            )
        })?;
    }
    Ok(changed)
}

#[allow(clippy::too_many_arguments)]
fn run_codex_fill_storyboard(
    app: &AppHandle,
    run_id: &str,
    codex_bin: &str,
    options: &CodexCommandOptions,
    job_path: &Path,
    prompt_text: &str,
    has_overview: bool,
    reference_paths: &[PathBuf],
) -> Result<(), String> {
    let codex_started_at = SystemTime::now();
    let mut command = build_fill_storyboard_codex_command(
        codex_bin,
        job_path,
        prompt_text,
        has_overview,
        reference_paths,
        options,
        true,
    );
    let mut run =
        run_codex_with_progress(&mut command, app.clone(), run_id.to_string()).map_err(|e| {
            format!(
                "Failed to run Codex at '{}': {e}",
                codex_command_label(&codex_bin)
            )
        })?;

    if !run.output.status.success() && output_mentions_unsupported_json(&run.output) {
        emit_codex_progress(
            app,
            run_id,
            "Codex progress stream unavailable; retrying storyboard planning",
        );
        let mut fallback = build_fill_storyboard_codex_command(
            codex_bin,
            job_path,
            prompt_text,
            has_overview,
            reference_paths,
            options,
            false,
        );
        run = run_codex_with_progress(&mut fallback, app.clone(), run_id.to_string()).map_err(
            |e| {
                format!(
                    "Failed to run Codex at '{}': {e}",
                    codex_command_label(&codex_bin)
                )
            },
        )?;
    }

    if !run.output.status.success() && !job_path.join(FILL_STORYBOARD_FILE).exists() {
        if let Some(message) = final_codex_agent_message(&run.output) {
            return Err(format!(
                "Codex did not create storyboard.json.\n\n{message}"
            ));
        }
        return Err(command_failure("Codex fill storyboard", &run.output));
    }

    let draft_path = job_path.join(FILL_STORYBOARD_DRAFT_FILE);
    if !draft_path.exists() {
        if let Some((_source_path, staged_path)) =
            copy_codex_cached_png_to_job(job_path, run.thread_id.as_deref(), codex_started_at)?
        {
            let _ = fs::copy(staged_path, draft_path);
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn prepare_codex_fill_storyboard(
    app: &AppHandle,
    run_id: &str,
    codex_bin: &str,
    options: &CodexCommandOptions,
    job_path: &Path,
    placement: &crate::ai::placement::AiEditPlacement,
    composer: &AiEditComposer,
    prompt: &str,
    reference_pngs: &[WorkflowSourceImage],
) -> Result<Option<FillStoryboard>, String> {
    if !should_storyboard_fill(placement) {
        return Ok(None);
    }
    if let Ok(storyboard) = read_fill_storyboard_file(job_path, placement.parts.len()) {
        normalize_storyboard_draft_result(job_path, placement)?;
        if read_storyboard_draft(job_path)?.is_some() {
            return Ok(Some(storyboard));
        }
        emit_codex_progress(
            app,
            run_id,
            "Existing split fill storyboard has no visual draft; replanning with Codex",
        );
    }

    let storyboard_overview =
        composer.storyboard_overview_png("Generative fill storyboard overview")?;
    fs::write(
        job_path.join(FILL_STORYBOARD_OVERVIEW_FILE),
        storyboard_overview,
    )
    .map_err(|e| format!("Failed to write generative fill storyboard overview: {e}"))?;
    let (reference_paths, reference_names) =
        write_reference_pngs(job_path, reference_pngs, "Generative fill storyboard")?;
    let prompt_text =
        fill_storyboard_master_prompt(prompt.trim(), "Codex", ".", placement, &reference_names);
    write_codex_imagegen_options(job_path, placement.document_dimensions, options)?;
    write_ai_job_prompt(job_path, &prompt_text, "Codex fill storyboard")?;
    emit_codex_progress(app, run_id, "Planning split fill storyboard with Codex");

    let mut failure = run_codex_fill_storyboard(
        app,
        run_id,
        codex_bin,
        options,
        job_path,
        &prompt_text,
        true,
        &reference_paths,
    )
    .err();
    normalize_storyboard_draft_result(job_path, placement)?;

    match read_fill_storyboard_file(job_path, placement.parts.len()) {
        Ok(storyboard) => {
            if read_storyboard_draft(job_path)?.is_some() {
                Ok(Some(storyboard))
            } else {
                let failure = format!(
                    "Codex split fill did not create required {FILL_STORYBOARD_DRAFT_FILE}."
                );
                record_fill_storyboard_failure(job_path, &failure);
                Err(format!(
                    "{failure} The part agents were not started, because running them without the visual draft makes split fills behave like independent image generations."
                ))
            }
        }
        Err(error) => {
            if let Some(previous) = failure.take() {
                failure = Some(format!("{previous}\n\n{error}"));
            } else {
                failure = Some(error);
            }
            let failure = failure.unwrap_or_else(|| "Codex did not write storyboard.json.".into());
            preserve_invalid_fill_storyboard_file(job_path);
            record_fill_storyboard_failure(job_path, &failure);
            Err(format!(
                "{failure}\n\nCodex split fill needs a valid storyboard and {FILL_STORYBOARD_DRAFT_FILE} before part agents can run."
            ))
        }
    }
}

fn run_paintnode_owned_fill_imagegen(
    app: &AppHandle,
    run_id: &str,
    part_path: &Path,
    options: &CodexCommandOptions,
    image_options: &PaintNodeImageProviderOptions,
    request_path: &Path,
    working: &AiWorkingCanvas,
) -> Result<CodexPartRun, String> {
    let request_text = fs::read_to_string(request_path).map_err(|e| {
        format!(
            "Failed to read PaintNode image request at {}: {e}",
            request_path.display()
        )
    })?;
    let request: PaintNodeImageRequest = serde_json::from_str(&request_text).map_err(|e| {
        format!(
            "PaintNode image request at {} is invalid JSON: {e}",
            request_path.display()
        )
    })?;
    let prompt = paintnode_owned_image_prompt(&request)?;
    run_paintnode_owned_fill_image_request(
        app,
        run_id,
        part_path,
        options,
        image_options,
        &request,
        &prompt,
        "result.png",
        working,
    )
}

#[allow(clippy::too_many_arguments)]
fn run_paintnode_owned_fill_image_request(
    app: &AppHandle,
    run_id: &str,
    part_path: &Path,
    options: &CodexCommandOptions,
    image_options: &PaintNodeImageProviderOptions,
    request: &PaintNodeImageRequest,
    prompt: &str,
    result_file_name: &str,
    working: &AiWorkingCanvas,
) -> Result<CodexPartRun, String> {
    let base_image = if request.base_image.trim().is_empty() {
        "source.png"
    } else {
        request.base_image.trim()
    };
    let base_path = safe_job_child_path(part_path, base_image)?;
    if !base_path.exists() {
        return Err(format!(
            "PaintNode image request references missing base image `{base_image}`."
        ));
    }

    let result_png = match image_options.provider {
        PaintNodeImageProvider::Antigravity => {
            emit_codex_progress(
                app,
                run_id,
                format!(
                    "Requesting PaintNode Antigravity image fill at {}x{}",
                    working.original_dimensions.0, working.original_dimensions.1
                ),
            );
            run_antigravity_owned_image_edit(
                app,
                run_id,
                image_options.antigravity_bin.clone(),
                part_path,
                prompt.to_string(),
                vec![base_path],
                working,
                image_options.antigravity_model.clone(),
                image_options.antigravity_approval_mode.clone(),
                image_options.antigravity_image_model.clone(),
                image_options.antigravity_image_size.clone(),
                image_options.antigravity_person_generation.clone(),
                image_options.antigravity_prominent_people.clone(),
                image_options.antigravity_compression_quality,
                image_options.antigravity_advanced_json.clone(),
                image_options.antigravity_safety_filtering.clone(),
                image_options.antigravity_safety_harassment.clone(),
                image_options.antigravity_safety_hate_speech.clone(),
                image_options.antigravity_safety_sexually_explicit.clone(),
                image_options.antigravity_safety_dangerous_content.clone(),
                image_options.keep_debug_artifacts,
            )?
        }
        PaintNodeImageProvider::Codex => {
            emit_codex_progress(
                app,
                run_id,
                format!(
                    "Requesting PaintNode Codex image fill at {}x{}",
                    working.original_dimensions.0, working.original_dimensions.1
                ),
            );
            run_codex_direct_image_request(
                prompt,
                &[base_path],
                working.original_dimensions,
                options,
                Some(part_path),
            )?
        }
    };
    let requested_result_path = part_path.join(result_file_name);
    fs::write(&requested_result_path, &result_png).map_err(|e| {
        format!(
            "Failed to write Codex generative fill result at {}: {e}",
            requested_result_path.display()
        )
    })?;

    emit_codex_progress(app, run_id, "Reading generative fill PNG");
    let (normalized_png, result_dimensions, normalized) =
        read_png_bytes_cropped_to_ai_working_canvas(
            &requested_result_path,
            working,
            "Codex generative fill",
        )?;
    Ok(CodexPartRun {
        normalized_png,
        result_dimensions,
        normalized,
        recovered_source_path: requested_result_path,
    })
}

fn paintnode_owned_image_prompt(request: &PaintNodeImageRequest) -> Result<String, String> {
    image_request_prompt(request)
}

fn fill_director_turn_image_paths(
    part_path: &Path,
    has_overview: bool,
    reference_paths: &[PathBuf],
    candidate_path: Option<&Path>,
) -> Vec<PathBuf> {
    let mut image_paths = vec![part_path.join("source.png")];
    if has_overview {
        image_paths.push(part_path.join("overview.png"));
    }
    image_paths.extend(reference_paths.iter().cloned());
    if let Some(candidate_path) = candidate_path {
        image_paths.push(candidate_path.to_path_buf());
    }
    image_paths
}

fn director_final_agent_message(
    provider: &PaintNodeDirectorProvider,
    output: &Output,
) -> Option<String> {
    match provider {
        PaintNodeDirectorProvider::Claude => final_claude_agent_message(output),
        PaintNodeDirectorProvider::Codex | PaintNodeDirectorProvider::Antigravity => {
            final_codex_agent_message(output)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_director_provider_action_turn(
    app: &AppHandle,
    run_id: &str,
    director_provider: &PaintNodeDirectorProvider,
    codex_bin: &str,
    claude_options: &ClaudeCommandOptions,
    codex_options: &CodexCommandOptions,
    image_options: &PaintNodeImageProviderOptions,
    part_path: &Path,
    prompt_text: &str,
    image_paths: &[PathBuf],
) -> Result<AgentRunResult, String> {
    match director_provider {
        PaintNodeDirectorProvider::Codex => {
            let mut command = build_codex_sdk_command(
                codex_bin,
                part_path,
                prompt_text,
                image_paths,
                codex_options,
            );
            let run = run_codex_with_progress(&mut command, app.clone(), run_id.to_string())
                .map_err(|e| {
                    format!(
                        "Failed to run Codex at '{}': {e}",
                        codex_command_label(codex_bin)
                    )
                })?;
            if run.output.status.success() {
                Ok(run)
            } else if let Some(message) = final_codex_agent_message(&run.output) {
                Err(format!("Codex Director failed.\n\n{message}"))
            } else {
                Err(command_failure("Codex Director", &run.output))
            }
        }
        PaintNodeDirectorProvider::Claude => {
            let mut command =
                build_director_claude_command(claude_options, part_path, prompt_text, image_paths);
            let run = run_claude_with_progress(&mut command, app.clone(), run_id.to_string())
                .map_err(|e| {
                    format!(
                        "Failed to run Claude at '{}': {e}",
                        claude_command_label(claude_options)
                    )
                })?;
            if run.output.status.success() {
                Ok(run)
            } else if let Some(message) = final_claude_agent_message(&run.output) {
                Err(format!("Claude Director failed.\n\n{message}"))
            } else {
                Err(claude_command_failure("Claude Director", &run.output))
            }
        }
        PaintNodeDirectorProvider::Antigravity => run_antigravity_director_request(
            app,
            run_id,
            image_options.antigravity_bin.clone(),
            image_options.antigravity_model.clone(),
            image_options.antigravity_approval_mode.clone(),
            image_options.keep_debug_artifacts,
            part_path,
            part_path,
            prompt_text,
            true,
            PAINTNODE_DIRECTOR_ACTION_FILE,
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn run_agentic_fill_director_part(
    app: &AppHandle,
    run_id: &str,
    director_provider: &PaintNodeDirectorProvider,
    codex_bin: &str,
    claude_options: &ClaudeCommandOptions,
    codex_options: &CodexCommandOptions,
    image_options: &PaintNodeImageProviderOptions,
    part_path: &Path,
    base_prompt_text: &str,
    has_overview: bool,
    reference_paths: &[PathBuf],
    working: &AiWorkingCanvas,
    director_involvement: AiDirectorInvolvement,
) -> Result<CodexPartRun, String> {
    write_codex_imagegen_options(part_path, working.original_dimensions, codex_options)?;
    run_candidate_director_loop(
        part_path,
        DirectorLoopSpec {
            provider_label: director_provider.label(),
            involvement: director_involvement,
            keep_debug_artifacts: codex_options.keep_debug_artifacts,
            legacy_request_file: PAINTNODE_IMAGE_REQUEST_FILE,
            base_prompt_text,
            review_criteria: workflow_review_criteria("generative_fill"),
            ensure_completion_acceptance_note:
                "Candidate completed; ensure-completion mode does not run a separate quality review.",
        },
        |_, prompt_text, candidate_path| {
            let image_paths = fill_director_turn_image_paths(
                part_path,
                has_overview,
                reference_paths,
                candidate_path,
            );
            run_director_provider_action_turn(
                app,
                run_id,
                director_provider,
                codex_bin,
                claude_options,
                codex_options,
                image_options,
                part_path,
                prompt_text,
                &image_paths,
            )
        },
        |run| director_final_agent_message(director_provider, &run.output),
        |turn, request, prompt| {
            let candidate_file = director_candidate_file(turn);
            let result = run_paintnode_owned_fill_image_request(
                app,
                run_id,
                part_path,
                codex_options,
                image_options,
                &request,
                prompt,
                &candidate_file,
                working,
            )?;
            Ok(DirectorCandidate {
                result,
                file_name: candidate_file,
            })
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn run_codex_fill_part(
    app: &AppHandle,
    run_id: &str,
    codex_bin: &str,
    options: &CodexCommandOptions,
    image_options: &PaintNodeImageProviderOptions,
    part_path: &Path,
    prompt_text: &str,
    has_overview: bool,
    storyboard_draft_paths: &[PathBuf],
    reference_paths: &[PathBuf],
    working: &AiWorkingCanvas,
) -> Result<CodexPartRun, String> {
    write_codex_imagegen_options(part_path, working.original_dimensions, options)?;
    let mut command = build_generative_fill_codex_command(
        codex_bin,
        part_path,
        prompt_text,
        has_overview,
        storyboard_draft_paths,
        reference_paths,
        options,
        true,
    );
    let mut run =
        run_codex_with_progress(&mut command, app.clone(), run_id.to_string()).map_err(|e| {
            format!(
                "Failed to run Codex at '{}': {e}",
                codex_command_label(&codex_bin)
            )
        })?;

    if !run.output.status.success() && output_mentions_unsupported_json(&run.output) {
        emit_codex_progress(
            app,
            run_id,
            "Codex progress stream unavailable; retrying generative fill",
        );
        let mut fallback = build_generative_fill_codex_command(
            codex_bin,
            part_path,
            prompt_text,
            has_overview,
            storyboard_draft_paths,
            reference_paths,
            options,
            false,
        );
        run = run_codex_with_progress(&mut fallback, app.clone(), run_id.to_string()).map_err(
            |e| {
                format!(
                    "Failed to run Codex at '{}': {e}",
                    codex_command_label(&codex_bin)
                )
            },
        )?;
    }

    if !run.output.status.success() {
        if let Some(message) = final_codex_agent_message(&run.output) {
            return Err(format!(
                "Codex did not plan a PaintNode fill request.\n\n{message}"
            ));
        }
        return Err(command_failure("Codex generative fill", &run.output));
    }

    let owned_request_path = part_path.join(PAINTNODE_IMAGE_REQUEST_FILE);
    let requested_result_path = part_path.join("result.png");
    if owned_request_path.exists() {
        return run_paintnode_owned_fill_imagegen(
            app,
            run_id,
            part_path,
            options,
            image_options,
            &owned_request_path,
            working,
        );
    }

    if requested_result_path.exists() {
        return Err(format!(
            "Codex created `{}` directly, but generative fill is now PaintNode-controlled. Expected `{PAINTNODE_IMAGE_REQUEST_FILE}` so PaintNode can run its owned image-generation executor.",
            requested_result_path.display()
        ));
    }

    if let Some(message) = final_codex_agent_message(&run.output) {
        return Err(format!(
            "Codex did not create `{PAINTNODE_IMAGE_REQUEST_FILE}` for PaintNode's owned image-generation runner.\n\n{message}"
        ));
    }
    Err(format!(
        "Codex did not create `{PAINTNODE_IMAGE_REQUEST_FILE}` for PaintNode's owned image-generation runner."
    ))
}

#[allow(clippy::too_many_arguments)]
fn run_claude_fill_part(
    app: &AppHandle,
    run_id: &str,
    options: &ClaudeCommandOptions,
    codex_options: &CodexCommandOptions,
    image_options: &PaintNodeImageProviderOptions,
    part_path: &Path,
    prompt_text: &str,
    has_overview: bool,
    reference_paths: &[PathBuf],
    working: &AiWorkingCanvas,
) -> Result<CodexPartRun, String> {
    write_codex_imagegen_options(part_path, working.original_dimensions, codex_options)?;
    let mut command = build_generative_fill_claude_command(
        options,
        part_path,
        prompt_text,
        has_overview,
        reference_paths,
    );
    let run =
        run_claude_with_progress(&mut command, app.clone(), run_id.to_string()).map_err(|e| {
            format!(
                "Failed to run Claude at '{}': {e}",
                claude_command_label(options)
            )
        })?;

    if !run.output.status.success() {
        if let Some(message) = final_claude_agent_message(&run.output) {
            return Err(format!(
                "Claude did not plan a PaintNode fill request.\n\n{message}"
            ));
        }
        return Err(claude_command_failure(
            "Claude generative fill Director",
            &run.output,
        ));
    }

    let owned_request_path = part_path.join(PAINTNODE_IMAGE_REQUEST_FILE);
    let requested_result_path = part_path.join("result.png");
    if owned_request_path.exists() {
        return run_paintnode_owned_fill_imagegen(
            app,
            run_id,
            part_path,
            codex_options,
            image_options,
            &owned_request_path,
            working,
        );
    }

    if requested_result_path.exists() {
        return Err(format!(
            "Claude created `{}` directly, but generative fill is PaintNode-controlled. Expected `{PAINTNODE_IMAGE_REQUEST_FILE}` so PaintNode can run its owned image-generation executor.",
            requested_result_path.display()
        ));
    }

    if let Some(message) = final_claude_agent_message(&run.output) {
        return Err(format!(
            "Claude did not create `{PAINTNODE_IMAGE_REQUEST_FILE}` for PaintNode's owned image-generation runner.\n\n{message}"
        ));
    }
    Err(format!(
        "Claude did not create `{PAINTNODE_IMAGE_REQUEST_FILE}` for PaintNode's owned image-generation runner."
    ))
}

fn run_antigravity_fill_part(
    app: &AppHandle,
    run_id: &str,
    codex_options: &CodexCommandOptions,
    image_options: &PaintNodeImageProviderOptions,
    part_path: &Path,
    prompt_text: &str,
    working: &AiWorkingCanvas,
) -> Result<CodexPartRun, String> {
    write_codex_imagegen_options(part_path, working.original_dimensions, codex_options)?;
    let run = run_antigravity_director_request(
        app,
        run_id,
        image_options.antigravity_bin.clone(),
        image_options.antigravity_model.clone(),
        image_options.antigravity_approval_mode.clone(),
        image_options.keep_debug_artifacts,
        part_path,
        part_path,
        prompt_text,
        true,
        PAINTNODE_IMAGE_REQUEST_FILE,
    )?;

    let owned_request_path = part_path.join(PAINTNODE_IMAGE_REQUEST_FILE);
    let requested_result_path = part_path.join("result.png");
    if owned_request_path.exists() {
        return run_paintnode_owned_fill_imagegen(
            app,
            run_id,
            part_path,
            codex_options,
            image_options,
            &owned_request_path,
            working,
        );
    }

    if requested_result_path.exists() {
        return Err(format!(
            "Antigravity created `{}` directly, but generative fill is PaintNode-controlled. Expected `{PAINTNODE_IMAGE_REQUEST_FILE}` so PaintNode can run its owned image-generation executor.",
            requested_result_path.display()
        ));
    }

    if !run.output.status.success() {
        return Err(command_failure(
            "Antigravity generative fill Director",
            &run.output,
        ));
    }

    Err(format!(
        "Antigravity did not create `{PAINTNODE_IMAGE_REQUEST_FILE}` for PaintNode's owned image-generation runner."
    ))
}

fn run_codex_direct_edit_part(
    app: &AppHandle,
    run_id: &str,
    part_path: &Path,
    options: &CodexCommandOptions,
    prompt_text: &str,
    image_paths: &[PathBuf],
    working: &AiWorkingCanvas,
    label: &str,
) -> Result<CodexPartRun, String> {
    emit_codex_progress(
        app,
        run_id,
        format!(
            "Requesting PaintNode Codex image edit at {}x{}",
            working.original_dimensions.0, working.original_dimensions.1
        ),
    );
    let result_png = run_codex_direct_image_request(
        prompt_text,
        image_paths,
        working.original_dimensions,
        options,
        Some(part_path),
    )?;
    let requested_result_path = part_path.join("result.png");
    fs::write(&requested_result_path, &result_png)
        .map_err(|e| format!("Failed to write {label} result: {e}"))?;
    let (normalized_png, result_dimensions, normalized) =
        read_png_bytes_cropped_to_ai_working_canvas(&requested_result_path, working, label)?;
    Ok(CodexPartRun {
        normalized_png,
        result_dimensions,
        normalized,
        recovered_source_path: requested_result_path,
    })
}

#[cfg(test)]
fn codex_direct_restore_prompt(
    geometry_note: &str,
    director_mode: AiDirectorMode,
    director_involvement: AiDirectorInvolvement,
) -> String {
    codex_direct_restore_director_prompt(
        geometry_note,
        AiDirectorProvider::Codex,
        director_mode,
        director_involvement,
    )
}

fn codex_direct_restore_director_prompt(
    geometry_note: &str,
    director_provider: AiDirectorProvider,
    director_mode: AiDirectorMode,
    director_involvement: AiDirectorInvolvement,
) -> String {
    let director_contract =
        ai_director_restore_contract(director_provider, director_mode, director_involvement);
    let agentic_tool_loop = director_uses_agentic_loop(director_mode, director_involvement);
    let director_tool_contract = if agentic_tool_loop {
        format!(
            "\n{}\n{}",
            director_action_file_contract(
                "source.png",
                "detail restoration prompt for PaintNode's owned image tool"
            ),
            director_review_criteria_section("upscale", director_mode, director_involvement)
        )
    } else {
        director_review_criteria_section("upscale", director_mode, director_involvement)
    };
    let opening = if agentic_tool_loop {
        "Act as PaintNode's AI Director for one fixed-canvas image-detail restoration region."
    } else {
        "Restore image detail for one PaintNode fixed-canvas region and return exactly one full-canvas PNG candidate."
    };
    let output_requirements = if agentic_tool_loop {
        "- The `generateCandidate` action must request one full-canvas PNG candidate with the same dimensions and framing as `source.png`.\n- The candidate must not include PaintNode UI, borders, labels, watermarks, or mask visualization.\n- If a safety or quality adjustment is needed, make the smallest compliant prompt adjustment while preserving the existing image content."
    } else {
        "- Return one full-canvas PNG candidate with the same dimensions and framing as `source.png`.\n- Do not include PaintNode UI, borders, labels, watermarks, or mask visualization.\n- If a safety or quality adjustment is needed, make the smallest compliant adjustment while preserving the existing image content."
    };
    format!(
        r#"{opening}

This is a fixed-canvas image refinement task, not a new image generation task.

Attached images:
1. `source.png` is the image region to restore. It was enlarged from a lower-resolution image, so it is soft and lacks fine detail.
2. `mask.png` marks the editable area. White pixels are editable. Gray pixels are a feathered hand-off band into already-restored content; PaintNode cross-fades your result there, so render that band seamlessly consistent with the neighboring restored pixels. Black or transparent pixels were already restored and must remain unchanged.

{geometry_note}
{director_contract}
{director_tool_contract}

Restoration goal:
- Re-render this exact image with crisp, natural, high-frequency detail: sharp edges and realistic texture for skin, hair, fabric, foliage, and surfaces.
- Preserve composition, framing, camera geometry, subjects, identities, poses, expressions, colors, lighting, and style exactly.
- Match the color balance, tone, brightness, contrast, grain, and detail level of already-restored areas so the result joins them without visible seams.
- Preserve intentional medium character such as film grain, scan texture, halation, bloom, lens softness, motion softness, slight overexposure, underexposure, or vintage color cast. Do not treat those traits as defects unless the user explicitly asked for cleanup, denoise, or restoration beyond upscale/detail recovery.
- Do not add, remove, move, restyle, or reinterpret any content.
- Do not change global brightness, contrast, or color balance.
- If a detail is too blurred to identify, render plausible neutral texture instead of inventing new objects, readable text, faces, or logos.

Critical registration rule:
Do not translate, shift, crop, zoom, rotate, scale, stretch, warp, resize, reframe, straighten, or change the camera perspective.
The output must stay registered to `source.png`.

Output requirements:
{output_requirements}"#
    )
}

/// Run a tiled detail-restoration pass over an enlarged image: every part is
/// regenerated at model-native density and pasted back at its position.
fn codex_restore_image_details(
    app: &AppHandle,
    run_id: &str,
    codex_bin: &str,
    options: &CodexCommandOptions,
    restore_root: &Path,
    enlarged_png: &[u8],
    label: &str,
    upscale_layers: bool,
    return_composed: bool,
    director_provider: AiDirectorProvider,
    director_mode: AiDirectorMode,
    director_involvement: AiDirectorInvolvement,
) -> Result<(Option<Vec<u8>>, Vec<GeneratedImageLayerResult>), String> {
    let dimensions = png_dimensions_from_bytes(enlarged_png)
        .ok_or_else(|| format!("{label} PNG dimensions are invalid."))?;
    let placement = if upscale_layers {
        plan_ai_upscale_placement(AiEditProvider::Codex, dimensions, label)?
    } else {
        plan_ai_restore_placement(AiEditProvider::Codex, dimensions, label)?
    };
    let agentic_tool_loop = director_uses_agentic_loop(director_mode, director_involvement);
    let director_runner = PaintNodeDirectorProvider::from_director_provider(director_provider);
    let claude_options = claude_command_options(None, None, None);
    let image_options = codex_image_provider_options(options.keep_debug_artifacts);
    let workflow_name = if upscale_layers { "upscale" } else { "restore" };
    let mut composer = AiEditComposer::new_full_coverage(enlarged_png, label)?;
    let mut layer_results = Vec::new();
    fs::create_dir_all(restore_root)
        .map_err(|e| format!("Failed to create {label} restoration folder: {e}"))?;
    let resumable = prepare_ai_job_dir_for_placement(restore_root, &placement, label)?;
    for (part_index, part) in placement.parts.iter().enumerate() {
        let part_path = match placement.part_dir_name(part_index) {
            Some(dir) => restore_root.join(dir),
            None => restore_root.to_path_buf(),
        };
        fs::create_dir_all(&part_path)
            .map_err(|e| format!("Failed to create {label} restoration part folder: {e}"))?;
        if !options.keep_debug_artifacts {
            let _ = fs::remove_file(part_path.join("part_result-unaligned.png"));
        }
        if resumable {
            if let Some(bytes) = reuse_part_result(&part_path, part) {
                emit_codex_part_progress(
                    app,
                    run_id,
                    part_index,
                    placement.parts.len(),
                    ai_part_progress_message(
                        &placement,
                        part_index,
                        "Reusing this part's previous result",
                    ),
                );
                if upscale_layers {
                    let layer_png = composer.part_result_layer_png(part, &bytes, label)?;
                    let mask_png = composer.part_result_mask_png(part, label)?;
                    layer_results.push(GeneratedImageLayerResult {
                        name: format!("AI Upscale part {}", part_index + 1),
                        data_url: png_data_url(&layer_png)?,
                        asset: None,
                        mask_data_url: Some(png_data_url(&mask_png)?),
                    });
                }
                composer.apply_part_result(part, &bytes, label)?;
                continue;
            }
            let _ = fs::remove_file(part_path.join("part_result.png"));
            let _ = fs::remove_file(part_path.join("result.png"));
        }
        let inputs = composer.part_inputs(part, label)?;
        fs::write(part_path.join("source.png"), &inputs.source_png)
            .map_err(|e| format!("Failed to write {label} source image: {e}"))?;
        fs::write(part_path.join("mask.png"), &inputs.mask_png)
            .map_err(|e| format!("Failed to write {label} mask image: {e}"))?;
        let has_overview = placement.is_split();
        if has_overview {
            fs::write(
                part_path.join("overview.png"),
                composer.overview_png(part, label)?,
            )
            .map_err(|e| format!("Failed to write {label} overview image: {e}"))?;
        }
        write_codex_imagegen_options(&part_path, part.working.original_dimensions, options)?;
        let geometry_note = ai_part_geometry_note(&placement, part_index);
        let prompt_text = codex_direct_restore_director_prompt(
            &geometry_note,
            director_provider,
            director_mode,
            director_involvement,
        );
        write_ai_job_prompt(&part_path, &prompt_text, label)?;
        emit_codex_part_progress(
            app,
            run_id,
            part_index,
            placement.parts.len(),
            ai_part_progress_message(
                &placement,
                part_index,
                "Restoring image detail with Codex image generation",
            ),
        );
        let mut image_paths = vec![part_path.join("source.png"), part_path.join("mask.png")];
        if has_overview {
            image_paths.push(part_path.join("overview.png"));
        }
        let part_run = if agentic_tool_loop {
            run_candidate_director_loop(
                &part_path,
                DirectorLoopSpec {
                    provider_label: director_runner.label(),
                    involvement: director_involvement,
                    keep_debug_artifacts: options.keep_debug_artifacts,
                    legacy_request_file: PAINTNODE_IMAGE_REQUEST_FILE,
                    base_prompt_text: &prompt_text,
                    review_criteria: workflow_review_criteria(workflow_name),
                    ensure_completion_acceptance_note:
                        "Candidate completed; ensure-completion mode does not run a separate quality review.",
                },
                |_, turn_prompt_text, candidate_path| {
                    let mut turn_image_paths = image_paths.clone();
                    if let Some(candidate_path) = candidate_path {
                        turn_image_paths.push(candidate_path.to_path_buf());
                    }
                    run_director_provider_action_turn(
                        app,
                        run_id,
                        &director_runner,
                        codex_bin,
                        &claude_options,
                        options,
                        &image_options,
                        &part_path,
                        turn_prompt_text,
                        &turn_image_paths,
                    )
                },
                |run| director_final_agent_message(&director_runner, &run.output),
                |turn, _request, candidate_prompt| {
                    let part_run = run_codex_direct_edit_part(
                        app,
                        run_id,
                        &part_path,
                        options,
                        candidate_prompt,
                        &image_paths,
                        &part.working,
                        label,
                    )
                    .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?;
                    let candidate_file = director_candidate_file(turn);
                    fs::write(part_path.join(&candidate_file), &part_run.normalized_png)
                        .map_err(|e| format!("Failed to write {label} Director candidate: {e}"))?;
                    Ok(DirectorCandidate {
                        result: part_run,
                        file_name: candidate_file,
                    })
                },
            )?
        } else {
            run_codex_direct_edit_part(
                app,
                run_id,
                &part_path,
                options,
                &prompt_text,
                &image_paths,
                &part.working,
                label,
            )
            .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?
        };
        let _ = fs::remove_file(&part_run.recovered_source_path);
        let unaligned_bytes = part_run.normalized_png.clone();
        let (part_result_png, drift_correction) =
            correct_part_result_drift(&inputs.source_png, &part_run.normalized_png, label)?;
        if let Some(correction) = drift_correction {
            if options.keep_debug_artifacts {
                let _ = fs::write(
                    part_path.join("part_result-unaligned.png"),
                    &unaligned_bytes,
                );
            }
            emit_codex_progress(
                app,
                run_id,
                ai_part_progress_message(
                    &placement,
                    part_index,
                    &format!(
                        "Corrected upscale drift by ({}, {}) px (confidence {:.3})",
                        correction.dx, correction.dy, correction.confidence
                    ),
                ),
            );
        }
        fs::write(part_path.join("part_result.png"), &part_result_png)
            .map_err(|e| format!("Failed to record {label} part result: {e}"))?;
        if upscale_layers {
            let layer_png = composer.part_result_layer_png(part, &part_result_png, label)?;
            let mask_png = composer.part_result_mask_png(part, label)?;
            layer_results.push(GeneratedImageLayerResult {
                name: format!("AI Upscale part {}", part_index + 1),
                data_url: png_data_url(&layer_png)?,
                asset: None,
                mask_data_url: Some(png_data_url(&mask_png)?),
            });
        }
        composer.apply_part_result(part, &part_result_png, label)?;
    }
    let composed_png = if return_composed {
        Some(composer.composed_png(label)?)
    } else {
        None
    };
    Ok((composed_png, layer_results))
}

/// Run local Codex headlessly for a mask-guided generative fill.
#[tauri::command]
pub(crate) async fn generate_codex_fill_image(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    keep_job_dir: Option<bool>,
    keep_debug_artifacts: Option<bool>,
    store_asset: Option<bool>,
    source_png: Vec<u8>,
    edit_target_png: Vec<u8>,
    mask_png: Vec<u8>,
    reference_pngs: Vec<WorkflowSourceImage>,
    run_id: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    image_quality: Option<String>,
    image_moderation: Option<String>,
    autonomy_level: Option<String>,
    director_mode: Option<String>,
    director_provider: Option<String>,
    director_involvement: Option<String>,
    edit_checks_level: Option<u8>,
    fill_aspect_ratio: Option<String>,
    planner_provider: Option<String>,
    claude_bin: Option<String>,
    claude_model: Option<String>,
    claude_effort: Option<String>,
    image_provider: Option<String>,
    antigravity_bin: Option<String>,
    antigravity_model: Option<String>,
    antigravity_approval_mode: Option<String>,
    antigravity_image_model: Option<String>,
    antigravity_image_size: Option<String>,
    antigravity_person_generation: Option<String>,
    antigravity_prominent_people: Option<String>,
    antigravity_compression_quality: Option<u8>,
    antigravity_advanced_json: Option<String>,
    antigravity_safety_filtering: Option<String>,
    antigravity_safety_harassment: Option<String>,
    antigravity_safety_hate_speech: Option<String>,
    antigravity_safety_sexually_explicit: Option<String>,
    antigravity_safety_dangerous_content: Option<String>,
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
    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let mut codex_options = codex_command_options(
            model,
            reasoning_effort,
            service_tier,
            image_quality,
            image_moderation,
        );
        let director_provider =
            PaintNodeDirectorProvider::from_options(director_provider, planner_provider);
        let director_mode = ai_director_mode(director_mode);
        let director_involvement = ai_director_involvement(director_involvement);
        let claude_options = claude_command_options(claude_bin, claude_model, claude_effort);
        codex_options.keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        let image_options = PaintNodeImageProviderOptions {
            provider: PaintNodeImageProvider::from_option(image_provider),
            keep_debug_artifacts: codex_options.keep_debug_artifacts,
            antigravity_bin,
            antigravity_model,
            antigravity_approval_mode,
            antigravity_image_model,
            antigravity_image_size,
            antigravity_person_generation,
            antigravity_prominent_people,
            antigravity_compression_quality,
            antigravity_advanced_json,
            antigravity_safety_filtering,
            antigravity_safety_harassment,
            antigravity_safety_hate_speech,
            antigravity_safety_sexually_explicit,
            antigravity_safety_dangerous_content,
        };
        let codex_bin = configured_codex_bin_or_sdk_default(bin);
        let autonomy = ai_autonomy_level(autonomy_level);
        let _checks_level = ai_edit_checks_level(edit_checks_level);
        let fill_aspect_ratio = fill_aspect_ratio
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let run_id = if run_id.trim().is_empty() {
            format!("fill-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
        let project_dir = optional_project_dir(&project_path);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let job_project_dir = ai_job_project_dir(&app, &project_dir, keep_job_dir)?;
        let cleanup_project_job = cleanup_project_job_enabled(&job_project_dir, keep_job_dir);
        let store_asset = store_asset.unwrap_or(true);
        let temp_job;
        let job_path = if let Some(job_project_dir) = &job_project_dir {
            project_agent_run_dir_for_run(
                job_project_dir,
                director_provider.runs_dir(),
                "fill",
                &run_id,
            )?
        } else {
            temp_job = TempJobDir::new("paintnode-fill")?;
            temp_job.path().to_path_buf()
        };

        let placement = plan_ai_fill_placement(
            match image_options.provider {
                PaintNodeImageProvider::Antigravity => AiEditProvider::Antigravity,
                PaintNodeImageProvider::Codex => AiEditProvider::Codex,
            },
            AiFillMethod::Auto,
            AiFillRedundancy::Medium,
            source_dimensions,
            &mask_png,
            fill_aspect_ratio,
            "Generative fill",
        )?;
        let mut composer = AiEditComposer::new(
            &source_png,
            &edit_target_png,
            &mask_png,
            None,
            "Generative fill",
        )?;
        let resumable = prepare_ai_job_dir_for_placement(&job_path, &placement, "Generative fill")?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);
        let storyboard = if image_options.provider == PaintNodeImageProvider::Codex {
            match &director_provider {
                PaintNodeDirectorProvider::Codex => prepare_codex_fill_storyboard(
                    &app,
                    &run_id,
                    &codex_bin,
                    &codex_options,
                    &job_path,
                    &placement,
                    &composer,
                    prompt.trim(),
                    &reference_pngs,
                )?,
                PaintNodeDirectorProvider::Antigravity | PaintNodeDirectorProvider::Claude => {
                    emit_codex_progress(
                        &app,
                        &run_id,
                        format!(
                            "Skipping visual storyboard draft; {} Director does not generate images in the planning stage",
                            director_provider.label()
                        ),
                    );
                    None
                }
            }
        } else {
            emit_codex_progress(
                &app,
                &run_id,
                format!(
                    "Skipping {} storyboard draft; selected image generator owns fill pixels",
                    director_provider.label()
                ),
            );
            None
        };

        let mut recovered_source_path: Option<PathBuf> = None;
        let return_part_layers = fill_placement_returns_layer_results(&placement);
        let mut layer_results = Vec::new();
        let mut layer_assets = Vec::new();
        let mut raw_assets = Vec::new();
        for (part_index, part) in placement.parts.iter().enumerate() {
            let part_path = match placement.part_dir_name(part_index) {
                Some(dir) => job_path.join(dir),
                None => job_path.clone(),
            };
            fs::create_dir_all(&part_path)
                .map_err(|e| format!("Failed to create generative fill part folder: {e}"))?;
            remove_legacy_generative_fill_agent_inputs(&part_path);
            if resumable {
                if let Some(bytes) = reuse_part_result(&part_path, part) {
                    emit_codex_part_progress(
                        &app,
                        &run_id,
                        part_index,
                        placement.parts.len(),
                        ai_part_progress_message(
                            &placement,
                            part_index,
                            "Reusing this part's previous result",
                        ),
                    );
                    if store_asset {
                        if let Some(project_dir) = project_dir.as_ref() {
                            let raw_name = format!("Generative fill raw part {}", part_index + 1);
                            let raw_asset = store_generated_png_asset(
                                project_dir,
                                &bytes,
                                raw_name,
                                Some(prompt.trim().into()),
                                Some("part_result.png".into()),
                            )?;
                            raw_assets.push(raw_asset);
                        }
                    }
                    if return_part_layers {
                        let layer_png =
                            composer.part_result_layer_png(part, &bytes, "Generative fill")?;
                        let mask_png =
                            composer.part_result_mask_png(part, "Generative fill mask")?;
                        let layer_name = format!("Generative fill part {}", part_index + 1);
                        let asset = if store_asset {
                            if let Some(project_dir) = project_dir.as_ref() {
                                let (id, relative_path) = write_asset_file(
                                    project_dir,
                                    "generated",
                                    &layer_name,
                                    "png",
                                    &layer_png,
                                )?;
                                let asset = add_asset(
                                    project_dir,
                                    ProjectAsset::generated_png(
                                        id,
                                        relative_path,
                                        layer_name.clone(),
                                        Some(prompt.trim().into()),
                                        None,
                                    ),
                                )?;
                                layer_assets.push(asset.clone());
                                Some(asset)
                            } else {
                                None
                            }
                        } else {
                            None
                        };
                        layer_results.push(GeneratedImageLayerResult {
                            name: layer_name,
                            data_url: png_data_url(&layer_png)?,
                            asset,
                            mask_data_url: Some(png_data_url(&mask_png)?),
                        });
                    }
                    composer.apply_part_result(part, &bytes, "Generative fill")?;
                    continue;
                }
                let _ = fs::remove_file(part_path.join("part_result.png"));
                let _ = fs::remove_file(part_path.join("result.png"));
            }
            remove_legacy_storyboard_part_guides(&part_path);
            let storyboard_draft_png = if storyboard.is_some() {
                match read_storyboard_draft(&job_path) {
                    Ok(draft_png) => draft_png,
                    Err(error) => {
                        emit_codex_progress(
                            &app,
                            &run_id,
                            &format!("Skipping storyboard draft guide: {error}"),
                        );
                        None
                    }
                }
            } else {
                None
            };
            let has_storyboard_draft = storyboard_draft_png.is_some();
            let inputs = if let Some(draft_png) = storyboard_draft_png.as_deref() {
                composer.part_inputs_with_storyboard_draft(
                    part,
                    draft_png,
                    "Generative fill",
                    true,
                )?
            } else if storyboard.is_some() {
                composer.part_inputs_hiding_unpainted_editable(part, "Generative fill", true)?
            } else {
                composer.part_inputs(part, "Generative fill")?
            };
            fs::write(part_path.join("source.png"), &inputs.source_png)
                .map_err(|e| format!("Failed to write generative fill source image: {e}"))?;
            let has_overview = fill_part_needs_overview(&placement, part_index);
            if has_overview {
                let overview_png = if let Some(draft_png) = storyboard_draft_png.as_deref() {
                    composer.overview_png_with_storyboard_draft(
                        part,
                        draft_png,
                        "Generative fill",
                    )?
                } else if storyboard.is_some() {
                    composer.overview_png_hiding_unpainted_editable(part, "Generative fill")?
                } else {
                    composer.overview_png(part, "Generative fill")?
                };
                fs::write(part_path.join("overview.png"), overview_png)
                    .map_err(|e| format!("Failed to write generative fill overview image: {e}"))?;
            }
            let (reference_paths, reference_names) = if has_storyboard_draft {
                (Vec::new(), Vec::new())
            } else {
                write_reference_pngs(&part_path, &reference_pngs, "Generative fill")?
            };
            let geometry_note = if storyboard.is_some() {
                ai_orchestrated_part_prompt_context(&placement, part_index, has_storyboard_draft)
            } else {
                ai_part_prompt_context(&placement, part_index)
            };
            let storyboard_note = storyboard
                .as_ref()
                .map(|storyboard| {
                    fill_storyboard_part_prompt(storyboard, part_index, has_storyboard_draft)
                })
                .unwrap_or_default();
            let storyboard_anchor = storyboard
                .as_ref()
                .map(|storyboard| fill_storyboard_part_is_anchor(storyboard, part_index))
                .unwrap_or(false);
            let storyboard_fallback = storyboard
                .as_ref()
                .map(|storyboard| storyboard.fallback)
                .unwrap_or(false);
            let base_prompt_text = generative_fill_director_prompt(
                prompt.trim(),
                autonomy,
                director_provider.as_director_provider(),
                director_mode,
                director_involvement,
                &geometry_note,
                &storyboard_note,
                storyboard_anchor,
                storyboard_fallback,
                has_overview,
                has_storyboard_draft,
                &reference_names,
            );
            let storyboard_draft_paths = Vec::new();

            emit_codex_part_progress(
                &app,
                &run_id,
                part_index,
                placement.parts.len(),
                ai_part_progress_message(
                    &placement,
                    part_index,
                    &format!(
                        "Starting local {} generative fill Director",
                        director_provider.label()
                    ),
                ),
            );
            write_ai_job_prompt(
                &part_path,
                &base_prompt_text,
                &format!("{} generative fill Director", director_provider.label()),
            )?;
            let part_run = if director_uses_agentic_loop(director_mode, director_involvement)
            {
                run_agentic_fill_director_part(
                    &app,
                    &run_id,
                    &director_provider,
                    &codex_bin,
                    &claude_options,
                    &codex_options,
                    &image_options,
                    &part_path,
                    &base_prompt_text,
                    has_overview,
                    &reference_paths,
                    &part.working,
                    director_involvement,
                )
            } else {
                match &director_provider {
                    PaintNodeDirectorProvider::Codex => run_codex_fill_part(
                        &app,
                        &run_id,
                        &codex_bin,
                        &codex_options,
                        &image_options,
                        &part_path,
                        &base_prompt_text,
                        has_overview,
                        &storyboard_draft_paths,
                        &reference_paths,
                        &part.working,
                    ),
                    PaintNodeDirectorProvider::Antigravity => run_antigravity_fill_part(
                        &app,
                        &run_id,
                        &codex_options,
                        &image_options,
                        &part_path,
                        &base_prompt_text,
                        &part.working,
                    ),
                    PaintNodeDirectorProvider::Claude => run_claude_fill_part(
                        &app,
                        &run_id,
                        &claude_options,
                        &codex_options,
                        &image_options,
                        &part_path,
                        &base_prompt_text,
                        has_overview,
                        &reference_paths,
                        &part.working,
                    ),
                }
            }
            .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?;
            if part_run.normalized {
                emit_codex_progress(
                    &app,
                    &run_id,
                    ai_part_progress_message(
                        &placement,
                        part_index,
                        &format!(
                            "Normalized {} fill from {}x{} to {}x{}",
                            director_provider.label(),
                            part_run.result_dimensions.0,
                            part_run.result_dimensions.1,
                            part.working.original_dimensions.0,
                            part.working.original_dimensions.1
                        ),
                    ),
                );
            }
            let (part_result_png, drift_correction) = correct_part_result_drift(
                &inputs.source_png,
                &part_run.normalized_png,
                "Generative fill",
            )?;
            if let Some(correction) = drift_correction {
                let _ = fs::write(
                    part_path.join("part_result-unaligned.png"),
                    &part_run.normalized_png,
                );
                emit_codex_progress(
                    &app,
                    &run_id,
                    ai_part_progress_message(
                        &placement,
                        part_index,
                        &format!(
                            "Corrected fill drift by ({}, {}) px (confidence {:.3})",
                            correction.dx, correction.dy, correction.confidence
                        ),
                    ),
                );
            }
            fs::write(part_path.join("part_result.png"), &part_result_png)
                .map_err(|e| format!("Failed to record generative fill part result: {e}"))?;
            let result_path = part_path.join("result.png");
            if store_asset {
                if let Some(project_dir) = project_dir.as_ref() {
                    let raw_name = format!("Generative fill raw part {}", part_index + 1);
                    let source_file_name =
                        safe_png_source_file_name(&part_run.recovered_source_path);
                    let raw_asset = store_generated_png_asset(
                        project_dir,
                        &part_run.normalized_png,
                        raw_name,
                        Some(prompt.trim().into()),
                        source_file_name,
                    )?;
                    raw_assets.push(raw_asset);
                }
            }
            let _ = fs::remove_file(&result_path);
            if return_part_layers {
                let layer_png =
                    composer.part_result_layer_png(part, &part_result_png, "Generative fill")?;
                let mask_png = composer.part_result_mask_png(part, "Generative fill mask")?;
                let layer_name = format!("Generative fill part {}", part_index + 1);
                let asset = if store_asset {
                    if let Some(project_dir) = project_dir.as_ref() {
                        let (id, relative_path) = write_asset_file(
                            project_dir,
                            "generated",
                            &layer_name,
                            "png",
                            &layer_png,
                        )?;
                        let asset = add_asset(
                            project_dir,
                            ProjectAsset::generated_png(
                                id,
                                relative_path,
                                layer_name.clone(),
                                Some(prompt.trim().into()),
                                None,
                            ),
                        )?;
                        layer_assets.push(asset.clone());
                        Some(asset)
                    } else {
                        None
                    }
                } else {
                    None
                };
                layer_results.push(GeneratedImageLayerResult {
                    name: layer_name,
                    data_url: png_data_url(&layer_png)?,
                    asset,
                    mask_data_url: Some(png_data_url(&mask_png)?),
                });
            }
            composer.apply_part_result(part, &part_result_png, "Generative fill")?;
            recovered_source_path = Some(part_run.recovered_source_path);
        }

        let bytes = composer.composed_png("Generative fill")?;
        let data_url = png_data_url(&bytes)?;
        let asset = if store_asset && !return_part_layers {
            if let Some(project_dir) = project_dir {
                emit_codex_progress(&app, &run_id, "Saving generative fill to the project");
                let source_file_name = recovered_source_path
                    .as_deref()
                    .filter(|_| !placement.is_split())
                    .and_then(safe_png_source_file_name);
                let (id, relative_path) = if let Some(file_name) = &source_file_name {
                    write_asset_file_with_file_name(&project_dir, "generated", file_name, &bytes)?
                } else {
                    write_asset_file(&project_dir, "generated", prompt.trim(), "png", &bytes)?
                };
                let asset = ProjectAsset::generated_png(
                    id,
                    relative_path,
                    source_file_name
                        .clone()
                        .unwrap_or_else(|| prompt.trim().chars().take(48).collect::<String>()),
                    Some(prompt.trim().into()),
                    source_file_name,
                );
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
        let mut assets = if return_part_layers {
            layer_assets
        } else {
            asset.iter().cloned().collect()
        };
        assets.extend(raw_assets);
        Ok(GeneratedImageResult {
            data_url,
            asset,
            assets,
            mask_data_url: None,
            layers: layer_results,
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

/// Run local Codex headlessly for an AI retouch request.
#[tauri::command]
pub(crate) async fn generate_codex_retouch_image(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    keep_job_dir: Option<bool>,
    keep_debug_artifacts: Option<bool>,
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
    image_quality: Option<String>,
    image_moderation: Option<String>,
    autonomy_level: Option<String>,
    director_mode: Option<String>,
    director_provider: Option<String>,
    director_involvement: Option<String>,
    edit_checks_level: Option<u8>,
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
    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let mut codex_options = codex_command_options(
            model,
            reasoning_effort,
            service_tier,
            image_quality,
            image_moderation,
        );
        codex_options.keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        let codex_bin = configured_codex_bin_or_sdk_default(bin);
        let _ = autonomy_level;
        let director_mode = ai_director_mode(director_mode);
        let director_provider = ai_director_provider(director_provider);
        let director_runner = PaintNodeDirectorProvider::from_director_provider(director_provider);
        let director_involvement = ai_director_involvement(director_involvement);
        let agentic_tool_loop = director_uses_agentic_loop(director_mode, director_involvement);
        let claude_options = claude_command_options(None, None, None);
        let image_options = codex_image_provider_options(codex_options.keep_debug_artifacts);
        let checks_level = ai_edit_checks_level(edit_checks_level);
        let run_id = if run_id.trim().is_empty() {
            format!("retouch-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
        let project_dir = optional_project_dir(&project_path);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let job_project_dir = ai_job_project_dir(&app, &project_dir, keep_job_dir)?;
        let cleanup_project_job = cleanup_project_job_enabled(&job_project_dir, keep_job_dir);
        let temp_job;
        let job_path = if let Some(job_project_dir) = &job_project_dir {
            project_agent_run_dir_for_run(job_project_dir, CODEX_RUNS_DIR, "retouch", &run_id)?
        } else {
            temp_job = TempJobDir::new("paintnode-retouch")?;
            temp_job.path().to_path_buf()
        };

        let placement = plan_ai_edit_placement(
            AiEditProvider::Codex,
            source_dimensions,
            &mask_png,
            "AI retouch",
        )?;
        let mut composer = AiEditComposer::new(
            &source_png,
            &edit_target_png,
            &mask_png,
            annotated_source_png.as_deref(),
            "AI retouch",
        )?;
        let resumable = prepare_ai_job_dir_for_placement(&job_path, &placement, "AI retouch")?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);

        let mut recovered_source_path: Option<PathBuf> = None;
        for (part_index, part) in placement.parts.iter().enumerate() {
            let part_path = match placement.part_dir_name(part_index) {
                Some(dir) => job_path.join(dir),
                None => job_path.clone(),
            };
            fs::create_dir_all(&part_path)
                .map_err(|e| format!("Failed to create AI retouch part folder: {e}"))?;
            if resumable {
                if let Some(bytes) = reuse_part_result(&part_path, part) {
                    emit_codex_part_progress(
                        &app,
                        &run_id,
                        part_index,
                        placement.parts.len(),
                        ai_part_progress_message(
                            &placement,
                            part_index,
                            "Reusing this part's previous result",
                        ),
                    );
                    composer.apply_part_result(part, &bytes, "AI retouch")?;
                    continue;
                }
                let _ = fs::remove_file(part_path.join("part_result.png"));
                let _ = fs::remove_file(part_path.join("result.png"));
            }
            let inputs = composer.part_inputs(part, "AI retouch")?;
            fs::write(part_path.join("source.png"), &inputs.source_png)
                .map_err(|e| format!("Failed to write AI retouch source image: {e}"))?;
            fs::write(part_path.join("edit_target.png"), &inputs.edit_target_png)
                .map_err(|e| format!("Failed to write AI retouch edit target image: {e}"))?;
            fs::write(part_path.join("mask.png"), &inputs.mask_png)
                .map_err(|e| format!("Failed to write AI retouch mask image: {e}"))?;
            let has_annotated_source = if let Some(annotated) = &inputs.annotated_source_png {
                fs::write(part_path.join("annotated_source.png"), annotated).map_err(|e| {
                    format!("Failed to write AI retouch annotated source image: {e}")
                })?;
                true
            } else {
                false
            };
            let has_reference = if let Some(reference_png) = &reference_png {
                fs::write(part_path.join("reference.png"), reference_png)
                    .map_err(|e| format!("Failed to write AI retouch reference image: {e}"))?;
                true
            } else {
                false
            };
            let has_overview = placement.is_split();
            if has_overview {
                fs::write(
                    part_path.join("overview.png"),
                    composer.overview_png(part, "AI retouch")?,
                )
                .map_err(|e| format!("Failed to write AI retouch overview image: {e}"))?;
            }
            let (reference_paths, reference_names) =
                write_reference_pngs(&part_path, &reference_pngs, "AI retouch")?;
            let geometry_note = ai_part_prompt_context(&placement, part_index);
            let base_prompt_text = codex_direct_retouch_director_prompt(
                prompt.trim(),
                has_annotated_source,
                has_reference,
                &reference_names,
                &geometry_note,
                director_provider,
                director_mode,
                director_involvement,
            );

            emit_codex_part_progress(
                &app,
                &run_id,
                part_index,
                placement.parts.len(),
                ai_part_progress_message(
                    &placement,
                    part_index,
                    "Starting Codex image generation AI retouch",
                ),
            );
            let result_path = part_path.join("result.png");
            write_ai_job_prompt(&part_path, &base_prompt_text, "Codex AI retouch")?;
            let mut image_paths = vec![
                part_path.join("source.png"),
                part_path.join("edit_target.png"),
                part_path.join("mask.png"),
            ];
            if has_annotated_source {
                image_paths.push(part_path.join("annotated_source.png"));
            }
            if has_reference {
                image_paths.push(part_path.join("reference.png"));
            }
            if has_overview {
                image_paths.push(part_path.join("overview.png"));
            }
            image_paths.extend(reference_paths.iter().cloned());
            let run_retouch_candidate =
                |turn: usize, prompt_text: &str| -> Result<CodexPartRun, (String, Option<bool>)> {
                let part_run = run_codex_direct_edit_part(
                    &app,
                    &run_id,
                    &part_path,
                    &codex_options,
                    prompt_text,
                    &image_paths,
                    &part.working,
                    "AI retouch candidate",
                )
                .map_err(|e| (ai_part_progress_message(&placement, part_index, &e), None))?;
                if part_run.normalized {
                    emit_codex_progress(
                        &app,
                        &run_id,
                        ai_part_progress_message(
                            &placement,
                            part_index,
                            &format!(
                                "Normalized AI retouch result from {}x{} to {}x{}",
                                part_run.result_dimensions.0,
                                part_run.result_dimensions.1,
                                part.crop.width,
                                part.crop.height
                            ),
                        ),
                    );
                }
                let rejection = ai_candidate_rejection(
                    checks_level,
                    &inputs.edit_target_png,
                    &inputs.source_png,
                    &inputs.mask_png,
                    &part_run.normalized_png,
                    "AI retouch candidate",
                )
                .map_err(|e| (ai_part_progress_message(&placement, part_index, &e), None))?;
                if let Some(rejection) = rejection {
                    let _ = fs::remove_file(&part_run.recovered_source_path);
                    return Err((
                        format!("PaintNode rejected candidate {turn}: {}", rejection.reason),
                        Some(rejection.continuation_retry),
                    ));
                }
                Ok(part_run)
            };
            let part_run = if agentic_tool_loop {
                run_candidate_director_loop(
                    &part_path,
                    DirectorLoopSpec {
                        provider_label: director_runner.label(),
                        involvement: director_involvement,
                        keep_debug_artifacts: codex_options.keep_debug_artifacts,
                        legacy_request_file: PAINTNODE_IMAGE_REQUEST_FILE,
                        base_prompt_text: &base_prompt_text,
                        review_criteria: workflow_review_criteria("retouch"),
                        ensure_completion_acceptance_note:
                            "Candidate completed; ensure-completion mode does not run a separate quality review.",
                    },
                    |_, turn_prompt_text, candidate_path| {
                        let mut turn_image_paths = image_paths.clone();
                        if let Some(candidate_path) = candidate_path {
                            turn_image_paths.push(candidate_path.to_path_buf());
                        }
                        run_director_provider_action_turn(
                            &app,
                            &run_id,
                            &director_runner,
                            &codex_bin,
                            &claude_options,
                            &codex_options,
                            &image_options,
                            &part_path,
                            turn_prompt_text,
                            &turn_image_paths,
                        )
                    },
                    |run| director_final_agent_message(&director_runner, &run.output),
                    |turn, _request, candidate_prompt| {
                        let part_run = run_retouch_candidate(turn, candidate_prompt)
                            .map_err(|(error, _)| error)?;
                        let candidate_file = director_candidate_file(turn);
                        fs::write(part_path.join(&candidate_file), &part_run.normalized_png)
                            .map_err(|e| {
                                format!("Failed to write AI retouch Director candidate: {e}")
                            })?;
                        Ok(DirectorCandidate {
                            result: part_run,
                            file_name: candidate_file,
                        })
                    },
                )
                .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?
            } else {
                let mut accepted_run = None;
                let mut retry_note = "";
                for attempt in 0..AI_PROTECTED_DRIFT_MAX_ATTEMPTS {
                    let prompt_text = if retry_note.is_empty() {
                        base_prompt_text.clone()
                    } else {
                        format!("{base_prompt_text}\n\n{retry_note}")
                    };
                    write_ai_job_prompt(&part_path, &prompt_text, "Codex AI retouch")?;
                    match run_retouch_candidate((attempt + 1) as usize, &prompt_text) {
                        Ok(part_run) => {
                            accepted_run = Some(part_run);
                            break;
                        }
                        Err((rejection_reason, Some(continuation_retry))) => {
                            retry_note = if continuation_retry {
                                AI_SEAM_RETRY_NOTE
                            } else {
                                CODEX_IN_PLACE_RETRY_NOTE
                            };
                            if attempt + 1 < AI_PROTECTED_DRIFT_MAX_ATTEMPTS {
                                emit_codex_progress(
                                    &app,
                                    &run_id,
                                    ai_part_progress_message(
                                        &placement,
                                        part_index,
                                        &format!(
                                            "Rejected AI retouch candidate: {}; retrying with stricter instructions",
                                            rejection_reason
                                        ),
                                    ),
                                );
                                remove_rejected_ai_candidate(&result_path).map_err(|e| {
                                    ai_part_progress_message(&placement, part_index, &e)
                                })?;
                                continue;
                            }
                            let _ = fs::remove_file(&result_path);
                            return Err(ai_part_progress_message(
                                &placement,
                                part_index,
                                &format!(
                                    "The AI image model produced an unusable candidate: {rejection_reason}. Try a smaller edit area, a simpler prompt, or a lower result-checks level."
                                ),
                            ));
                        }
                        Err((error, None)) => return Err(error),
                    }
                }
                accepted_run
                    .ok_or_else(|| "AI retouch produced no accepted candidate.".to_string())?
            };
            fs::write(part_path.join("part_result.png"), &part_run.normalized_png)
                .map_err(|e| format!("Failed to record AI retouch part result: {e}"))?;
            composer.apply_part_result(part, &part_run.normalized_png, "AI retouch")?;
            recovered_source_path = Some(part_run.recovered_source_path);
        }

        let generated_bytes = composer.composed_png("AI retouch")?;
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
            let source_file_name = recovered_source_path
                .as_deref()
                .filter(|_| !placement.is_split())
                .and_then(safe_png_source_file_name);
            emit_codex_progress(&app, &run_id, "Saving AI retouch result to the project");
            let name = ai_retouch_asset_name(prompt.trim(), source_file_name.as_deref());
            let primary_asset = store_generated_png_asset(
                &project_dir,
                &generated_bytes,
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
            layers: Vec::new(),
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

/// Enlarge a flattened document and restore its detail with tiled AI
/// regeneration (AI -> Upscale). 100% skips the enlarge and only restores.
#[tauri::command]
pub(crate) async fn upscale_codex_image(
    app: AppHandle,
    bin: Option<String>,
    project_path: Option<String>,
    keep_job_dir: Option<bool>,
    keep_composed_result: Option<bool>,
    keep_debug_artifacts: Option<bool>,
    source_png: Vec<u8>,
    scale_percent: u32,
    run_id: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    image_quality: Option<String>,
    image_moderation: Option<String>,
    autonomy_level: Option<String>,
    director_mode: Option<String>,
    director_provider: Option<String>,
    director_involvement: Option<String>,
) -> Result<GeneratedImageResult, String> {
    if !is_png(&source_png) {
        return Err("AI upscale source is not a PNG image.".into());
    }
    let source_dimensions = png_dimensions_from_bytes(&source_png)
        .ok_or_else(|| "AI upscale source PNG dimensions are invalid.".to_string())?;
    let target_dimensions = ai_upscale_target_dimensions(source_dimensions, scale_percent)?;
    // Reject over-large jobs before allocating the enlarged image.
    plan_ai_upscale_placement(AiEditProvider::Codex, target_dimensions, "AI upscale")?;

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let mut codex_options = codex_command_options(
            model,
            reasoning_effort,
            service_tier,
            image_quality,
            image_moderation,
        );
        codex_options.keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        let codex_bin = configured_codex_bin_or_sdk_default(bin);
        let _ = autonomy_level;
        let director_mode = ai_director_mode(director_mode);
        let director_provider = ai_director_provider(director_provider);
        let director_involvement = ai_director_involvement(director_involvement);
        let run_id = if run_id.trim().is_empty() {
            format!("upscale-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
        let project_dir = optional_project_dir(&project_path);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let keep_composed_result = keep_composed_result.unwrap_or(false);
        let job_project_dir = ai_job_project_dir(&app, &project_dir, keep_job_dir)?;
        let cleanup_project_job = cleanup_project_job_enabled(&job_project_dir, keep_job_dir);
        let temp_job;
        let job_path = if let Some(job_project_dir) = &job_project_dir {
            project_agent_run_dir_for_run(job_project_dir, CODEX_RUNS_DIR, "upscale", &run_id)?
        } else {
            temp_job = TempJobDir::new("paintnode-upscale")?;
            temp_job.path().to_path_buf()
        };

        let enlarged_png = if target_dimensions == source_dimensions {
            source_png
        } else {
            emit_codex_progress(
                &app,
                &run_id,
                &format!(
                    "Enlarging image from {}x{} to {}x{}",
                    source_dimensions.0,
                    source_dimensions.1,
                    target_dimensions.0,
                    target_dimensions.1
                ),
            );
            resize_png_to_dimensions(&source_png, target_dimensions, "AI upscale")?
        };
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);

        let (composed_bytes, layer_results) = codex_restore_image_details(
            &app,
            &run_id,
            &codex_bin,
            &codex_options,
            &job_path,
            &enlarged_png,
            "AI upscale",
            true,
            keep_composed_result,
            director_provider,
            director_mode,
            director_involvement,
        )?;
        let data_url = png_data_url(composed_bytes.as_deref().unwrap_or(&enlarged_png))?;
        let mut assets = Vec::new();
        let asset =
            if let (Some(project_dir), Some(bytes)) = (project_dir, composed_bytes.as_deref()) {
                fs::write(job_path.join("result.png"), bytes)
                    .map_err(|e| format!("Failed to write AI upscale result: {e}"))?;
                emit_codex_progress(&app, &run_id, "Saving upscaled image to the project");
                let primary_asset = store_generated_png_asset(
                    &project_dir,
                    bytes,
                    format!("AI Upscale {scale_percent}%"),
                    Some(format!("AI upscale to {scale_percent}%")),
                    None,
                )?;
                assets.push(primary_asset.clone());
                Some(primary_asset)
            } else if let Some(bytes) = composed_bytes.as_deref() {
                fs::write(job_path.join("result.png"), bytes)
                    .map_err(|e| format!("Failed to write AI upscale result: {e}"))?;
                None
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
            mask_data_url: None,
            layers: layer_results,
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

/// Ask local Codex to turn one source PNG into a manifest plus reusable asset PNGs.
///
/// The app owns the deterministic import step; Codex only needs to satisfy the file contract.
#[tauri::command]
pub(crate) async fn decouple_codex_image(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    source_png: Vec<u8>,
    run_id: String,
    store_assets: Option<bool>,
    keep_job_dir: Option<bool>,
    keep_debug_artifacts: Option<bool>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    image_quality: Option<String>,
    image_moderation: Option<String>,
    autonomy_level: Option<String>,
    director_mode: Option<String>,
    director_provider: Option<String>,
    director_involvement: Option<String>,
) -> Result<DecoupleImageResult, String> {
    if !is_png(&source_png) {
        return Err("Asset extraction source must be a PNG image.".into());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<DecoupleImageResult, String> {
        let mut codex_options = codex_command_options(
            model,
            reasoning_effort,
            service_tier,
            image_quality,
            image_moderation,
        );
        codex_options.keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        let codex_bin = configured_codex_bin_or_sdk_default(bin);
        let _autonomy = ai_autonomy_level(autonomy_level);
        let director_mode = ai_director_mode(director_mode);
        let director_provider = ai_director_provider(director_provider);
        let director_involvement = ai_director_involvement(director_involvement);
        let run_id = if run_id.trim().is_empty() {
            format!("decouple-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
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

        let source_dimensions = png_dimensions_from_bytes(&source_png)
            .ok_or_else(|| "Asset extraction source PNG dimensions are invalid.".to_string())?;
        write_codex_imagegen_options(&job_path, source_dimensions, &codex_options)?;
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
            &decouple_codex_director_prompt(
                user_prompt,
                director_provider,
                director_mode,
                director_involvement,
            ),
            "Codex asset extraction",
        )?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);
        let mut command = build_decouple_codex_director_command(
            &codex_bin,
            &job_path,
            user_prompt,
            &codex_options,
            director_provider,
            director_mode,
            director_involvement,
            true,
        );
        let mut run =
            run_codex_with_progress(&mut command, app.clone(), run_id.clone()).map_err(|e| {
                format!(
                    "Failed to run Codex at '{}': {e}",
                    codex_command_label(&codex_bin)
                )
            })?;

        if !run.output.status.success() && output_mentions_unsupported_json(&run.output) {
            emit_codex_progress(
                &app,
                &run_id,
                "Codex progress stream unavailable; retrying asset extraction",
            );
            let mut fallback = build_decouple_codex_director_command(
                &codex_bin,
                &job_path,
                user_prompt,
                &codex_options,
                director_provider,
                director_mode,
                director_involvement,
                false,
            );
            run = run_codex_with_progress(&mut fallback, app.clone(), run_id.clone()).map_err(
                |e| {
                    format!(
                        "Failed to run Codex at '{}': {e}",
                        codex_command_label(&codex_bin)
                    )
                },
            )?;
        }

        let manifest_path = job_path.join("manifest.json");
        if !run.output.status.success() && !manifest_path.exists() {
            match synthesize_decouple_asset_manifest(&job_path)? {
                Some(count) => emit_codex_progress(
                    &app,
                    &run_id,
                    format!("Synthesized asset manifest from {count} Codex PNG outputs"),
                ),
                None => {
                    if let Some(message) = final_codex_agent_message(&run.output) {
                        return Err(format!("Codex did not create an asset pack.\n\n{message}"));
                    }
                    return Err(command_failure("Codex asset extraction", &run.output));
                }
            }
        }

        emit_codex_progress(&app, &run_id, "Reading asset manifest");
        let manifest_text = match fs::read_to_string(&manifest_path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                match synthesize_decouple_asset_manifest(&job_path)? {
                    Some(count) => {
                        emit_codex_progress(
                            &app,
                            &run_id,
                            format!("Synthesized asset manifest from {count} Codex PNG outputs"),
                        );
                        fs::read_to_string(&manifest_path).map_err(|read_error| {
                            format!(
                                "Failed to read synthesized asset manifest at {}: {read_error}",
                                manifest_path.display()
                            )
                        })?
                    }
                    None => {
                        return Err(format!(
                            "Codex did not create manifest.json at {}: {e}",
                            manifest_path.display()
                        ));
                    }
                }
            }
            Err(e) => {
                return Err(format!(
                    "Codex did not create manifest.json at {}: {e}",
                    manifest_path.display()
                ));
            }
        };
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
                        ProjectAsset::generated_png(
                            id,
                            relative_path,
                            name.clone(),
                            Some(format!(
                                "Extracted workflow asset from source: {user_prompt}"
                            )),
                            Path::new(&layer.file)
                                .file_name()
                                .and_then(|s| s.to_str())
                                .map(str::to_string),
                        ),
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
pub(crate) async fn compose_codex_workflow(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    sources: Vec<WorkflowSourceImage>,
    run_id: String,
    keep_job_dir: Option<bool>,
    keep_debug_artifacts: Option<bool>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    image_quality: Option<String>,
    image_moderation: Option<String>,
    autonomy_level: Option<String>,
) -> Result<GeneratedImageResult, String> {
    if prompt.trim().is_empty() {
        return Err("Enter a composition prompt.".into());
    }
    if sources.is_empty() {
        return Err("Add at least one asset node before generating.".into());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let mut codex_options = codex_command_options(
            model,
            reasoning_effort,
            service_tier,
            image_quality,
            image_moderation,
        );
        codex_options.keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        let _ = bin;
        let _ = autonomy_level;
        let run_id = if run_id.trim().is_empty() {
            format!("workflow-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
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
        write_codex_imagegen_options(&job_path, (0, 0), &codex_options)?;

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
        let prompt_text = codex_direct_workflow_compose_prompt(prompt.trim(), &source_names);
        write_ai_job_prompt(&job_path, &prompt_text, "Codex workflow composition")?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);

        emit_codex_progress(
            &app,
            &run_id,
            "Requesting PaintNode Codex workflow composition",
        );
        let bytes = run_codex_direct_image_request(
            &prompt_text,
            &image_paths,
            (0, 0),
            &codex_options,
            Some(&job_path),
        )?;
        let result_path = job_path.join("result.png");
        fs::write(&result_path, &bytes)
            .map_err(|e| format!("Failed to write composed image: {e}"))?;

        let data_url = png_data_url_from_bytes(&bytes);
        let asset = if let Some(project_dir) = project_dir {
            emit_codex_progress(&app, &run_id, "Saving composed image to the project");
            let (id, relative_path) =
                write_asset_file(&project_dir, "generated", prompt.trim(), "png", &bytes)?;
            let asset = ProjectAsset::generated_png(
                id,
                relative_path,
                format!(
                    "Workflow: {}",
                    prompt.trim().chars().take(48).collect::<String>()
                ),
                Some(prompt.trim().into()),
                Some("result.png".into()),
            );
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
            layers: Vec::new(),
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::ONE_PIXEL_PNG;

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
                Some("auto".to_string()),
                Some("auto".to_string()),
            );
            let command = build_decouple_codex_command(
                "codex",
                job.path(),
                "separate objects",
                &options,
                true,
            );
            let args = command
                .get_args()
                .map(|arg| arg.to_string_lossy().to_string())
                .collect::<Vec<_>>();

            let model_idx = args
                .iter()
                .position(|arg| arg == "--model")
                .expect("model flag should be present");
            assert_eq!(args[model_idx + 1], model);
            let reasoning_idx = args
                .iter()
                .position(|arg| arg == "--reasoning")
                .expect("reasoning flag should be present");
            assert_eq!(args[reasoning_idx + 1], "high");
            let service_tier_idx = args
                .iter()
                .position(|arg| arg == "--service-tier")
                .expect("service tier flag should be present");
            assert_eq!(args[service_tier_idx + 1], "fast");
        }
    }

    #[test]
    fn capability_parser_keeps_image_models_and_advertised_effort_order() {
        let capabilities = parse_codex_capabilities_payload(br#"{"data":[{"model":"vision-a","displayName":"Vision A","inputModalities":["text","image"],"supportedReasoningEfforts":[{"reasoningEffort":"medium","description":"Balanced"},{"reasoningEffort":"high","description":"Deep"}],"defaultReasoningEffort":"high","isDefault":true},{"model":"text-only","displayName":"Text only","inputModalities":["text"],"supportedReasoningEfforts":[],"isDefault":false}]}"#)
            .expect("capabilities");
        assert_eq!(capabilities.source, "appServer");
        assert_eq!(capabilities.models.len(), 1);
        assert_eq!(capabilities.models[0].id, "vision-a");
        assert_eq!(
            capabilities.models[0].supported_reasoning_efforts[0].value,
            "medium"
        );
        assert_eq!(
            capabilities.models[0].supported_reasoning_efforts[1].value,
            "high"
        );
        assert_eq!(
            capabilities.models[0].default_reasoning_effort.as_deref(),
            Some("high")
        );
    }

    #[test]
    fn codex_imagegen_options_record_supported_size_quality_and_moderation() {
        let job = TempJobDir::new("paintnode-codex-imagegen-options-test").expect("temp dir");
        let options = CodexCommandOptions {
            image_quality: Some("high".to_string()),
            image_moderation: Some("low".to_string()),
            ..CodexCommandOptions::default()
        };

        write_codex_imagegen_options(job.path(), (3008, 1008), &options)
            .expect("write imagegen options");
        let value: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(job.path().join("imagegen-options.json")).unwrap(),
        )
        .expect("options json");

        assert_eq!(value["size"], "3008x1008");
        assert_eq!(value["quality"], "high");
        assert_eq!(value["moderation"], "low");
        assert_eq!(gpt_image2_size_for_dimensions((3000, 800)), None);
    }

    #[test]
    fn removes_codex_debug_artifacts_when_debug_mode_is_off() {
        let job = TempJobDir::new("paintnode-codex-debug-cleanup-test").expect("temp dir");
        for file_name in [
            PAINTNODE_CODEX_IMAGE_REQUEST_FILE,
            PAINTNODE_CODEX_IMAGE_RESPONSE_FILE,
        ] {
            fs::write(job.path().join(file_name), b"debug").expect("write debug artifact");
        }

        remove_codex_debug_artifacts(job.path());

        for file_name in [
            PAINTNODE_CODEX_IMAGE_REQUEST_FILE,
            PAINTNODE_CODEX_IMAGE_RESPONSE_FILE,
        ] {
            assert!(!job.path().join(file_name).exists());
        }
    }

    #[test]
    fn codex_image_edit_request_uses_size_and_moderation_without_quality() {
        let options = CodexCommandOptions {
            image_quality: Some("high".into()),
            image_moderation: Some("low".into()),
            ..CodexCommandOptions::default()
        };
        let body = codex_image_edit_request_json(
            "fill the frame",
            vec!["data:image/png;base64,AAAA".into()],
            (3008, 1008),
            &options,
        );

        assert_eq!(body["model"], "gpt-image-2");
        assert_eq!(body["background"], "auto");
        assert_eq!(body["size"], "3008x1008");
        assert_eq!(body["moderation"], "low");
        assert!(body.get("quality").is_none());
        assert_eq!(body["images"][0]["image_url"], "data:image/png;base64,AAAA");
    }

    #[test]
    fn codex_image_generation_request_uses_size_quality_and_moderation() {
        let options = CodexCommandOptions {
            image_quality: Some("high".into()),
            image_moderation: Some("low".into()),
            ..CodexCommandOptions::default()
        };
        let body = codex_image_generation_request_json(
            "make a watercolor lighthouse",
            (1280, 720),
            &options,
        );

        assert_eq!(body["prompt"], "make a watercolor lighthouse");
        assert_eq!(body["model"], "gpt-image-2");
        assert_eq!(body["background"], "auto");
        assert_eq!(body["size"], "1280x720");
        assert_eq!(body["quality"], "high");
        assert_eq!(body["moderation"], "low");
        assert_eq!(body["output_format"], "png");
        assert!(body.get("images").is_none());
    }

    #[test]
    fn codex_direct_image_requests_fall_back_to_auto_for_unsupported_size() {
        let options = CodexCommandOptions::default();
        let generation =
            codex_image_generation_request_json("make a poster", (3000, 800), &options);
        let edit = codex_image_edit_request_json(
            "extend the scene",
            vec!["data:image/png;base64,AAAA".into()],
            (3000, 800),
            &options,
        );

        assert_eq!(generation["size"], "auto");
        assert_eq!(edit["size"], "auto");
    }

    #[test]
    fn direct_codex_assist_prompts_do_not_use_imagegen_skill_or_cache_contract() {
        let prompts = [
            codex_direct_generate_prompt(
                "paint a quiet kitchen",
                &["references/reference-1-style.png".to_string()],
            ),
            codex_direct_retouch_prompt(
                "remove glare",
                true,
                true,
                &["references/reference-1-prop.png".to_string()],
                TEST_GEOMETRY_NOTE,
            ),
            codex_direct_restore_prompt(
                TEST_GEOMETRY_NOTE,
                AiDirectorMode::Auto,
                AiDirectorInvolvement::FullReview,
            ),
            codex_direct_workflow_compose_prompt(
                "girl holds apple by the water",
                &[
                    "Girl With Empty Hands".to_string(),
                    "Storyboard sketch".to_string(),
                ],
            ),
        ];

        for prompt in prompts {
            assert!(!prompt.contains("$imagegen"));
            assert!(!prompt.contains("generated-images cache"));
            assert!(!prompt.contains("Use the imagegen skill"));
            assert!(!prompt.contains("Save the final PNG as"));
        }
    }

    #[test]
    fn paintnode_owned_image_prompt_combines_director_constraints() {
        let request = PaintNodeImageRequest {
            prompt: "Extend the train bench and seaside view.".into(),
            constraints: vec!["Match the existing camera perspective.".into()],
            avoid: vec!["Do not add guide marks.".into()],
            notes: "Use the base image as the fixed frame.".into(),
            ..PaintNodeImageRequest::default()
        };
        let prompt = paintnode_owned_image_prompt(&request).expect("prompt");

        assert!(prompt.contains("Extend the train bench"));
        assert!(prompt.contains("Constraints:"));
        assert!(prompt.contains("Match the existing camera perspective"));
        assert!(prompt.contains("Avoid:"));
        assert!(prompt.contains("Do not add guide marks"));
        assert!(prompt.contains("Use the base image as the fixed frame"));
    }

    #[test]
    fn codex_command_uses_augmented_cli_path() {
        let job = TempJobDir::new("paintnode-codex-path-test").expect("temp dir");
        let command = build_decouple_codex_command(
            "codex",
            job.path(),
            "separate objects",
            &CodexCommandOptions::default(),
            true,
        );
        let path = command
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, value)| value)
            .map(|value| value.to_string_lossy().to_string())
            .expect("PATH should be set");

        assert!(path.split(':').any(|entry| entry == "/opt/homebrew/bin"));
        assert!(path.split(':').any(|entry| entry == "/usr/local/bin"));
    }

    #[test]
    fn codex_direct_generate_prompt_mentions_reference_images() {
        let prompt = codex_direct_generate_prompt(
            "make an image",
            &["references/reference-1-style.png".to_string()],
        );

        assert!(prompt.contains("Additional user reference images"));
        assert!(prompt.contains("`references/reference-1-style.png`"));
        assert!(prompt.contains("make an image"));
        assert!(!prompt.contains("$imagegen"));
        assert!(!prompt.contains("generated-images cache"));
    }

    const TEST_GEOMETRY_NOTE: &str =
        "PaintNode image geometry:\n- The attached images are the full PaintNode document.";

    fn command_args(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>()
    }

    fn sdk_image_args(args: &[String]) -> Vec<String> {
        args.windows(2)
            .filter_map(|window| {
                if window[0] == "--image" {
                    Some(window[1].clone())
                } else {
                    None
                }
            })
            .collect()
    }

    fn sdk_prompt_arg(args: &[String]) -> &str {
        let prompt_idx = args
            .iter()
            .position(|arg| arg == "--")
            .expect("prompt delimiter");
        args.get(prompt_idx + 1).expect("prompt arg")
    }

    #[test]
    fn codex_without_user_bin_uses_sdk_bundled_codex() {
        let job = TempJobDir::new("paintnode-codex-sdk-bundled-test").expect("temp dir");
        let codex_bin = configured_codex_bin_or_sdk_default(None);
        assert_eq!(codex_bin, "");

        let command = build_decouple_codex_command(
            &codex_bin,
            job.path(),
            "separate objects",
            &CodexCommandOptions::default(),
            true,
        );
        let args = command_args(&command);

        assert_eq!(command.get_program().to_string_lossy(), "node");
        assert!(
            !args.iter().any(|arg| arg == "--codex-path"),
            "Codex should use the SDK package's paired CLI unless the user explicitly chooses a binary"
        );
        assert!(
            args.iter()
                .any(|arg| arg.ends_with("scripts/codex-sdk-runner.mjs")),
            "Codex should use the SDK runner"
        );
    }

    #[test]
    fn unmanaged_plan_only_fill_director_prompt_omits_method_guardrails() {
        let fill = generative_fill_director_prompt(
            "extend photo",
            AiAutonomyLevel::Unmanaged,
            AiDirectorProvider::Codex,
            AiDirectorMode::Force,
            AiDirectorInvolvement::PlanOnly,
            TEST_GEOMETRY_NOTE,
            "",
            false,
            false,
            false,
            false,
            &[],
        );
        assert!(fill.contains("Autonomy level: Unmanaged"));
        assert!(fill.contains(PAINTNODE_IMAGE_REQUEST_FILE));
        assert!(!fill.contains(PAINTNODE_DIRECTOR_ACTION_FILE));
        assert!(!fill.contains("$imagegen"));
        assert!(!fill.contains("normal Codex image-generation flow"));
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
        let args = command_args(&command);
        assert_eq!(command.get_program().to_string_lossy(), "node");
        assert_eq!(
            sdk_image_args(&args),
            vec![job.path().join("source.png").to_string_lossy().to_string()]
        );
        assert!(
            sdk_prompt_arg(&args).contains("User guidance:\nseparate objects"),
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
        assert!(prompt.contains("Director review criteria"));
        assert!(prompt.contains("Manifest entries must point to valid PNG files"));
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
    fn generative_fill_command_attaches_only_source_before_prompt() {
        let job = TempJobDir::new("paintnode-fill-command-test").expect("temp dir");
        let reference_paths = vec![job.path().join("references").join("reference-1-style.png")];
        let reference_names = vec!["references/reference-1-style.png".to_string()];
        let prompt_text = generative_fill_prompt(
            "extend photo",
            AiAutonomyLevel::Low,
            TEST_GEOMETRY_NOTE,
            "",
            false,
            false,
            false,
            false,
            &reference_names,
        );
        let command = build_generative_fill_codex_command(
            "codex",
            job.path(),
            &prompt_text,
            false,
            &[],
            &reference_paths,
            &CodexCommandOptions::default(),
            true,
        );
        let args = command_args(&command);
        assert_eq!(
            sdk_image_args(&args),
            vec![
                job.path().join("source.png").to_string_lossy().to_string(),
                reference_paths[0].to_string_lossy().to_string()
            ]
        );
        assert!(!args
            .iter()
            .any(|arg| arg == &job.path().join("edit_target.png").to_string_lossy()));
        assert!(!args
            .iter()
            .any(|arg| arg == &job.path().join("mask.png").to_string_lossy()));
        let prompt_arg = sdk_prompt_arg(&args);
        assert!(prompt_arg.contains("the full PaintNode document"));
        assert!(!prompt_arg.contains("chroma"));
        assert!(!prompt_arg.contains("#00ff00"));
        assert!(!prompt_arg.contains("centered content rectangle"));
        assert!(prompt_arg.contains("PaintNode will crop, paste, and apply the editable mask"));
        assert!(!prompt_arg.contains("edit_target.png"));
        assert!(!prompt_arg.contains("mask.png"));
        assert!(prompt_arg.contains(PAINTNODE_DIRECTOR_ACTION_FILE));
        assert!(prompt_arg.contains("generateCandidate"));
        assert!(prompt_arg.contains("acceptResult"));
        assert!(prompt_arg.contains(PAINTNODE_DIRECTOR_OBSERVATION_FILE));
        assert!(!prompt_arg.contains("$imagegen"));
        assert!(!prompt_arg.contains("generated-images cache"));
        assert!(!prompt_arg.contains("Save the final PNG as `result.png`"));
        assert!(prompt_arg.contains("`references/reference-1-style.png`"));
        assert!(prompt_arg.contains("Original user edit prompt:\nextend photo"));
        assert!(!prompt_arg.contains("master image-extension guidance"));

        let storyboard_prompt = generative_fill_prompt(
            "a beach photo in film style",
            AiAutonomyLevel::Low,
            TEST_GEOMETRY_NOTE,
            "",
            true,
            false,
            true,
            true,
            &[],
        );
        assert!(storyboard_prompt.contains("PaintNode draft enhancement"));
        assert!(storyboard_prompt.contains("source.png` is the PaintNode edit frame to enhance"));
        assert!(storyboard_prompt.contains("`overview.png` may be present"));
        assert!(storyboard_prompt.contains("never use `overview.png` as the source or base image"));
        assert!(storyboard_prompt.contains("never reproduce the red outline"));
        assert!(storyboard_prompt.contains("image enhancement/restoration pass at the same size"));
        assert!(storyboard_prompt.contains(PAINTNODE_DIRECTOR_ACTION_FILE));
        assert!(storyboard_prompt.contains("acceptResult"));
        assert!(!storyboard_prompt.contains("$imagegen"));
        assert!(!storyboard_prompt.contains("generated-images cache"));
        assert!(storyboard_prompt.contains("Do not add, remove, duplicate, replace, move"));
        assert!(!storyboard_prompt.contains("edit_target.png"));
        assert!(!storyboard_prompt.contains("mask.png"));
        assert!(!storyboard_prompt.contains("Orchestrator"));
        assert!(!storyboard_prompt.contains("beach photo in film style"));
        assert!(!storyboard_prompt.contains("beach anchor"));
        assert!(!storyboard_prompt.contains("Original user edit prompt"));
        assert!(!storyboard_prompt.contains("Global style rules"));
        assert!(!storyboard_prompt.contains("part 1 of"));
    }

    #[test]
    fn generative_fill_prompts_are_paintnode_director_only() {
        let prompts = [
            generative_fill_prompt(
                "extend photo",
                AiAutonomyLevel::Low,
                TEST_GEOMETRY_NOTE,
                "",
                false,
                false,
                false,
                false,
                &[],
            ),
            generative_fill_prompt(
                "extend photo",
                AiAutonomyLevel::Low,
                TEST_GEOMETRY_NOTE,
                "Orchestrator subtask prompt:\ncontinue the beach",
                true,
                false,
                true,
                false,
                &[],
            ),
            generative_fill_prompt(
                "extend photo",
                AiAutonomyLevel::Low,
                TEST_GEOMETRY_NOTE,
                "",
                true,
                false,
                true,
                true,
                &[],
            ),
        ];

        for prompt in prompts {
            assert!(prompt.contains(PAINTNODE_DIRECTOR_ACTION_FILE));
            assert!(prompt.contains("generateCandidate"));
            assert!(!prompt.contains("$imagegen"));
            assert!(!prompt.contains("normal Codex image-generation flow"));
            assert!(!prompt.contains("generated-images cache"));
        }
    }

    #[test]
    fn plan_only_fill_prompt_uses_legacy_image_request_contract() {
        let prompt = generative_fill_director_prompt(
            "extend photo",
            AiAutonomyLevel::Low,
            AiDirectorProvider::Claude,
            AiDirectorMode::Force,
            AiDirectorInvolvement::PlanOnly,
            TEST_GEOMETRY_NOTE,
            "",
            false,
            false,
            false,
            false,
            &[],
        );

        assert!(prompt.contains("AI Director participation: Plan only"));
        assert!(prompt.contains(PAINTNODE_IMAGE_REQUEST_FILE));
        assert!(!prompt.contains(PAINTNODE_DIRECTOR_ACTION_FILE));
        assert!(!prompt.contains("acceptResult"));
    }

    #[test]
    fn fill_command_attaches_overview_for_split_parts() {
        let job = TempJobDir::new("paintnode-overview-command-test").expect("temp dir");
        let fill = build_generative_fill_codex_command(
            "codex",
            job.path(),
            "prompt",
            true,
            &[],
            &[],
            &CodexCommandOptions::default(),
            true,
        );
        let fill_args = command_args(&fill);
        assert_eq!(
            sdk_image_args(&fill_args),
            vec![
                job.path().join("source.png").to_string_lossy().to_string(),
                job.path()
                    .join("overview.png")
                    .to_string_lossy()
                    .to_string()
            ]
        );
        assert!(!fill_args
            .iter()
            .any(|arg| *arg == job.path().join("edit_target.png").to_string_lossy()));
        assert!(!fill_args
            .iter()
            .any(|arg| *arg == job.path().join("mask.png").to_string_lossy()));
        assert!(!fill_args
            .iter()
            .any(|arg| arg.contains("storyboard-draft-crop.png")));
        assert!(!fill_args
            .iter()
            .any(|arg| arg.contains(FILL_STORYBOARD_DRAFT_FILE)));
    }

    #[test]
    fn codex_direct_retouch_prompt_describes_optional_guidance_and_mask_contract() {
        let prompt = codex_direct_retouch_prompt(
            "remove glare",
            true,
            true,
            &["references/reference-1-style.png".to_string()],
            TEST_GEOMETRY_NOTE,
        );

        assert!(
            prompt.contains("Act as PaintNode's AI Director for one in-place PaintNode retouch")
        );
        assert!(prompt.contains(PAINTNODE_DIRECTOR_ACTION_FILE));
        assert!(prompt.contains("Allowed PaintNode tool action: `generateCandidate`"));
        assert!(prompt.contains("Director review criteria"));
        assert!(prompt.contains("over-smoothed skin"));
        assert!(prompt.contains("the full PaintNode document"));
        assert!(!prompt.contains("chroma"));
        assert!(!prompt.contains("#00ff00"));
        assert!(prompt.contains("Black pixels are locked context"));
        assert!(prompt.contains("`annotated_source.png` is an optional guide image"));
        assert!(prompt.contains("`reference.png` is an optional sampled reference area"));
        assert!(prompt.contains("`references/reference-1-style.png`: user-added visual reference"));
        assert!(prompt.contains("red arrows, yellow callout boxes, annotation text"));
        assert!(prompt.contains("User retouch prompt:\nremove glare"));
        assert!(prompt.contains(
            "Make the candidate visually identical to `source.png` everywhere `mask.png` is black or transparent"
        ));
        assert!(prompt
            .contains("The `generateCandidate` action must request one full-canvas PNG candidate"));
        assert!(prompt.contains("Preserve identity, face, hair, skin, hands"));
        assert!(!prompt.contains("$imagegen"));
        assert!(!prompt.contains("generated-images cache"));
    }

    #[test]
    fn codex_direct_restore_prompt_targets_detail_without_content_changes() {
        let prompt = codex_direct_restore_prompt(
            TEST_GEOMETRY_NOTE,
            AiDirectorMode::Auto,
            AiDirectorInvolvement::FullReview,
        );

        assert!(prompt.contains(
            "Act as PaintNode's AI Director for one fixed-canvas image-detail restoration region"
        ));
        assert!(prompt.contains("AI Director participation: Full review"));
        assert!(prompt.contains(PAINTNODE_DIRECTOR_ACTION_FILE));
        assert!(prompt.contains("Allowed PaintNode tool action: `generateCandidate`"));
        assert!(prompt.contains("Director review criteria"));
        assert!(prompt.contains("plastic denoising"));
        assert!(prompt
            .contains("The `generateCandidate` action must request one full-canvas PNG candidate"));
        assert!(prompt.contains("Do not add, remove, move, restyle, or reinterpret any content"));
        assert!(prompt.contains("Preserve intentional medium character such as film grain"));
        assert!(prompt.contains("the full PaintNode document"));
        assert!(prompt.contains("Critical registration rule"));
        assert!(prompt.contains("registered to `source.png`"));
        assert!(!prompt.contains("edit_target.png"));
        assert!(!prompt.contains("chroma"));
        assert!(!prompt.contains("User retouch prompt"));
        assert!(!prompt.contains("$imagegen"));
        assert!(!prompt.contains("generated-images cache"));
    }

    #[test]
    fn codex_direct_restore_prompt_honors_director_involvement() {
        let plan_only = codex_direct_restore_prompt(
            TEST_GEOMETRY_NOTE,
            AiDirectorMode::Force,
            AiDirectorInvolvement::PlanOnly,
        );
        let ensure_completion = codex_direct_restore_prompt(
            TEST_GEOMETRY_NOTE,
            AiDirectorMode::Force,
            AiDirectorInvolvement::EnsureCompletion,
        );
        let skipped = codex_direct_restore_prompt(
            TEST_GEOMETRY_NOTE,
            AiDirectorMode::Skip,
            AiDirectorInvolvement::FullReview,
        );

        assert!(plan_only.contains("AI Director participation: Plan only"));
        assert!(plan_only.contains("Restore image detail for one PaintNode fixed-canvas region"));
        assert!(!plan_only.contains(PAINTNODE_DIRECTOR_ACTION_FILE));
        assert!(plan_only.contains("Director planning criteria"));
        assert!(ensure_completion.contains("AI Director participation: Ensure completion"));
        assert!(ensure_completion.contains(PAINTNODE_DIRECTOR_ACTION_FILE));
        assert!(!skipped.contains("AI Director participation:"));
        assert!(!skipped.contains(PAINTNODE_DIRECTOR_ACTION_FILE));
    }

    #[test]
    fn codex_direct_retouch_prompt_keeps_registration_rules_without_chroma_geometry() {
        let prompt = codex_direct_retouch_prompt(
            "remove glare",
            false,
            false,
            &[],
            "PaintNode image geometry:\n- The attached images are a crop of a larger PaintNode document; PaintNode will paste your result back into the correct document region automatically.",
        );

        assert!(
            prompt.contains("Act as PaintNode's AI Director for one in-place PaintNode retouch")
        );
        assert!(prompt.contains(
            "This is a fixed-canvas image editing task, not a new image generation task"
        ));
        assert!(prompt.contains("Critical registration rule"));
        assert!(prompt.contains("a crop of a larger PaintNode document"));
        assert!(prompt
            .contains("paste your result back into the correct document region automatically"));
        assert!(!prompt.contains("The following anchors must remain in the same pixel positions"));
        assert!(!prompt.contains("window frame"));
        assert!(!prompt.contains("train seat"));
        assert!(!prompt.contains("subject eye position"));
        assert!(!prompt.contains("nearby bag"));
        assert!(prompt
            .contains("The `generateCandidate` action must request one full-canvas PNG candidate"));
        assert!(prompt.contains(PAINTNODE_DIRECTOR_ACTION_FILE));
        assert!(prompt.contains("Do not translate, shift, crop, zoom, rotate"));
        assert!(prompt.contains("User retouch prompt:\nremove glare"));
        assert!(!prompt.contains("PaintNode image geometry:\n- Working PNG"));
        assert!(!prompt.contains("Document rectangle: x="));
        assert!(!prompt.contains("chroma"));
        assert!(!prompt.contains("#00ff00"));
        assert!(!prompt.contains("No annotated source guide"));
        assert!(!prompt.contains("No reference image is attached"));
        assert!(!prompt.contains("$imagegen"));
        assert!(!prompt.contains("generated-images cache"));
    }

    #[test]
    fn codex_direct_workflow_compose_prompt_requires_connected_assets_and_storyboard() {
        let prompt = codex_direct_workflow_compose_prompt(
            "girl holds apple by the water",
            &[
                "Girl With Empty Hands".to_string(),
                "Storyboard sketch: composition layout and handwritten placement annotations"
                    .to_string(),
            ],
        );

        assert!(prompt.contains("Connected workflow inputs"));
        assert!(prompt.contains("Treat every attached image as intentionally connected"));
        assert!(
            prompt.contains("The final PNG must visibly include every mandatory connected asset")
        );
        assert!(prompt.contains("This is a generative synthesis task"));
        assert!(prompt.contains("Reconstruct the final scene naturally"));
        assert!(prompt.contains("not a cut-and-paste compositing task"));
        assert!(prompt.contains("Preserve normal real-world structure"));
        assert!(prompt.contains("Pay special attention to human anatomy"));
        assert!(prompt.contains("treat it as the primary spatial plan"));
        assert!(prompt.contains("left/right ordering"));
        assert!(prompt.contains("physically connected in the final image"));
        assert!(!prompt.contains("$imagegen"));
        assert!(!prompt.contains("generated-images cache"));
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
}
