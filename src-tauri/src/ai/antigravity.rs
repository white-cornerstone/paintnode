//! Antigravity provider: direct image backend executor plus agent-backed asset extraction.

use std::fs;
use std::io::{Read, Seek};
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Output;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use reqwest::blocking::Client;
use serde::Deserialize;
use serde_json::json;
use tauri::AppHandle;

use crate::ai::canvas::{
    ai_antigravity_image_capability, ai_candidate_rejection, ai_edit_checks_level,
    ai_retouch_editable_mask_png, antigravity_output_target,
    read_png_bytes_cropped_to_ai_working_canvas, remove_rejected_ai_candidate,
    validate_optional_target_dimensions, AiWorkingCanvas, AI_PROTECTED_DRIFT_MAX_ATTEMPTS,
    AI_RETOUCH_OUTPUT_MASK_FEATHER_RADIUS, AI_RETOUCH_OUTPUT_MASK_GROW_RADIUS, AI_SEAM_RETRY_NOTE,
};
use crate::ai::director::{
    director_candidate_file, director_uses_agentic_loop, image_request_prompt,
    run_candidate_director_loop, workflow_review_criteria, DirectorCandidate, DirectorLoopSpec,
    PAINTNODE_DIRECTOR_ACTION_FILE, PAINTNODE_DIRECTOR_OBSERVATION_FILE,
};
use crate::ai::fill_storyboard::{
    fallback_fill_storyboard, fill_storyboard_antigravity_draft_aspect_label,
    fill_storyboard_part_is_anchor, fill_storyboard_part_prompt, read_fill_storyboard_file,
    should_storyboard_fill, write_fill_storyboard_file, FillStoryboard,
    FILL_STORYBOARD_DRAFT_CANVAS_FILE, FILL_STORYBOARD_DRAFT_FILE, FILL_STORYBOARD_DRAFT_MASK_FILE,
    FILL_STORYBOARD_OVERVIEW_FILE,
};
use crate::ai::placement::{
    ai_orchestrated_part_prompt_context, ai_part_geometry_note, ai_part_progress_message,
    ai_part_prompt_context, ai_upscale_target_dimensions, correct_part_result_drift,
    cover_crop_png_to_dimensions, fill_part_needs_overview, fill_placement_returns_layer_results,
    normalize_storyboard_draft_png, plan_ai_edit_placement, plan_ai_fill_placement,
    plan_ai_restore_placement, plan_ai_upscale_placement, prepare_ai_job_dir_for_placement,
    resize_png_to_dimensions, reuse_part_result, storyboard_draft_canvas_png,
    storyboard_draft_mask_png, AiEditComposer, AiEditPlacement, AiEditProvider, AiFillMethod,
    AiFillRedundancy, AI_RESTORE_UPSCALE_THRESHOLD,
};
use crate::ai::{
    ai_autonomy_level, ai_director_involvement, ai_director_mode, ai_director_provider,
    ai_director_restore_contract, ai_director_workflow_contract, ai_retouch_asset_name,
    ai_run_cancelled, apply_ai_cli_environment, clean_option, cleanup_project_agent_job,
    clear_ai_run_cancelled, command_failure_with_required_output, emit_codex_part_progress,
    emit_codex_progress, emit_job_file_progress, emit_kept_job_dir, image_agent_autonomy_contract,
    now_id, output_tail, project_or_temp_job_path, reference_prompt_note,
    remove_legacy_generative_fill_agent_inputs, required_png_output_is_ready, safe_job_child_path,
    sanitize_progress_line, should_keep_job_dir, spawn_output_reader,
    synthesize_decouple_asset_manifest, validate_reference_pngs, watched_job_files,
    write_ai_job_prompt, write_ai_job_settings, write_reference_pngs, AgentRunResult,
    AiAutonomyLevel, AiDirectorInvolvement, AiDirectorMode, AiDirectorProvider,
    CodexDetectionResult, DecoupleImageResult, DecoupleManifest, DecoupledLayerResult,
    GeneratedImageLayerResult, GeneratedImageResult, WorkflowSourceImage, AI_RUN_STOPPED_MESSAGE,
    POLL_INTERVAL,
};
use crate::png::{encode_rgba_png, is_png, png_data_url, png_dimensions_from_bytes};
use crate::project::{
    add_asset, safe_stem, store_generated_png_asset, write_asset_file, ProjectAsset,
};

#[derive(Debug, Default)]
struct AntigravityCommandOptions {
    model: Option<String>,
    approval_mode: Option<String>,
    image_model: Option<String>,
    image_size: Option<String>,
    person_generation: Option<String>,
    prominent_people: Option<String>,
    compression_quality: Option<u8>,
    advanced_json: Option<String>,
    safety_filtering: Option<String>,
    safety_harassment: Option<String>,
    safety_hate_speech: Option<String>,
    safety_sexually_explicit: Option<String>,
    safety_dangerous_content: Option<String>,
    keep_debug_artifacts: bool,
}

const DEFAULT_ANTIGRAVITY_IMAGE_MODEL: &str = "gemini-3.1-flash-image";
const PAINTNODE_ANTIGRAVITY_IMAGE_REQUEST_FILE: &str = "paintnode-antigravity-image-request.json";
const PAINTNODE_ANTIGRAVITY_IMAGE_RESPONSE_FILE: &str = "paintnode-antigravity-image-response.json";
const ANTIGRAVITY_AUTH_LOG_FILE: &str = "agy-auth.log";
const ANTIGRAVITY_SAFETY_DEFAULT_THRESHOLD: &str = "HARM_BLOCK_THRESHOLD_UNSPECIFIED";
const ANTIGRAVITY_SAFETY_CATEGORIES: [(&str, &str); 4] = [
    ("HARM_CATEGORY_HARASSMENT", "harassment"),
    ("HARM_CATEGORY_HATE_SPEECH", "hateSpeech"),
    ("HARM_CATEGORY_SEXUALLY_EXPLICIT", "sexuallyExplicit"),
    ("HARM_CATEGORY_DANGEROUS_CONTENT", "dangerousContent"),
];

#[derive(Debug, Deserialize)]
struct AntigravityKeychainEnvelope {
    token: Option<AntigravityStoredToken>,
}

#[derive(Debug, Deserialize)]
struct AntigravityStoredToken {
    access_token: String,
    token_type: Option<String>,
    expiry: Option<String>,
}

#[derive(Debug)]
struct AntigravityAuthToken {
    access_token: String,
    token_type: Option<String>,
    expiry: Option<String>,
}

#[derive(Debug)]
struct AntigravityImageRequestSpec {
    prompt: String,
    image_paths: Vec<PathBuf>,
    aspect_ratio: Option<String>,
    image_size: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AntigravityGenerateContentEnvelope {
    response: Option<AntigravityGenerateContentResponse>,
    trace_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AntigravityGenerateContentResponse {
    candidates: Vec<AntigravityCandidate>,
    model_version: Option<String>,
    response_id: Option<String>,
}

impl Default for AntigravityGenerateContentResponse {
    fn default() -> Self {
        Self {
            candidates: Vec::new(),
            model_version: None,
            response_id: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AntigravityCandidate {
    content: Option<AntigravityContent>,
    finish_reason: Option<String>,
    finish_message: Option<String>,
}

impl Default for AntigravityCandidate {
    fn default() -> Self {
        Self {
            content: None,
            finish_reason: None,
            finish_message: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AntigravityContent {
    parts: Vec<AntigravityPart>,
}

impl Default for AntigravityContent {
    fn default() -> Self {
        Self { parts: Vec::new() }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct AntigravityPart {
    inline_data: Option<AntigravityInlineData>,
    text: Option<String>,
}

impl Default for AntigravityPart {
    fn default() -> Self {
        Self {
            inline_data: None,
            text: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AntigravityInlineData {
    mime_type: Option<String>,
    data: String,
}

fn antigravity_image_backend_base_url() -> String {
    std::env::var("PAINTNODE_ANTIGRAVITY_IMAGE_BASE_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "https://daily-cloudcode-pa.googleapis.com".into())
}

fn antigravity_generate_content_url(image_base_url: &str) -> String {
    format!(
        "{}/v1internal:generateContent",
        image_base_url.trim_end_matches('/')
    )
}

fn antigravity_image_http_client(user_agent: &str) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(300))
        .user_agent(user_agent.to_string())
        .build()
        .map_err(|e| {
            format_antigravity_image_request_error(
                "Failed to create Antigravity image HTTP client",
                &e,
            )
        })
}

fn format_antigravity_image_request_error(context: &str, error: &reqwest::Error) -> String {
    let mut message = format!("{context}: {error}");
    if error.is_timeout() {
        message.push_str("\n\nThe request timed out while contacting Antigravity. Check the network connection, VPN/proxy, and Google service access, then retry.");
    } else if error.is_connect() {
        message.push_str("\n\nPaintNode could not connect to Antigravity. Check the network connection, VPN/proxy, firewall, and Google service access, then retry.");
    } else if error.is_request() || error.is_body() {
        message.push_str("\n\nThe image upload failed before Antigravity returned a response. Retry once; if it repeats, try a smaller selected area or fewer reference images.");
    }
    message
}

fn antigravity_command_failure(prefix: &str, output: &Output) -> String {
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
    let auth_hint = if lower.contains("not authenticated")
        || lower.contains("not logged in")
        || lower.contains("login")
        || lower.contains("unauthorized")
    {
        "\n\nRun `agy` in Terminal and sign in to Antigravity, then try again."
    } else {
        ""
    };
    format!("{prefix} failed.{auth_hint}\n\n{detail}")
}

fn antigravity_version_from_output(text: &str) -> Option<String> {
    text.split_whitespace().find_map(|token| {
        let token = token.trim().trim_start_matches('v');
        let start = token.find(|ch: char| ch.is_ascii_digit())?;
        let version = token[start..]
            .trim_matches(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '.' || ch == '-'));
        version
            .chars()
            .any(|ch| ch.is_ascii_digit())
            .then(|| version.to_string())
    })
}

fn antigravity_cli_version(antigravity_bin: &str) -> String {
    let mut command = Command::new(antigravity_bin);
    apply_ai_cli_environment(&mut command).arg("--version");
    let text = command
        .output()
        .ok()
        .map(|output| {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            format!("{stdout}\n{stderr}")
        })
        .unwrap_or_default();
    antigravity_version_from_output(&text).unwrap_or_else(|| "1.0.16".into())
}

fn antigravity_image_user_agent(antigravity_bin: &str) -> String {
    format!("antigravity/{}", antigravity_cli_version(antigravity_bin))
}

fn wake_antigravity_auth(
    antigravity_bin: &str,
    job_path: &Path,
    keep_debug_artifacts: bool,
) -> Result<(), String> {
    fs::create_dir_all(job_path)
        .map_err(|e| format!("Failed to create Antigravity auth job folder: {e}"))?;
    let mut command = Command::new(antigravity_bin);
    apply_ai_cli_environment(&mut command);
    if keep_debug_artifacts {
        command
            .arg("--log-file")
            .arg(job_path.join(ANTIGRAVITY_AUTH_LOG_FILE));
    }
    command.arg("models");
    let output = command.output().map_err(|e| {
        format!("Failed to launch Antigravity auth helper at '{antigravity_bin}': {e}")
    })?;
    if output.status.success() {
        Ok(())
    } else {
        Err(antigravity_command_failure(
            "Antigravity auth helper",
            &output,
        ))
    }
}

fn remove_antigravity_debug_artifacts(job_path: &Path) {
    for file_name in [
        ANTIGRAVITY_AUTH_LOG_FILE,
        PAINTNODE_ANTIGRAVITY_IMAGE_REQUEST_FILE,
        PAINTNODE_ANTIGRAVITY_IMAGE_RESPONSE_FILE,
    ] {
        let _ = fs::remove_file(job_path.join(file_name));
    }
}

fn parse_antigravity_keychain_token(raw: &str) -> Result<AntigravityAuthToken, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Antigravity Keychain token is empty.".into());
    }
    let encoded = trimmed
        .rsplit_once(':')
        .map(|(_, encoded)| encoded)
        .unwrap_or(trimmed)
        .trim();
    let decoded = BASE64_STANDARD
        .decode(encoded.as_bytes())
        .map_err(|e| format!("Antigravity Keychain token envelope is not valid base64: {e}"))?;
    let envelope: AntigravityKeychainEnvelope = serde_json::from_slice(&decoded)
        .map_err(|e| format!("Antigravity Keychain token envelope is invalid JSON: {e}"))?;
    let token = envelope.token.ok_or_else(|| {
        "Antigravity Keychain token envelope did not contain a token.".to_string()
    })?;
    if token.access_token.trim().is_empty() {
        return Err("Antigravity Keychain token envelope had no access token.".into());
    }
    Ok(AntigravityAuthToken {
        access_token: token.access_token,
        token_type: token.token_type,
        expiry: token.expiry,
    })
}

fn load_antigravity_keychain_token() -> Result<AntigravityAuthToken, String> {
    #[cfg(not(target_os = "macos"))]
    {
        return Err("Antigravity direct image generation is currently macOS-only because PaintNode reads the authenticated Antigravity token from macOS Keychain.".into());
    }

    #[cfg(target_os = "macos")]
    {
        let output = Command::new("security")
            .arg("find-generic-password")
            .arg("-w")
            .arg("-s")
            .arg("gemini")
            .arg("-a")
            .arg("antigravity")
            .output()
            .map_err(|e| format!("Failed to read Antigravity token from macOS Keychain: {e}"))?;
        if !output.status.success() {
            let detail = output_tail(&output.stderr);
            let suffix = if detail.is_empty() {
                String::new()
            } else {
                format!("\n\n{detail}")
            };
            return Err(format!(
                "Antigravity login was not found in macOS Keychain at service `gemini`, account `antigravity`. Run `agy` in Terminal and sign in, then try again.{suffix}"
            ));
        }
        let raw = String::from_utf8_lossy(&output.stdout);
        parse_antigravity_keychain_token(&raw)
    }
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day as i32 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    i64::from(era * 146097 + doe - 719468)
}

fn parse_antigravity_expiry_unix_seconds(value: &str) -> Option<i64> {
    let value = value.trim();
    let split = value.find('T').or_else(|| value.find(' '))?;
    let (date, time_and_offset) = value.split_at(split);
    let time_and_offset = time_and_offset.get(1..)?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i32>().ok()?;
    let month = date_parts.next()?.parse::<u32>().ok()?;
    let day = date_parts.next()?.parse::<u32>().ok()?;
    let (time, offset_seconds) = if let Some(time) = time_and_offset.strip_suffix('Z') {
        (time, 0_i64)
    } else {
        let offset_index = time_and_offset
            .char_indices()
            .skip(1)
            .find_map(|(index, ch)| (ch == '+' || ch == '-').then_some(index))?;
        let (time, offset) = time_and_offset.split_at(offset_index);
        let sign = if offset.starts_with('-') {
            -1_i64
        } else {
            1_i64
        };
        let offset = offset.get(1..)?;
        let mut offset_parts = offset.split(':');
        let hours = offset_parts.next()?.parse::<i64>().ok()?;
        let minutes = offset_parts.next().unwrap_or("0").parse::<i64>().ok()?;
        (time, sign * (hours * 3600 + minutes * 60))
    };
    let time = time.split('.').next().unwrap_or(time);
    let mut time_parts = time.split(':');
    let hour = time_parts.next()?.parse::<i64>().ok()?;
    let minute = time_parts.next()?.parse::<i64>().ok()?;
    let second = time_parts.next()?.parse::<i64>().ok()?;
    let local_seconds =
        days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second;
    Some(local_seconds - offset_seconds)
}

fn antigravity_token_needs_refresh(
    token: Option<&AntigravityAuthToken>,
    now_unix_seconds: i64,
    margin_seconds: i64,
) -> bool {
    let Some(token) = token else {
        return true;
    };
    if token.access_token.trim().is_empty() {
        return true;
    }
    let Some(expiry) = token.expiry.as_deref() else {
        return true;
    };
    parse_antigravity_expiry_unix_seconds(expiry)
        .map(|expiry_seconds| expiry_seconds <= now_unix_seconds + margin_seconds)
        .unwrap_or(true)
}

fn antigravity_image_request_prompt(prompt: &str, image_paths: &[PathBuf]) -> String {
    let labels = image_paths
        .iter()
        .enumerate()
        .map(|(index, path)| {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("image.png");
            format!("{}. `{name}`", index + 1)
        })
        .collect::<Vec<_>>();
    let image_note = if labels.is_empty() {
        String::new()
    } else {
        format!(
            "\n\nAttached images are provided in this order:\n{}\nUse those labels to interpret the task, but return only the final image pixels.",
            labels.join("\n")
        )
    };
    format!(
        "You are PaintNode's direct Antigravity image executor. Generate exactly one raster image for the task below. Do not answer with prose, code, file names, or process notes; return image pixels only.{image_note}\n\nTask:\n{prompt}"
    )
}

fn antigravity_inline_image_part(path: &Path) -> Result<serde_json::Value, String> {
    let bytes = fs::read(path).map_err(|e| {
        format!(
            "Failed to read Antigravity image input at {}: {e}",
            path.display()
        )
    })?;
    if !is_png(&bytes) {
        return Err(format!(
            "Antigravity image input at {} is not a PNG.",
            path.display()
        ));
    }
    Ok(json!({
        "inlineData": {
            "mimeType": "image/png",
            "data": BASE64_STANDARD.encode(bytes),
        }
    }))
}

fn apply_antigravity_advanced_image_options(
    image_config: &mut serde_json::Map<String, serde_json::Value>,
    advanced_json: Option<&str>,
) -> Result<(), String> {
    let Some(advanced_json) = advanced_json
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    let value: serde_json::Value = serde_json::from_str(advanced_json)
        .map_err(|e| format!("Antigravity advanced image options must be valid JSON: {e}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "Antigravity advanced image options must be a JSON object.".to_string())?;
    for (key, value) in object {
        match key.as_str() {
            "aspectRatio" | "imageSize" | "personGeneration" | "prominentPeople" => {
                if !value.is_string() {
                    return Err(format!(
                        "Antigravity advanced option `{key}` must be a string."
                    ));
                }
                image_config.insert(key.clone(), value.clone());
            }
            "compressionQuality" => {
                let quality = value.as_u64().ok_or_else(|| {
                    "Antigravity advanced option `compressionQuality` must be a number.".to_string()
                })?;
                if quality > 100 {
                    return Err(
                        "Antigravity advanced option `compressionQuality` must be between 0 and 100."
                            .into(),
                    );
                }
                let output_options = image_config
                    .entry("imageOutputOptions")
                    .or_insert_with(|| json!({}));
                let object = output_options.as_object_mut().ok_or_else(|| {
                    "Antigravity advanced option `imageOutputOptions` must be an object."
                        .to_string()
                })?;
                object.insert("compressionQuality".into(), json!(quality));
            }
            "imageOutputOptions" => {
                let options = value.as_object().ok_or_else(|| {
                    "Antigravity advanced option `imageOutputOptions` must be an object."
                        .to_string()
                })?;
                for (option_key, option_value) in options {
                    match option_key.as_str() {
                        "compressionQuality" => {
                            let quality = option_value.as_u64().ok_or_else(|| {
                                "Antigravity advanced option `imageOutputOptions.compressionQuality` must be a number.".to_string()
                            })?;
                            if quality > 100 {
                                return Err("Antigravity advanced option `imageOutputOptions.compressionQuality` must be between 0 and 100.".into());
                            }
                        }
                        "mimeType" => {
                            if option_value.as_str() != Some("IMAGE_JPEG") {
                                return Err("Antigravity advanced option `imageOutputOptions.mimeType` currently only supports confirmed value `IMAGE_JPEG`.".into());
                            }
                        }
                        _ => {
                            return Err(format!(
                                "Antigravity advanced image option `imageOutputOptions.{option_key}` is not supported."
                            ));
                        }
                    }
                }
                let output_options = image_config
                    .entry("imageOutputOptions")
                    .or_insert_with(|| json!({}));
                let object = output_options.as_object_mut().ok_or_else(|| {
                    "Antigravity advanced option `imageOutputOptions` must be an object."
                        .to_string()
                })?;
                for (option_key, option_value) in options {
                    object.insert(option_key.clone(), option_value.clone());
                }
            }
            _ => {
                return Err(format!(
                    "Antigravity advanced image option `{key}` is not supported."
                ));
            }
        }
    }
    Ok(())
}

fn antigravity_safety_threshold_for_category<'a>(
    options: &'a AntigravityCommandOptions,
    category_key: &str,
) -> Option<&'a str> {
    match category_key {
        "harassment" => options.safety_harassment.as_deref(),
        "hateSpeech" => options.safety_hate_speech.as_deref(),
        "sexuallyExplicit" => options.safety_sexually_explicit.as_deref(),
        "dangerousContent" => options.safety_dangerous_content.as_deref(),
        _ => None,
    }
}

fn antigravity_safety_settings_json(options: &AntigravityCommandOptions) -> Vec<serde_json::Value> {
    let preset_threshold = match options.safety_filtering.as_deref() {
        Some("lessRestrictive") => Some("BLOCK_ONLY_HIGH"),
        Some("moreRestrictive") => Some("BLOCK_LOW_AND_ABOVE"),
        Some("custom") | None => None,
        _ => None,
    };

    ANTIGRAVITY_SAFETY_CATEGORIES
        .iter()
        .filter_map(|(category, category_key)| {
            let threshold = preset_threshold
                .or_else(|| {
                    if options.safety_filtering.as_deref() == Some("custom") {
                        antigravity_safety_threshold_for_category(options, category_key)
                    } else {
                        None
                    }
                })
                .map(str::trim)
                .filter(|value| {
                    !value.is_empty() && *value != ANTIGRAVITY_SAFETY_DEFAULT_THRESHOLD
                })?;

            Some(json!({
                "category": category,
                "threshold": threshold,
            }))
        })
        .collect()
}

fn antigravity_image_request_json(
    spec: &AntigravityImageRequestSpec,
    options: &AntigravityCommandOptions,
) -> Result<serde_json::Value, String> {
    let mut parts = vec![json!({
        "text": antigravity_image_request_prompt(&spec.prompt, &spec.image_paths),
    })];
    for path in &spec.image_paths {
        parts.push(antigravity_inline_image_part(path)?);
    }

    let mut image_config = serde_json::Map::new();
    if let Some(aspect_ratio) = spec
        .aspect_ratio
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        image_config.insert("aspectRatio".into(), json!(aspect_ratio));
    }
    let image_size = options
        .image_size
        .as_deref()
        .or(spec.image_size.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "auto");
    if let Some(image_size) = image_size {
        image_config.insert("imageSize".into(), json!(image_size));
    }
    if let Some(person_generation) = options.person_generation.as_deref() {
        image_config.insert("personGeneration".into(), json!(person_generation));
    }
    if let Some(prominent_people) = options.prominent_people.as_deref() {
        image_config.insert("prominentPeople".into(), json!(prominent_people));
    }
    if let Some(quality) = options.compression_quality {
        image_config.insert(
            "imageOutputOptions".into(),
            json!({ "compressionQuality": quality }),
        );
    }
    apply_antigravity_advanced_image_options(&mut image_config, options.advanced_json.as_deref())?;

    let mut generation_config = serde_json::Map::new();
    generation_config.insert("responseModalities".into(), json!(["IMAGE"]));
    if !image_config.is_empty() {
        generation_config.insert(
            "imageConfig".into(),
            serde_json::Value::Object(image_config),
        );
    }

    let mut request = serde_json::Map::new();
    request.insert(
        "contents".into(),
        json!([{
            "role": "user",
            "parts": parts,
        }]),
    );
    request.insert(
        "generationConfig".into(),
        serde_json::Value::Object(generation_config),
    );
    let safety_settings = antigravity_safety_settings_json(options);
    if !safety_settings.is_empty() {
        request.insert(
            "safetySettings".into(),
            serde_json::Value::Array(safety_settings),
        );
    }

    Ok(json!({
        "model": options
            .image_model
            .as_deref()
            .unwrap_or(DEFAULT_ANTIGRAVITY_IMAGE_MODEL),
        "request": serde_json::Value::Object(request),
    }))
}

fn antigravity_image_bytes_to_png(
    bytes: &[u8],
    mime_type: Option<&str>,
) -> Result<Vec<u8>, String> {
    if is_png(bytes) {
        return Ok(bytes.to_vec());
    }
    let image = image::load_from_memory(bytes)
        .map_err(|e| {
            let mime = mime_type.unwrap_or("unknown");
            format!("Antigravity image generation returned unsupported image data ({mime}): {e}")
        })?
        .to_rgba8();
    encode_rgba_png(image, "Antigravity generated image")
}

fn push_unique_diagnostic(diagnostics: &mut Vec<String>, message: impl Into<String>) {
    let message = message.into();
    let message = message.trim();
    if message.is_empty() || diagnostics.iter().any(|item| item == message) {
        return;
    }
    diagnostics.push(message.to_string());
}

fn json_string_field<'a>(
    object: &'a serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| object.get(*key).and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn collect_antigravity_safety_ratings(value: &serde_json::Value, diagnostics: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(object) => {
            if let Some(ratings) = object
                .get("safetyRatings")
                .or_else(|| object.get("safety_ratings"))
                .and_then(|value| value.as_array())
            {
                for rating in ratings {
                    let Some(rating_object) = rating.as_object() else {
                        continue;
                    };
                    let category = json_string_field(rating_object, &["category"])
                        .unwrap_or("unknown category");
                    let probability = json_string_field(rating_object, &["probability"])
                        .or_else(|| json_string_field(rating_object, &["probabilityScore"]))
                        .unwrap_or("unknown probability");
                    let blocked = rating_object
                        .get("blocked")
                        .and_then(|value| value.as_bool())
                        .map(|blocked| format!(", blocked={blocked}"))
                        .unwrap_or_default();
                    push_unique_diagnostic(
                        diagnostics,
                        format!("Safety rating: {category} ({probability}{blocked})"),
                    );
                }
            }
            for child in object.values() {
                collect_antigravity_safety_ratings(child, diagnostics);
            }
        }
        serde_json::Value::Array(items) => {
            for child in items {
                collect_antigravity_safety_ratings(child, diagnostics);
            }
        }
        _ => {}
    }
}

fn collect_antigravity_named_diagnostics(value: &serde_json::Value, diagnostics: &mut Vec<String>) {
    const INTERESTING_KEYS: &[&str] = &[
        "blockReason",
        "blockReasonMessage",
        "blockedReason",
        "blocked",
        "categories",
        "code",
        "description",
        "details",
        "errorDescription",
        "error_description",
        "errorMessage",
        "error_message",
        "filtered",
        "finishMessage",
        "finishReason",
        "message",
        "moderationDetails",
        "moderation_details",
        "reason",
        "refusal",
        "refusalReason",
        "refusal_reason",
        "safetyViolations",
        "safety_violations",
        "status",
        "violations",
    ];
    const SKIP_KEYS: &[&str] = &[
        "data",
        "inlineData",
        "inline_data",
        "thoughtSignature",
        "thought_signature",
        "mimeType",
        "role",
    ];
    match value {
        serde_json::Value::Object(object) => {
            for (key, child) in object {
                if SKIP_KEYS.contains(&key.as_str()) {
                    continue;
                }
                if INTERESTING_KEYS.contains(&key.as_str()) {
                    if let Some(summary) = antigravity_diagnostic_value_summary(child) {
                        push_unique_diagnostic(diagnostics, format!("{key}: {summary}"));
                    }
                }
                collect_antigravity_named_diagnostics(child, diagnostics);
            }
        }
        serde_json::Value::Array(items) => {
            for child in items {
                collect_antigravity_named_diagnostics(child, diagnostics);
            }
        }
        _ => {}
    }
}

fn antigravity_diagnostic_value_summary(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(text) => {
            let text = text.trim();
            (!text.is_empty()).then(|| text.chars().take(500).collect())
        }
        serde_json::Value::Number(number) => Some(number.to_string()),
        serde_json::Value::Bool(flag) => Some(flag.to_string()),
        serde_json::Value::Array(items) => {
            let parts = items
                .iter()
                .take(12)
                .filter_map(antigravity_diagnostic_value_summary)
                .collect::<Vec<_>>();
            (!parts.is_empty()).then(|| parts.join(", "))
        }
        serde_json::Value::Object(object) => {
            let mut compact = serde_json::Map::new();
            for (key, value) in object.iter().take(12) {
                if let Some(summary) = antigravity_diagnostic_value_summary(value) {
                    compact.insert(key.clone(), serde_json::Value::String(summary));
                }
            }
            (!compact.is_empty()).then(|| serde_json::Value::Object(compact).to_string())
        }
        serde_json::Value::Null => None,
    }
}

fn antigravity_response_diagnostics(value: &serde_json::Value) -> Vec<String> {
    let mut diagnostics = Vec::new();
    collect_antigravity_named_diagnostics(value, &mut diagnostics);
    collect_antigravity_safety_ratings(value, &mut diagnostics);
    diagnostics
}

fn sanitized_antigravity_response_excerpt(value: &serde_json::Value) -> String {
    fn sanitize(key: Option<&str>, value: &serde_json::Value) -> serde_json::Value {
        let should_redact = key.is_some_and(|key| {
            matches!(
                key,
                "data"
                    | "b64_json"
                    | "inlineData"
                    | "inline_data"
                    | "thoughtSignature"
                    | "thought_signature"
            )
        });
        if should_redact {
            return serde_json::Value::String("<redacted>".into());
        }
        match value {
            serde_json::Value::String(text) => {
                if text.chars().count() > 500 {
                    serde_json::Value::String(format!(
                        "{}...[truncated]",
                        text.chars().take(500).collect::<String>()
                    ))
                } else {
                    serde_json::Value::String(text.clone())
                }
            }
            serde_json::Value::Array(items) => serde_json::Value::Array(
                items
                    .iter()
                    .take(20)
                    .map(|item| sanitize(None, item))
                    .collect(),
            ),
            serde_json::Value::Object(object) => serde_json::Value::Object(
                object
                    .iter()
                    .map(|(child_key, child)| (child_key.clone(), sanitize(Some(child_key), child)))
                    .collect(),
            ),
            _ => value.clone(),
        }
    }
    let sanitized = sanitize(None, value);
    let text = serde_json::to_string_pretty(&sanitized).unwrap_or_else(|_| sanitized.to_string());
    output_tail(text.as_bytes())
}

fn decode_antigravity_generate_content_response_text(text: &str) -> Result<Vec<u8>, String> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| format!("Antigravity image generation response was invalid JSON: {e}"))?;
    let envelope: AntigravityGenerateContentEnvelope = serde_json::from_value(value.clone())
        .map_err(|e| format!("Antigravity image generation response was invalid JSON: {e}"))?;
    let mut diagnostics = antigravity_response_diagnostics(&value);
    let Some(response) = envelope.response else {
        let trace = envelope
            .trace_id
            .map(|trace_id| format!(" Trace id: {trace_id}."))
            .unwrap_or_default();
        let detail = diagnostics.join("\n");
        if detail.is_empty() {
            return Err(format!(
                "Antigravity image generation returned no response object.{trace}"
            ));
        }
        return Err(format!(
            "Antigravity image generation returned no response object.{trace}\n\n{detail}"
        ));
    };
    for candidate in response.candidates {
        if let Some(finish_message) = candidate
            .finish_message
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            push_unique_diagnostic(&mut diagnostics, finish_message);
        }
        if let Some(finish_reason) = candidate
            .finish_reason
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            push_unique_diagnostic(&mut diagnostics, format!("finishReason={finish_reason}"));
        }
        let Some(content) = candidate.content else {
            continue;
        };
        for part in content.parts {
            if let Some(text) = part
                .text
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                push_unique_diagnostic(&mut diagnostics, text);
            }
            let Some(inline_data) = part.inline_data else {
                continue;
            };
            let bytes = BASE64_STANDARD
                .decode(inline_data.data.trim().as_bytes())
                .map_err(|e| {
                    format!("Antigravity image generation returned invalid base64 image data: {e}")
                })?;
            return antigravity_image_bytes_to_png(&bytes, inline_data.mime_type.as_deref());
        }
    }
    let detail = diagnostics
        .into_iter()
        .filter(|item| !item.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if detail.is_empty() {
        let excerpt = sanitized_antigravity_response_excerpt(&value);
        if excerpt.is_empty() {
            Err("Antigravity image generation returned no image data.".into())
        } else {
            Err(format!(
                "Antigravity image generation returned no image data.\n\nRaw response excerpt:\n{excerpt}"
            ))
        }
    } else {
        Err(format!(
            "Antigravity image generation returned no image data.\n\n{detail}"
        ))
    }
}

fn antigravity_http_error_message(status: reqwest::StatusCode, body: &str) -> String {
    let detail = output_tail(body.as_bytes());
    let mut message = format!("Antigravity image generation failed with HTTP {status}.");
    match status.as_u16() {
        400 => message.push_str(
            " The direct request schema was rejected or the image model refused the request.",
        ),
        401 | 403 => message.push_str(
            " Antigravity authentication was rejected. Run `agy` in Terminal and sign in if this repeats.",
        ),
        503 => message.push_str(" The Antigravity image model is currently at capacity."),
        _ => {}
    }
    if detail.contains("MODEL_CAPACITY_EXHAUSTED") {
        message.push_str(" The response reported MODEL_CAPACITY_EXHAUSTED.");
    }
    if detail.is_empty() {
        message
    } else {
        format!("{message}\n\n{detail}")
    }
}

fn post_antigravity_image_request(
    client: &Client,
    token: &AntigravityAuthToken,
    request_body: &serde_json::Value,
) -> Result<(reqwest::StatusCode, String), String> {
    let bearer = if token
        .token_type
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("bearer"))
    {
        token.access_token.trim().to_string()
    } else {
        token.access_token.trim().to_string()
    };
    let response = client
        .post(antigravity_generate_content_url(
            &antigravity_image_backend_base_url(),
        ))
        .bearer_auth(bearer)
        .json(request_body)
        .send()
        .map_err(|e| {
            format_antigravity_image_request_error(
                "Antigravity image generation request failed",
                &e,
            )
        })?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Antigravity image generation response could not be read: {e}"))?;
    Ok((status, text))
}

fn run_antigravity_direct_image(
    app: &AppHandle,
    run_id: &str,
    antigravity_bin: &str,
    job_path: &Path,
    spec: AntigravityImageRequestSpec,
    options: &AntigravityCommandOptions,
) -> Result<Vec<u8>, String> {
    if ai_run_cancelled(run_id) {
        return Err(AI_RUN_STOPPED_MESSAGE.into());
    }
    if !options.keep_debug_artifacts {
        remove_antigravity_debug_artifacts(job_path);
    }
    emit_codex_progress(app, run_id, "Authenticating Antigravity account");
    wake_antigravity_auth(antigravity_bin, job_path, options.keep_debug_artifacts)?;
    let mut token = load_antigravity_keychain_token()?;
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    if antigravity_token_needs_refresh(Some(&token), now, 120) {
        wake_antigravity_auth(antigravity_bin, job_path, options.keep_debug_artifacts)?;
        token = load_antigravity_keychain_token()?;
    }
    let request_body = antigravity_image_request_json(&spec, options)?;
    if options.keep_debug_artifacts {
        let request_path = job_path.join(PAINTNODE_ANTIGRAVITY_IMAGE_REQUEST_FILE);
        if let Ok(pretty) = serde_json::to_vec_pretty(&request_body) {
            let _ = fs::write(request_path, pretty);
        }
    }
    if ai_run_cancelled(run_id) {
        return Err(AI_RUN_STOPPED_MESSAGE.into());
    }
    let user_agent = antigravity_image_user_agent(antigravity_bin);
    let client = antigravity_image_http_client(&user_agent)?;
    emit_codex_progress(app, run_id, "Calling Antigravity image backend");
    let (mut status, mut text) = post_antigravity_image_request(&client, &token, &request_body)?;
    if status.as_u16() == 401 || status.as_u16() == 403 {
        emit_codex_progress(
            app,
            run_id,
            "Refreshing Antigravity auth after backend rejection",
        );
        wake_antigravity_auth(antigravity_bin, job_path, options.keep_debug_artifacts)?;
        token = load_antigravity_keychain_token()?;
        let retry = post_antigravity_image_request(&client, &token, &request_body)?;
        status = retry.0;
        text = retry.1;
    }
    if options.keep_debug_artifacts {
        let _ = fs::write(
            job_path.join(PAINTNODE_ANTIGRAVITY_IMAGE_RESPONSE_FILE),
            &text,
        );
    }
    if ai_run_cancelled(run_id) {
        return Err(AI_RUN_STOPPED_MESSAGE.into());
    }
    if !status.is_success() {
        return Err(antigravity_http_error_message(status, &text));
    }
    decode_antigravity_generate_content_response_text(&text)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_antigravity_owned_image_edit(
    app: &AppHandle,
    run_id: &str,
    bin: Option<String>,
    job_path: &Path,
    prompt: String,
    image_paths: Vec<PathBuf>,
    working: &AiWorkingCanvas,
    model: Option<String>,
    approval_mode: Option<String>,
    image_model: Option<String>,
    image_size: Option<String>,
    person_generation: Option<String>,
    prominent_people: Option<String>,
    compression_quality: Option<u8>,
    advanced_json: Option<String>,
    safety_filtering: Option<String>,
    safety_harassment: Option<String>,
    safety_hate_speech: Option<String>,
    safety_sexually_explicit: Option<String>,
    safety_dangerous_content: Option<String>,
    keep_debug_artifacts: bool,
) -> Result<Vec<u8>, String> {
    let antigravity_bin = configured_or_default_antigravity_bin(bin)?;
    let mut options = antigravity_command_options_with_image(
        model,
        approval_mode,
        image_model,
        image_size,
        person_generation,
        prominent_people,
        compression_quality,
        advanced_json,
        safety_filtering,
        safety_harassment,
        safety_hate_speech,
        safety_sexually_explicit,
        safety_dangerous_content,
    );
    options.keep_debug_artifacts = keep_debug_artifacts;
    run_antigravity_direct_image(
        app,
        run_id,
        &antigravity_bin,
        job_path,
        antigravity_direct_spec_for_working(prompt, image_paths, working),
        &options,
    )
}

fn antigravity_closest_aspect_label(dimensions: (u32, u32)) -> Option<String> {
    let target_ratio = dimensions.0 as f64 / dimensions.1 as f64;
    ai_antigravity_image_capability()
        .aspect_ratios
        .iter()
        .min_by(|a, b| {
            let a_error = ((a.width as f64 / a.height as f64) / target_ratio)
                .ln()
                .abs();
            let b_error = ((b.width as f64 / b.height as f64) / target_ratio)
                .ln()
                .abs();
            a_error
                .partial_cmp(&b_error)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|ratio| ratio.label.clone())
}

fn antigravity_direct_spec_for_working(
    prompt: String,
    image_paths: Vec<PathBuf>,
    working: &AiWorkingCanvas,
) -> AntigravityImageRequestSpec {
    let image_size = antigravity_output_target(&working.aspect_label, working.original_dimensions)
        .map(|(tier, _)| tier.to_string());
    AntigravityImageRequestSpec {
        prompt,
        image_paths,
        aspect_ratio: Some(working.aspect_label.clone()),
        image_size,
    }
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

fn run_antigravity_with_progress(
    command: &mut Command,
    app: AppHandle,
    run_id: String,
    workspace_path: &Path,
    job_path: &Path,
    required_output: Option<&str>,
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
        satisfied_required_output,
    })
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
        let mut command = Command::new(&candidate);
        apply_ai_cli_environment(&mut command).arg("--version");
        if command.output().is_ok() {
            return Ok(candidate.to_string());
        }
    }

    Err("Antigravity CLI was not found. Install Antigravity CLI, or enter the full path to the `agy` binary.".into())
}

fn antigravity_command_options(
    model: Option<String>,
    approval_mode: Option<String>,
) -> AntigravityCommandOptions {
    antigravity_command_options_with_image(
        model,
        approval_mode,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn antigravity_command_options_with_image(
    model: Option<String>,
    approval_mode: Option<String>,
    image_model: Option<String>,
    image_size: Option<String>,
    person_generation: Option<String>,
    prominent_people: Option<String>,
    compression_quality: Option<u8>,
    advanced_json: Option<String>,
    safety_filtering: Option<String>,
    safety_harassment: Option<String>,
    safety_hate_speech: Option<String>,
    safety_sexually_explicit: Option<String>,
    safety_dangerous_content: Option<String>,
) -> AntigravityCommandOptions {
    let model = clean_option(model).filter(|value| value != "auto");
    let approval_mode = clean_option(approval_mode);
    let image_model = clean_option(image_model).filter(|value| value != "auto");
    let image_size = clean_option(image_size).filter(|value| value != "auto");
    let person_generation = clean_option(person_generation)
        .filter(|value| value != "auto")
        .filter(|value| matches!(value.as_str(), "ALLOW_ALL" | "ALLOW_ADULT" | "ALLOW_NONE"));
    let prominent_people = clean_option(prominent_people)
        .filter(|value| value != "auto")
        .filter(|value| {
            matches!(
                value.as_str(),
                "ALLOW_PROMINENT_PEOPLE" | "BLOCK_PROMINENT_PEOPLE"
            )
        });
    let compression_quality = compression_quality.map(|quality| quality.min(100));
    let advanced_json =
        clean_option(advanced_json).filter(|value| value.trim() != "{}" && value.trim() != "null");
    let safety_filtering = clean_option(safety_filtering)
        .filter(|value| value != "default")
        .filter(|value| {
            matches!(
                value.as_str(),
                "lessRestrictive" | "moreRestrictive" | "custom"
            )
        });
    let clean_safety_threshold = |value: Option<String>| {
        clean_option(value).filter(|value| {
            matches!(
                value.as_str(),
                "OFF"
                    | "BLOCK_NONE"
                    | "BLOCK_ONLY_HIGH"
                    | "BLOCK_MEDIUM_AND_ABOVE"
                    | "BLOCK_LOW_AND_ABOVE"
                    | ANTIGRAVITY_SAFETY_DEFAULT_THRESHOLD
            )
        })
    };
    let safety_harassment = clean_safety_threshold(safety_harassment);
    let safety_hate_speech = clean_safety_threshold(safety_hate_speech);
    let safety_sexually_explicit = clean_safety_threshold(safety_sexually_explicit);
    let safety_dangerous_content = clean_safety_threshold(safety_dangerous_content);
    AntigravityCommandOptions {
        model,
        approval_mode,
        image_model,
        image_size,
        person_generation,
        prominent_people,
        compression_quality,
        advanced_json,
        safety_filtering,
        safety_harassment,
        safety_hate_speech,
        safety_sexually_explicit,
        safety_dangerous_content,
        keep_debug_artifacts: false,
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
    apply_ai_cli_environment(&mut command);
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

#[cfg(test)]
pub(crate) fn antigravity_generate_prompt(
    user_prompt: &str,
    job_dir: &str,
    autonomy: AiAutonomyLevel,
    reference_names: &[String],
) -> String {
    antigravity_generate_director_prompt(
        user_prompt,
        job_dir,
        autonomy,
        AiDirectorProvider::Antigravity,
        AiDirectorMode::Auto,
        AiDirectorInvolvement::FullReview,
        reference_names,
    )
}

pub(crate) fn antigravity_generate_director_prompt(
    user_prompt: &str,
    job_dir: &str,
    autonomy: AiAutonomyLevel,
    director_provider: AiDirectorProvider,
    director_mode: AiDirectorMode,
    director_involvement: AiDirectorInvolvement,
    reference_names: &[String],
) -> String {
    let result_path = antigravity_result_path(job_dir);
    let autonomy_contract = image_agent_autonomy_contract(autonomy, "Antigravity");
    let director_contract = ai_director_workflow_contract(
        director_provider,
        director_mode,
        director_involvement,
        "image generation",
    );
    let agentic_tool_loop = director_provider == AiDirectorProvider::Antigravity
        && director_uses_agentic_loop(director_mode, director_involvement);
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
    let director_tool_contract = if agentic_tool_loop {
        format!(
            r#"PaintNode Director tool loop:
- Do not create image pixels yourself and do not create `result.png`.
- Write `{PAINTNODE_DIRECTOR_ACTION_FILE}` as UTF-8 JSON in the current working directory.
- Choose exactly one Director action: `generateCandidate`, `acceptResult`, or `fail`.
- For the first turn, normally write a `generateCandidate` action that asks PaintNode's owned Antigravity image tool to create the candidate.
- Allowed PaintNode tool action: `generateCandidate`. PaintNode will run the image model, write `{PAINTNODE_DIRECTOR_OBSERVATION_FILE}`, and attach the candidate back to you for review when your participation level requires review.

JSON schema:
{{
  "version": 1,
  "action": "generateCandidate",
  "baseImage": "none",
  "prompt": "image prompt for PaintNode's owned Antigravity image tool",
  "constraints": ["short constraints the image tool must obey"],
  "avoid": ["short negative constraints"],
  "notes": "optional short note for PaintNode"
}}

Director review criteria:
{}"#,
            workflow_review_criteria("image_generation")
        )
    } else {
        String::new()
    };
    let required_output = if agentic_tool_loop {
        format!(
            r#"Required Director action:
- Write `{PAINTNODE_DIRECTOR_ACTION_FILE}` only. PaintNode will call the Antigravity image backend after reading your action.
- Do not save `result.png` yourself.
- Do not ask follow-up questions.
{workspace_rule}

Final response should be one short sentence confirming `{PAINTNODE_DIRECTOR_ACTION_FILE}` was created."#
        )
    } else {
        format!(
            r#"Required output:
- Save the final image as `{result_path}`.
- PNG only.
- Use the largest image size / highest output resolution your image-generation tool supports.
- Do not ask follow-up questions.
{workspace_rule}

Final response should be one short sentence confirming `{result_path}` was created."#
        )
    };
    format!(
        r#"Generate one raster PNG for PaintNode.

User image prompt:
{user_prompt}

{reference_note}

{director_contract}

{director_tool_contract}

{autonomy_contract}

{required_output}"#
    )
}

fn antigravity_overview_note(job_dir: &str, has_overview: bool) -> String {
    if has_overview {
        format!("\n- `{job_dir}/overview.png`: downscaled preview of the surrounding document content with the editable region outlined in red. Use it only as non-editable composition and continuity guidance. `{job_dir}/source.png` is the only base/edit image; never use `overview.png` as the source or base image, never copy its pixels or resolution, and never reproduce the red outline.")
    } else {
        String::new()
    }
}

fn antigravity_storyboard_draft_note(_job_dir: &str, _has_storyboard_draft: bool) -> String {
    String::new()
}

#[cfg(test)]
fn antigravity_fill_prompt(
    prompt: &str,
    job_dir: &str,
    autonomy: AiAutonomyLevel,
    geometry_note: &str,
    storyboard_note: &str,
    storyboard_anchor: bool,
    storyboard_fallback: bool,
    has_overview: bool,
    has_storyboard_draft: bool,
    continuation: bool,
    reference_names: &[String],
    working: &AiWorkingCanvas,
) -> String {
    antigravity_fill_director_prompt(
        prompt,
        job_dir,
        autonomy,
        AiDirectorProvider::Antigravity,
        AiDirectorMode::Auto,
        AiDirectorInvolvement::FullReview,
        geometry_note,
        storyboard_note,
        storyboard_anchor,
        storyboard_fallback,
        has_overview,
        has_storyboard_draft,
        continuation,
        reference_names,
        working,
    )
}

fn antigravity_fill_director_prompt(
    prompt: &str,
    job_dir: &str,
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
    continuation: bool,
    reference_names: &[String],
    working: &AiWorkingCanvas,
) -> String {
    let result_path = antigravity_result_path(job_dir);
    let autonomy_contract = image_agent_autonomy_contract(autonomy, "Antigravity");
    let director_contract = ai_director_workflow_contract(
        director_provider,
        director_mode,
        director_involvement,
        "generative fill",
    );
    let has_storyboard = !storyboard_note.trim().is_empty();
    let tool_call_note = antigravity_fill_image_tool_call_note(
        job_dir,
        working,
        has_overview,
        continuation,
        has_storyboard,
        storyboard_anchor,
        has_storyboard_draft,
    );
    let overview_note = antigravity_overview_note(job_dir, has_overview);
    let storyboard_draft_note = antigravity_storyboard_draft_note(job_dir, has_storyboard_draft);
    let workspace_rule = format!(
        "- Use only the attached images and task text from `{job_dir}`; PaintNode will import the returned image."
    );
    let reference_prefix = if job_dir == "." {
        String::new()
    } else {
        format!("{job_dir}/")
    };
    let reference_note = reference_prompt_note(reference_names, &reference_prefix);
    if has_storyboard_draft {
        return format!(
            r#"Perform one PaintNode draft enhancement using the PNG files in `{job_dir}`.

Input files:
- `{job_dir}/source.png`: PaintNode edit frame to enhance. It already contains the orchestrator's rough low-detail visual draft.{overview_note}

{geometry_note}

{director_contract}

Task:
- This is an image enhancement/restoration pass at the same size, not a new composition, new generative fill, outpaint, story continuation, or scene redesign.
- Improve clarity, texture, natural detail, edge quality, lighting consistency, and local realism only for pixels already visible in the low-detail draft.
- Preserve the exact subject count, object count, identities/classes, poses, placement, scale, camera angle, horizon, shoreline, lighting, colors, and activities already visible in `source.png`.
- Do not add, remove, duplicate, replace, move, resize, re-pose, or reinterpret any visible person, object, prop, landform, wave, cloud, or scene element.
- If a draft area is soft or ambiguous, refine the existing visible shapes conservatively instead of inventing extra content.

{autonomy_contract}

{tool_call_note}

Required output:
- Save exactly one PNG file as `{result_path}`.
- Keep the attached frame registered: no crop, zoom, reframe, or shift.
- PaintNode will crop, paste, and apply the editable mask after import. Do not draw mask edges, gray buffers, borders, or guides into the pixels.
{workspace_rule}
- Do not ask follow-up questions.

Final response should be one short sentence confirming `{result_path}` was created."#
        );
    }
    if has_storyboard {
        let source_input_note = if has_storyboard_draft {
            "current PaintNode content for this edit frame. In unpainted editable areas, it already contains the orchestrator's rough visual draft."
        } else {
            "current PaintNode content for this edit frame."
        };
        let draft_output_note = if has_storyboard_draft {
            "- Retouch/up-res the low-detail draft already present in `source.png`; do not ignore it, replace it with a new composition, or start from blank.\n- The visible draft is the composition authority. Preserve its subject count, placement, pose, activity, horizon, shoreline, lighting, camera, and scale, and add no new people, props, activities, story beats, or separate scenes beyond what is already visible in the draft."
        } else {
            "- Use the orchestrator subtask prompt as the local instruction for this frame."
        };
        let fallback_prompt = if storyboard_fallback && storyboard_anchor {
            format!(
                "\nFallback anchor user prompt:\n{prompt}\n\nUse this only because the orchestrator plan fell back; the orchestrator subtask prompt remains the main local instruction."
            )
        } else {
            String::new()
        };
        return format!(
            r#"Perform one PaintNode generative fill using the PNG files in `{job_dir}`.

Input files:
- `{job_dir}/source.png`: {source_input_note}
{overview_note}{storyboard_draft_note}

{reference_note}

{geometry_note}

{director_contract}

{storyboard_note}{fallback_prompt}

{autonomy_contract}

{tool_call_note}

Required output:
- Save exactly one PNG file as `{result_path}`.
- Keep the attached frame registered: no crop, zoom, reframe, or shift.
{draft_output_note}
- PaintNode will crop, paste, and apply the editable mask after import. Do not draw mask edges, gray buffers, borders, or guides into the pixels.
{workspace_rule}
- Do not ask follow-up questions.

Final response should be one short sentence confirming `{result_path}` was created."#
        );
    }
    let user_prompt_heading = "Original user fill prompt:";
    format!(
        r#"Perform one PaintNode generative fill using the PNG files in `{job_dir}`.

Input files:
- `{job_dir}/source.png`: the current content of the document area being edited.
{overview_note}

{reference_note}

{geometry_note}

{director_contract}

{storyboard_note}

{user_prompt_heading}
{prompt}

{autonomy_contract}

{tool_call_note}

Required output:
- Save exactly one PNG file as `{result_path}`.
- Prefer the same framing as `source.png`.
- Fill the intended editable/empty area implied by the attached frame and prompt.
- Match surrounding texture, lighting, perspective, color, focus, and grain.
- Do not crop, zoom, reframe, or shift the attached frame.
- PaintNode will crop, paste, and apply the editable mask after import. Do not draw mask edges, gray buffers, borders, or guides into the pixels.
{workspace_rule}
- Do not ask follow-up questions.

Final response should be one short sentence confirming `{result_path}` was created."#
    )
}

#[cfg(test)]
fn antigravity_retouch_prompt(
    prompt: &str,
    has_annotated_source: bool,
    has_reference: bool,
    reference_names: &[String],
    job_dir: &str,
    autonomy: AiAutonomyLevel,
    geometry_note: &str,
    has_overview: bool,
    continuation: bool,
    working: &AiWorkingCanvas,
) -> String {
    antigravity_retouch_director_prompt(
        prompt,
        has_annotated_source,
        has_reference,
        reference_names,
        job_dir,
        autonomy,
        AiDirectorProvider::Antigravity,
        AiDirectorMode::Auto,
        AiDirectorInvolvement::FullReview,
        geometry_note,
        has_overview,
        continuation,
        working,
    )
}

fn antigravity_retouch_director_prompt(
    prompt: &str,
    has_annotated_source: bool,
    has_reference: bool,
    reference_names: &[String],
    job_dir: &str,
    autonomy: AiAutonomyLevel,
    director_provider: AiDirectorProvider,
    director_mode: AiDirectorMode,
    director_involvement: AiDirectorInvolvement,
    geometry_note: &str,
    has_overview: bool,
    continuation: bool,
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
    let director_contract = ai_director_workflow_contract(
        director_provider,
        director_mode,
        director_involvement,
        "AI retouch",
    );
    let tool_call_note =
        antigravity_image_tool_call_note(job_dir, working, continuation, false, false, false);
    let overview_note = antigravity_overview_note(job_dir, has_overview);
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
- `{job_dir}/source.png`: the original source image for this edit.
- `{job_dir}/edit_target.png`: same-size photo/canvas image to edit in place.
- `{job_dir}/mask.png`: same-size edit mask. White pixels are editable. Gray pixels are a feathered transition buffer. Black or transparent pixels are protected context and are not editable.{overview_note}
{contract_note}
{annotation_note}
{reference_note}
{extra_reference_note}

{geometry_note}

{director_contract}

User retouch prompt:
{prompt}

{autonomy_contract}

{tool_call_note}

Required output:
- Save exactly one PNG file as `{result_path}`.
- Prefer the same pixel dimensions as `source.png` and `edit_target.png`.
- Treat the edit as an in-place retouch of the attached frame; do not crop, zoom, reframe, or shift it.
- Treat `mask.png` as the maximum allowed edit area, not as an instruction to repaint every white pixel. Change only the content explicitly requested by the user prompt and preserve unrequested masked content.
- Keep every newly generated, removed, replaced, reconstructed, relit, recolored, cleaned, extended, blended, shadowed, reflected, or otherwise changed visible pixel inside the white/gray mask footprint.
- Any edit whose visible change extends outside the mask is a failed retouch, even though the app masks the imported layer afterward. Scale, simplify, or localize the requested change so the complete visible edit fits inside the mask footprint.
- If the prompt changes clothing or accessories, preserve the person's identity, face, hair, skin, hands, pose, body proportions, expression, gaze, and all unrequested surrounding content unless the user explicitly asks to alter those details.
- Blend naturally through any gray feather buffer. PaintNode attaches the mask as a separate user-editable layer mask — it is never baked into your pixels — so your candidate itself must preserve protected and unrequested areas.
- Keep every black/transparent-mask protected area visually identical to `source.png`: no enhancement, denoise, sharpening, relight, recolor, cleanup, straightening, or reframing outside the mask.
- Use surrounding texture, lighting, perspective, grain, focus, and edges to blend the retouched area naturally.
- Do not include UI chrome, checkerboard transparency, selection outlines, masks, annotations, labels, or guide marks in `result.png`.
{workspace_rule}
- Do not ask follow-up questions.

Final response should be one short sentence confirming `{result_path}` was created."#
    )
}

/// How the agent should drive its image-generation tool for masked in-place
/// edits: one base image plus a short instruction. Attaching the mask or
/// extra frames pushes the image model from "edit this image" into "generate
/// a new image from references", which loses the original framing entirely.
/// The attached crop matches the model's real output grid for the working
/// canvas's aspect label, so the note also pins the exact tool parameters.
/// Continuation parts of a split run are the exception to "no extra frames":
/// their crop is mostly new pixels with little visible context, so the
/// overview goes to the image model as a scene-continuity reference.
fn antigravity_image_tool_call_note(
    job_dir: &str,
    working: &AiWorkingCanvas,
    continuation: bool,
    has_storyboard: bool,
    storyboard_anchor: bool,
    has_storyboard_draft: bool,
) -> String {
    let aspect_label = &working.aspect_label;
    let target = antigravity_output_target(aspect_label, working.original_dimensions);
    let target_note = match target {
        Some((tier, _)) => format!(
            "\n- Set the image tool's aspect ratio parameter to `{aspect_label}` and its image size / resolution parameter to `{tier}`. That tier's output grid matches the attached frame's ratio exactly, so a faithful in-place edit maps 1:1 onto the frame with no cropping or reframing."
        ),
        None => String::new(),
    };
    let overview_attach_note = if continuation && has_storyboard_draft {
        format!(
            "\n- Also attach `{job_dir}/overview.png` as the third image and explain in the tool instruction that it shows the surrounding finished pixels and whole rough draft for alignment only; its pixels, its resolution, and the red outline must never appear in the output."
        )
    } else if continuation {
        format!(
            "\n- Also attach `{job_dir}/overview.png` as the third image and explain in the tool instruction that it shows the surrounding artwork the output must continue seamlessly; its pixels, its resolution, and the red outline must never appear in the output."
        )
    } else {
        String::new()
    };
    let storyboard_draft_attach_note = if has_storyboard_draft {
        "\n- Do not attach storyboard draft files as extra image references. The base image already contains the orchestrator's rough composition; the image tool should enhance that base in place."
            .to_string()
    } else {
        String::new()
    };
    let instruction_subject = if has_storyboard_draft {
        "state that this is masked image enhancement/restoration of the low-detail draft already in the base image; improve detail only, preserve the exact composition, and add/remove/move/replace no visible subject, object, prop, activity, or scene element"
    } else if has_storyboard && storyboard_anchor {
        "use the orchestrator subtask prompt above as the local image instruction; include the requested anchor subject only if that subtask prompt says to"
    } else if has_storyboard {
        "use the orchestrator subtask prompt above as the local image instruction; continue the protected neighboring content exactly as that subtask prompt describes"
    } else if continuation {
        "state how the editable area continues the neighboring finished content (per the continuation rules above)"
    } else {
        "state the requested change"
    };
    format!(
        r#"Image-generation tool call:
- Give the image-generation tool `{job_dir}/edit_target.png` as the base image (the first image) and apply the edit to that image directly.
- Also attach `{job_dir}/mask.png` as the second image so the model sees exactly which area is editable. In the tool instruction, explain that the second image is an edit mask over the first: the white area marks the only region to change, black areas must be reproduced pixel-identically from the first image, and the mask itself must never appear in the output.{overview_attach_note}{storyboard_draft_attach_note}
- Never attach `{job_dir}/paintnode_contract.txt` to the image tool; attach other files only when they are reference images explicitly listed above and the edit needs them.{target_note}
- Keep the tool instruction short: {instruction_subject} and the mask rule, then require that everything else stays exactly the same — same framing, same composition, same camera, same crop.
- Do not mention file names, pixel dimensions, or aspect ratios inside the tool instruction text; the ratio and size belong in the tool's parameters only."#
    )
}

fn antigravity_fill_image_tool_call_note(
    job_dir: &str,
    working: &AiWorkingCanvas,
    has_overview: bool,
    continuation: bool,
    has_storyboard: bool,
    storyboard_anchor: bool,
    has_storyboard_draft: bool,
) -> String {
    let aspect_label = &working.aspect_label;
    let target = antigravity_output_target(aspect_label, working.original_dimensions);
    let target_note = match target {
        Some((tier, _)) => format!(
            "\n- Set the image tool's aspect ratio parameter to `{aspect_label}` and its image size / resolution parameter to `{tier}`. That tier's output grid matches the attached frame's ratio exactly, so a faithful generation maps 1:1 onto the frame with no cropping or reframing."
        ),
        None => String::new(),
    };
    let overview_attach_note = if continuation && has_storyboard_draft {
        format!(
            "\n- Also attach `{job_dir}/overview.png` as an additional alignment reference only; it shows surrounding finished pixels and the rough draft. Its pixels, resolution, and red outline must never appear in the output."
        )
    } else if continuation {
        format!(
            "\n- Also attach `{job_dir}/overview.png` as an additional continuity reference only. Its pixels, resolution, and red outline must never appear in the output."
        )
    } else if has_overview && has_storyboard_draft {
        format!(
            "\n- Also attach `{job_dir}/overview.png` as an additional composition reference only; it shows surrounding document content and the rough draft. Its pixels, resolution, and red outline must never appear in the output."
        )
    } else if has_overview {
        format!(
            "\n- Also attach `{job_dir}/overview.png` as an additional composition and continuity reference only. Its pixels, resolution, and red outline must never appear in the output."
        )
    } else {
        String::new()
    };
    let storyboard_draft_attach_note = if has_storyboard_draft {
        "\n- Do not attach storyboard draft files as extra image references. The base image already contains the orchestrator's rough composition; the image tool should enhance that base in place."
            .to_string()
    } else {
        String::new()
    };
    let instruction_subject = if has_storyboard_draft {
        "state that this is image enhancement/restoration of the low-detail draft already in the base image; improve detail only, preserve the exact composition, and add/remove/move/replace no visible subject, object, prop, activity, or scene element"
    } else if has_storyboard && storyboard_anchor {
        "use the orchestrator subtask prompt above as the local image instruction; include the requested anchor subject only if that subtask prompt says to"
    } else if has_storyboard {
        "use the orchestrator subtask prompt above as the local image instruction; continue the protected neighboring content exactly as that subtask prompt describes"
    } else if continuation {
        "state how the generated area continues the neighboring finished content (per the continuation rules above)"
    } else {
        "state the requested fill"
    };
    format!(
        r#"Image-generation tool call:
- Give the image-generation tool `{job_dir}/source.png` as the base image (the first image) and generate directly against that frame.
- Do not attach synthetic edit-target or mask images. PaintNode owns crop-back, paste-back, and editable masking from `placement.json` after the generated PNG is returned.{overview_attach_note}{storyboard_draft_attach_note}
- Never attach `{job_dir}/paintnode_contract.txt` to the image tool; attach other files only when they are reference images explicitly listed above and the edit needs them.{target_note}
- Keep the tool instruction short: {instruction_subject}, then require that the result keeps the same framing, same composition, same camera, and same crop.
- Do not mention file names, pixel dimensions, or aspect ratios inside the tool instruction text; the ratio and size belong in the tool's parameters only."#
    )
}

/// Appended to the prompt when a candidate fails the protected-region drift
/// gate: the model regenerated the scene instead of editing in place.
const AI_IN_PLACE_RETRY_NOTE: &str = r#"IMPORTANT — previous candidate rejected:
- The previous candidate repainted pixels outside the editable mask, which means the scene was regenerated instead of edited in place. PaintNode discarded it.
- This is a strict in-place edit of `edit_target.png`: apply the requested change only inside the white mask area and reproduce every pixel outside the mask exactly as it appears in `edit_target.png`.
- Call the image-generation tool with `edit_target.png` as the base image and `mask.png` attached as the second image (the edit mask marking the only editable area), with a short instruction.
- If the requested change cannot be honored inside the mask, make the closest faithful change the image tool allows rather than re-imagining the scene."#;

fn antigravity_retouch_contract_text(
    job_dir: &str,
    autonomy: AiAutonomyLevel,
    geometry_note: &str,
) -> String {
    let result_path = antigravity_result_path(job_dir);
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

{geometry_note}

Antigravity should do:
- Use the image-generation capability to create one visual retouch candidate.
- Save or copy that generated PNG to `{result_path}`.
- Preserve the attached frame's geometry and masked-region intent as much as the image-generation tool allows.

PaintNode will do after `{result_path}` exists:
- Validate that the file is a PNG.
- Resize a same-aspect result back to the exact submitted crop dimensions if needed.
- Paste the result into the document region recorded in `placement.json`.
- Import the pasted result as a new layer with the editable mask attached as a separate linked mask layer. The mask is never baked into your result pixels, so the user can still edit the mask afterwards.
- Store the generated asset in the project.
{method_limits}
"#
    )
}

fn antigravity_decouple_director_prompt(
    prompt: &str,
    job_dir: &str,
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
    format!(
        r#"Extract reusable visual assets from `{job_dir}/source.png` for PaintNode.

User guidance:
{prompt}

{director_contract}

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

#[tauri::command]
pub(crate) async fn detect_antigravity(
    bin: Option<String>,
) -> Result<CodexDetectionResult, String> {
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

        let job_path =
            std::env::temp_dir().join(format!("paintnode-antigravity-detect-{}", now_id()));
        let result = wake_antigravity_auth(&antigravity_bin, &job_path, false);
        let _ = fs::remove_dir_all(&job_path);

        match result {
            Ok(()) => CodexDetectionResult {
                found: true,
                path: Some(antigravity_bin.clone()),
                version: Some(format!(
                    "Antigravity {}",
                    antigravity_cli_version(&antigravity_bin)
                )),
                error: None,
            },
            Err(error) => CodexDetectionResult {
                found: false,
                path: Some(antigravity_bin),
                version: None,
                error: Some(error),
            },
        }
    })
    .await
    .map_err(|e| format!("Task error: {e}"))
}

fn run_antigravity(
    antigravity_bin: &str,
    workspace_path: &Path,
    job_path: &Path,
    prompt: &str,
    options: &AntigravityCommandOptions,
    new_project: bool,
    app: AppHandle,
    run_id: String,
    required_output: Option<&str>,
) -> Result<AgentRunResult, String> {
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
        app,
        run_id,
        workspace_path,
        job_path,
        required_output,
    )
    .map_err(|e| format!("Failed to run Antigravity at '{antigravity_bin}': {e}"))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run_antigravity_director_request(
    app: &AppHandle,
    run_id: &str,
    bin: Option<String>,
    model: Option<String>,
    approval_mode: Option<String>,
    keep_debug_artifacts: bool,
    workspace_path: &Path,
    job_path: &Path,
    prompt: &str,
    new_project: bool,
    required_output: &str,
) -> Result<AgentRunResult, String> {
    let antigravity_bin = configured_or_default_antigravity_bin(bin)?;
    let mut options = antigravity_command_options(model, approval_mode);
    options.keep_debug_artifacts = keep_debug_artifacts;
    run_antigravity(
        &antigravity_bin,
        workspace_path,
        job_path,
        prompt,
        &options,
        new_project,
        app.clone(),
        run_id.to_string(),
        Some(required_output),
    )
}

fn write_antigravity_storyboard_draft_guides(
    job_path: &Path,
    placement: &AiEditPlacement,
    overview_png: &[u8],
) -> Result<(), String> {
    let aspect_label = fill_storyboard_antigravity_draft_aspect_label(placement);
    let Some((_tier, provider_dimensions)) = antigravity_output_target(aspect_label, (1, 1)) else {
        return Ok(());
    };
    let draft_canvas = storyboard_draft_canvas_png(
        overview_png,
        provider_dimensions,
        placement.document_dimensions,
        "Antigravity fill storyboard draft canvas",
    )?;
    fs::write(
        job_path.join(FILL_STORYBOARD_DRAFT_CANVAS_FILE),
        draft_canvas,
    )
    .map_err(|e| format!("Failed to write generative fill storyboard draft canvas: {e}"))?;
    let draft_mask = storyboard_draft_mask_png(
        provider_dimensions,
        placement.document_dimensions,
        "Antigravity fill storyboard draft mask",
    )?;
    fs::write(job_path.join(FILL_STORYBOARD_DRAFT_MASK_FILE), draft_mask)
        .map_err(|e| format!("Failed to write generative fill storyboard draft mask: {e}"))
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
        "Antigravity fill storyboard draft",
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

#[allow(clippy::too_many_arguments)]
fn prepare_antigravity_fill_storyboard(
    app: &AppHandle,
    run_id: &str,
    _antigravity_bin: &str,
    _workspace_path: &Path,
    job_path: &Path,
    placement: &crate::ai::placement::AiEditPlacement,
    composer: &AiEditComposer,
    _prompt: &str,
    _reference_pngs: &[WorkflowSourceImage],
    _options: &AntigravityCommandOptions,
) -> Result<Option<FillStoryboard>, String> {
    if !should_storyboard_fill(placement) {
        return Ok(None);
    }
    if let Ok(storyboard) = read_fill_storyboard_file(job_path, placement.parts.len()) {
        normalize_storyboard_draft_result(job_path, placement)?;
        return Ok(Some(storyboard));
    }

    let storyboard_overview =
        composer.storyboard_overview_png("Generative fill storyboard overview")?;
    fs::write(
        job_path.join(FILL_STORYBOARD_OVERVIEW_FILE),
        &storyboard_overview,
    )
    .map_err(|e| format!("Failed to write generative fill storyboard overview: {e}"))?;
    write_antigravity_storyboard_draft_guides(job_path, placement, &storyboard_overview)?;
    emit_codex_progress(
        app,
        run_id,
        "Using PaintNode deterministic storyboard for split Antigravity fill",
    );
    let fallback = fallback_fill_storyboard(placement);
    write_fill_storyboard_file(job_path, &fallback)?;
    Ok(Some(fallback))
}

#[cfg(test)]
fn antigravity_restore_prompt(
    job_dir: &str,
    autonomy: AiAutonomyLevel,
    director_mode: AiDirectorMode,
    director_involvement: AiDirectorInvolvement,
    geometry_note: &str,
    has_overview: bool,
) -> String {
    antigravity_restore_director_prompt(
        job_dir,
        autonomy,
        AiDirectorProvider::Antigravity,
        director_mode,
        director_involvement,
        geometry_note,
        has_overview,
    )
}

fn antigravity_restore_director_prompt(
    job_dir: &str,
    autonomy: AiAutonomyLevel,
    director_provider: AiDirectorProvider,
    director_mode: AiDirectorMode,
    director_involvement: AiDirectorInvolvement,
    geometry_note: &str,
    has_overview: bool,
) -> String {
    let autonomy_contract = image_agent_autonomy_contract(autonomy, "Antigravity");
    let director_contract =
        ai_director_restore_contract(director_provider, director_mode, director_involvement);
    let overview_note = antigravity_overview_note(job_dir, has_overview);
    let workspace_rule = if autonomy == AiAutonomyLevel::Unmanaged {
        "- Save the final image at the required path so PaintNode can import it.".into()
    } else {
        format!("- Work only inside `{job_dir}`.")
    };
    format!(
        r#"Perform one PaintNode detail restoration using the PNG files in `{job_dir}`.

This is a fixed-canvas image refinement task, not a new image generation task.

Input files:
- `{job_dir}/source.png`: the image region to restore. It was enlarged from a lower-resolution image, so it is soft and lacks fine detail.
- `{job_dir}/mask.png`: editable-area mask. White pixels are editable. Gray pixels are a feathered hand-off band into already-restored content; PaintNode cross-fades your result there, so render that band seamlessly consistent with the neighboring restored pixels. Black or transparent pixels were already restored and must remain unchanged.{overview_note}

{geometry_note}
{director_contract}

Restoration goal:
- Re-render this exact image with crisp, natural, high-frequency detail: sharp edges and realistic texture for skin, hair, fabric, foliage, and surfaces.
- Preserve the composition, framing, camera geometry, subjects, identities, poses, expressions, colors, lighting, and style exactly.
- Match the color balance, tone, brightness, contrast, grain, and detail level of the already-restored areas exactly, so the result joins them without visible seams.
- Preserve intentional medium character such as film grain, scan texture, halation, bloom, lens softness, motion softness, slight overexposure, underexposure, or vintage color cast. Do not treat those traits as defects unless the user explicitly asked for cleanup, denoise, or restoration beyond upscale/detail recovery.
- Do not add, remove, move, restyle, or reinterpret any content.
- Do not change global brightness, contrast, or color balance.
- If a detail is too blurred to identify, render a plausible neutral texture instead of inventing new objects, readable text, faces, or logos.
- Do not translate, shift, crop, zoom, rotate, scale, stretch, warp, resize, reframe, straighten, or change the camera perspective.

{autonomy_contract}

Required output:
- Return exactly one PNG image at the highest output resolution available to you.
- Prefer the same aspect ratio as `source.png`.
- Do not include UI chrome, borders, labels, watermarks, or mask visualization.
{workspace_rule}
- Do not ask follow-up questions.

Final response should be one short sentence confirming the image was created."#
    )
}

/// Run a tiled detail-restoration pass over an enlarged image: every part is
/// regenerated at model-native density and pasted back at its position.
#[allow(clippy::too_many_arguments)]
fn antigravity_restore_image_details(
    app: &AppHandle,
    run_id: &str,
    antigravity_bin: &str,
    options: &AntigravityCommandOptions,
    autonomy: AiAutonomyLevel,
    workspace_path: &Path,
    restore_root: &Path,
    _allow_new_project: bool,
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
        plan_ai_upscale_placement(AiEditProvider::Antigravity, dimensions, label)?
    } else {
        plan_ai_restore_placement(AiEditProvider::Antigravity, dimensions, label)?
    };
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
        let job_dir = antigravity_job_dir_label(workspace_path, &part_path);
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
        let geometry_note = ai_part_geometry_note(&placement, part_index);
        let prompt_text = antigravity_restore_director_prompt(
            &job_dir,
            autonomy,
            director_provider,
            director_mode,
            director_involvement,
            &geometry_note,
            has_overview,
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
                "Restoring image detail with Antigravity",
            ),
        );
        let result_path = part_path.join("result.png");
        let mut image_paths = vec![part_path.join("source.png"), part_path.join("mask.png")];
        if has_overview {
            image_paths.push(part_path.join("overview.png"));
        }
        let bytes = run_antigravity_direct_image(
            app,
            run_id,
            antigravity_bin,
            &part_path,
            antigravity_direct_spec_for_working(prompt_text.clone(), image_paths, &part.working),
            options,
        )
        .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?;
        fs::write(&result_path, &bytes).map_err(|e| {
            ai_part_progress_message(
                &placement,
                part_index,
                &format!("Failed to write Antigravity detail restoration result: {e}"),
            )
        })?;
        let (bytes, _result_dimensions, _normalized) =
            read_png_bytes_cropped_to_ai_working_canvas(&result_path, &part.working, label)
                .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?;
        let _ = fs::remove_file(&result_path);
        let unaligned_bytes = bytes.clone();
        let (bytes, drift_correction) =
            correct_part_result_drift(&inputs.source_png, &bytes, label)?;
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
        fs::write(part_path.join("part_result.png"), &bytes)
            .map_err(|e| format!("Failed to record {label} part result: {e}"))?;
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
    }
    let composed_png = if return_composed {
        Some(composer.composed_png(label)?)
    } else {
        None
    };
    Ok((composed_png, layer_results))
}

#[tauri::command]
pub(crate) async fn generate_antigravity_image(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    keep_job_dir: Option<bool>,
    keep_debug_artifacts: Option<bool>,
    reference_pngs: Vec<WorkflowSourceImage>,
    run_id: String,
    model: Option<String>,
    approval_mode: Option<String>,
    image_model: Option<String>,
    image_size: Option<String>,
    person_generation: Option<String>,
    prominent_people: Option<String>,
    compression_quality: Option<u8>,
    advanced_json: Option<String>,
    safety_filtering: Option<String>,
    safety_harassment: Option<String>,
    safety_hate_speech: Option<String>,
    safety_sexually_explicit: Option<String>,
    safety_dangerous_content: Option<String>,
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
        let antigravity_bin = configured_or_default_antigravity_bin(bin)?;
        let mut options = antigravity_command_options_with_image(
            model,
            approval_mode,
            image_model,
            image_size,
            person_generation,
            prominent_people,
            compression_quality,
            advanced_json,
            safety_filtering,
            safety_harassment,
            safety_hate_speech,
            safety_sexually_explicit,
            safety_dangerous_content,
        );
        options.keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        let autonomy = ai_autonomy_level(autonomy_level);
        let director_mode = ai_director_mode(director_mode);
        let director_provider = ai_director_provider(director_provider);
        let director_involvement = ai_director_involvement(director_involvement);
        let agentic_director_loop = director_provider == AiDirectorProvider::Antigravity
            && director_uses_agentic_loop(director_mode, director_involvement);
        let run_id = if run_id.trim().is_empty() {
            format!("antigravity-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let (project_dir, job_project_dir, job_path, cleanup_project_job, _temp_job) =
            project_or_temp_job_path(&app, &project_path, "antigravity", &run_id, keep_job_dir)?;
        let workspace_path = project_dir
            .as_ref()
            .map(PathBuf::as_path)
            .or_else(|| job_project_dir.as_ref().map(PathBuf::as_path))
            .unwrap_or(job_path.as_path())
            .to_path_buf();
        let job_dir = antigravity_job_dir_label(&workspace_path, &job_path);
        let (reference_paths, reference_names) =
            write_reference_pngs(&job_path, &reference_pngs, "Generate image")?;
        let aspect_ratio = target_dimensions.and_then(antigravity_closest_aspect_label);
        let provider_size = aspect_ratio.as_deref().and_then(|aspect| {
            target_dimensions
                .and_then(|target| antigravity_output_target(aspect, target))
                .map(|(tier, _)| tier.to_string())
        });
        write_ai_job_settings(
            &job_path,
            json!({
                "version": 1,
                "workflow": "generate_image",
                "runId": run_id,
                "provider": "Antigravity",
                "agenticDirectorLoop": agentic_director_loop,
                "director": {
                    "provider": director_provider.label(),
                    "mode": director_mode.label(),
                    "involvement": director_involvement.label()
                },
                "imageGenerator": {
                    "provider": "Antigravity",
                    "model": options.image_model,
                    "aspectRatio": aspect_ratio,
                    "imageSize": provider_size,
                    "personGeneration": options.person_generation,
                    "prominentPeople": options.prominent_people,
                    "compressionQuality": options.compression_quality,
                    "safetyFiltering": options.safety_filtering,
                    "safety": {
                        "harassment": options.safety_harassment,
                        "hateSpeech": options.safety_hate_speech,
                        "sexuallyExplicit": options.safety_sexually_explicit,
                        "dangerousContent": options.safety_dangerous_content
                    }
                },
                "agent": {
                    "model": options.model,
                    "approvalMode": options.approval_mode,
                    "autonomy": autonomy.label()
                },
                "targetDimensions": target_dimensions.map(|(width, height)| json!({ "width": width, "height": height })),
                "referenceImages": reference_names,
                "keepJobDir": keep_job_dir,
                "debugArtifacts": options.keep_debug_artifacts
            }),
        )?;
        let prompt_text = antigravity_generate_director_prompt(
            prompt.trim(),
            &job_dir,
            autonomy,
            director_provider,
            director_mode,
            director_involvement,
            &reference_names,
        );
        write_ai_job_prompt(&job_path, &prompt_text, "Antigravity image generation")?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);

        let result_path = job_path.join("result.png");
        // A failed previous attempt may have gotten past generation; reuse its
        // image instead of paying for another one.
        let salvaged_bytes = fs::read(&result_path)
            .ok()
            .filter(|bytes| is_png(bytes) && png_dimensions_from_bytes(bytes).is_some());
        let raw_bytes = if let Some(bytes) = salvaged_bytes {
            emit_codex_progress(&app, &run_id, "Reusing the previously generated image");
            bytes
        } else {
            let _ = fs::remove_file(&result_path);
            let bytes = if agentic_director_loop {
                emit_codex_progress(&app, &run_id, "Starting Antigravity AI Director");
                run_candidate_director_loop(
                    &job_path,
                    DirectorLoopSpec {
                        provider_label: "Antigravity",
                        involvement: director_involvement,
                        legacy_request_file: "paintnode-image-request.json",
                        base_prompt_text: &prompt_text,
                        review_criteria: workflow_review_criteria("image_generation"),
                        ensure_completion_acceptance_note:
                            "Candidate completed; ensure-completion mode does not run a separate quality review.",
                    },
                    |_, turn_prompt_text, _candidate_path| {
                        run_antigravity(
                            &antigravity_bin,
                            &workspace_path,
                            &job_path,
                            turn_prompt_text,
                            &options,
                            true,
                            app.clone(),
                            run_id.clone(),
                            Some(PAINTNODE_DIRECTOR_ACTION_FILE),
                        )
                    },
                    |_| None,
                    |turn, request, candidate_prompt| {
                        let candidate_file = director_candidate_file(turn);
                        let candidate = run_antigravity_direct_image(
                            &app,
                            &run_id,
                            &antigravity_bin,
                            &job_path,
                            AntigravityImageRequestSpec {
                                prompt: image_request_prompt(&request)
                                    .unwrap_or_else(|_| candidate_prompt.to_string()),
                                image_paths: reference_paths.clone(),
                                aspect_ratio: aspect_ratio.clone(),
                                image_size: provider_size.clone(),
                            },
                            &options,
                        )?;
                        fs::write(job_path.join(&candidate_file), &candidate).map_err(|e| {
                            format!("Failed to write Antigravity Director candidate: {e}")
                        })?;
                        png_dimensions_from_bytes(&candidate).ok_or_else(|| {
                            "Antigravity Director candidate PNG dimensions are invalid."
                                .to_string()
                        })?;
                        Ok(DirectorCandidate {
                            result: candidate,
                            file_name: candidate_file,
                        })
                    },
                )?
            } else {
                emit_codex_progress(
                    &app,
                    &run_id,
                    "Generating through Antigravity image backend",
                );
                run_antigravity_direct_image(
                    &app,
                    &run_id,
                    &antigravity_bin,
                    &job_path,
                    AntigravityImageRequestSpec {
                        prompt: prompt_text.clone(),
                        image_paths: reference_paths,
                        aspect_ratio: aspect_ratio.clone(),
                        image_size: provider_size.clone(),
                    },
                    &options,
                )?
            };
            fs::write(&result_path, &bytes)
                .map_err(|e| format!("Failed to write Antigravity image result: {e}"))?;
            png_dimensions_from_bytes(&bytes)
                .ok_or_else(|| "Antigravity image PNG dimensions are invalid.".to_string())?;
            bytes
        };
        let bytes = if let Some(target) = target_dimensions {
            let (mut bytes, source_dimensions, upscale_factor) =
                cover_crop_png_to_dimensions(&raw_bytes, target, "Antigravity generated image")?;
            if source_dimensions != target {
                emit_codex_progress(
                    &app,
                    &run_id,
                    &format!(
                        "Cover-cropped Antigravity result from {}x{} to {}x{}",
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
                let (restored, _) = antigravity_restore_image_details(
                    &app,
                    &run_id,
                    &antigravity_bin,
                    &options,
                    autonomy,
                    &workspace_path,
                    &job_path.join("restore"),
                    false,
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
            emit_codex_progress(&app, &run_id, "Saving Antigravity image to the project");
            let (id, relative_path) =
                write_asset_file(&project_dir, "generated", prompt.trim(), "png", &bytes)?;
            Some(add_asset(
                &project_dir,
                ProjectAsset::generated_png(
                    id,
                    relative_path,
                    prompt.trim().chars().take(48).collect::<String>(),
                    Some(prompt.trim().into()),
                    Some("result.png".into()),
                ),
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
            layers: Vec::new(),
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub(crate) async fn generate_antigravity_fill_image(
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
    approval_mode: Option<String>,
    image_model: Option<String>,
    image_size: Option<String>,
    person_generation: Option<String>,
    prominent_people: Option<String>,
    compression_quality: Option<u8>,
    advanced_json: Option<String>,
    safety_filtering: Option<String>,
    safety_harassment: Option<String>,
    safety_hate_speech: Option<String>,
    safety_sexually_explicit: Option<String>,
    safety_dangerous_content: Option<String>,
    autonomy_level: Option<String>,
    director_mode: Option<String>,
    director_provider: Option<String>,
    director_involvement: Option<String>,
    edit_checks_level: Option<u8>,
    fill_aspect_ratio: Option<String>,
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
    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let antigravity_bin = configured_or_default_antigravity_bin(bin)?;
        let mut options = antigravity_command_options_with_image(
            model,
            approval_mode,
            image_model,
            image_size,
            person_generation,
            prominent_people,
            compression_quality,
            advanced_json,
            safety_filtering,
            safety_harassment,
            safety_hate_speech,
            safety_sexually_explicit,
            safety_dangerous_content,
        );
        options.keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        let autonomy = ai_autonomy_level(autonomy_level);
        let director_mode = ai_director_mode(director_mode);
        let director_provider = ai_director_provider(director_provider);
        let director_involvement = ai_director_involvement(director_involvement);
        let _checks_level = ai_edit_checks_level(edit_checks_level);
        let fill_aspect_ratio = fill_aspect_ratio
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let run_id = if run_id.trim().is_empty() {
            format!("antigravity-fill-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let (project_dir, job_project_dir, job_path, cleanup_project_job, _temp_job) =
            project_or_temp_job_path(
                &app,
                &project_path,
                "antigravity-fill",
                &run_id,
                keep_job_dir,
            )?;
        let store_asset = store_asset.unwrap_or(true);
        let workspace_path = project_dir
            .as_ref()
            .map(PathBuf::as_path)
            .or_else(|| job_project_dir.as_ref().map(PathBuf::as_path))
            .unwrap_or(job_path.as_path())
            .to_path_buf();

        let placement = plan_ai_fill_placement(
            AiEditProvider::Antigravity,
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
        let storyboard = prepare_antigravity_fill_storyboard(
            &app,
            &run_id,
            &antigravity_bin,
            &workspace_path,
            &job_path,
            &placement,
            &composer,
            prompt.trim(),
            &reference_pngs,
            &options,
        )?;

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
            let job_dir = antigravity_job_dir_label(&workspace_path, &part_path);
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
            let reference_names = if has_storyboard_draft {
                Vec::new()
            } else {
                let (_reference_paths, reference_names) =
                    write_reference_pngs(&part_path, &reference_pngs, "Generative fill")?;
                reference_names
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
            let base_prompt_text = antigravity_fill_director_prompt(
                prompt.trim(),
                &job_dir,
                autonomy,
                director_provider,
                director_mode,
                director_involvement,
                &geometry_note,
                &storyboard_note,
                storyboard_anchor,
                storyboard_fallback,
                has_overview,
                has_storyboard_draft,
                placement.is_split() && part_index > 0,
                &reference_names,
                &part.working,
            );

            emit_codex_part_progress(
                &app,
                &run_id,
                part_index,
                placement.parts.len(),
                ai_part_progress_message(
                    &placement,
                    part_index,
                    "Generating through Antigravity image backend",
                ),
            );
            let result_path = part_path.join("result.png");
            write_ai_job_prompt(&part_path, &base_prompt_text, "Antigravity generative fill")?;
            let mut image_paths = vec![part_path.join("source.png")];
            if has_overview {
                image_paths.push(part_path.join("overview.png"));
            }
            if !has_storyboard_draft {
                let (reference_paths, _reference_names) =
                    write_reference_pngs(&part_path, &reference_pngs, "Generative fill")?;
                image_paths.extend(reference_paths);
            }
            let generated = run_antigravity_direct_image(
                &app,
                &run_id,
                &antigravity_bin,
                &part_path,
                antigravity_direct_spec_for_working(
                    base_prompt_text.clone(),
                    image_paths,
                    &part.working,
                ),
                &options,
            )
            .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?;
            fs::write(&result_path, &generated).map_err(|e| {
                ai_part_progress_message(
                    &placement,
                    part_index,
                    &format!("Failed to write Antigravity generative fill result: {e}"),
                )
            })?;
            let (generated_bytes, result_dimensions, normalized_result) =
                read_png_bytes_cropped_to_ai_working_canvas(
                    &result_path,
                    &part.working,
                    "Antigravity generative fill",
                )
                .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?;
            if normalized_result {
                emit_codex_progress(
                    &app,
                    &run_id,
                    ai_part_progress_message(
                        &placement,
                        part_index,
                        &format!(
                            "Normalized Antigravity fill from {}x{} to {}x{}",
                            result_dimensions.0,
                            result_dimensions.1,
                            part.working.original_dimensions.0,
                            part.working.original_dimensions.1
                        ),
                    ),
                );
            }
            let _ = fs::remove_file(&result_path);
            if store_asset {
                if let Some(project_dir) = project_dir.as_ref() {
                    let raw_name = format!("Generative fill raw part {}", part_index + 1);
                    let raw_asset = store_generated_png_asset(
                        project_dir,
                        &generated_bytes,
                        raw_name,
                        Some(prompt.trim().into()),
                        Some("part_result.png".into()),
                    )?;
                    raw_assets.push(raw_asset);
                }
            }
            let unaligned_bytes = generated_bytes.clone();
            let (generated_bytes, drift_correction) =
                correct_part_result_drift(&inputs.source_png, &generated_bytes, "Generative fill")?;
            if let Some(correction) = drift_correction {
                let _ = fs::write(
                    part_path.join("part_result-unaligned.png"),
                    &unaligned_bytes,
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
            fs::write(part_path.join("part_result.png"), &generated_bytes)
                .map_err(|e| format!("Failed to record generative fill part result: {e}"))?;
            if return_part_layers {
                let layer_png =
                    composer.part_result_layer_png(part, &generated_bytes, "Generative fill")?;
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
            composer.apply_part_result(part, &generated_bytes, "Generative fill")?;
        }

        let bytes = composer.composed_png("Generative fill")?;
        let data_url = png_data_url(&bytes)?;
        let asset = if store_asset && !return_part_layers {
            if let Some(project_dir) = project_dir {
                let (id, relative_path) =
                    write_asset_file(&project_dir, "generated", prompt.trim(), "png", &bytes)?;
                Some(add_asset(
                    &project_dir,
                    ProjectAsset::generated_png(
                        id,
                        relative_path,
                        prompt.trim().chars().take(48).collect::<String>(),
                        Some(prompt.trim().into()),
                        Some("result.png".into()),
                    ),
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

#[tauri::command]
pub(crate) async fn generate_antigravity_retouch_image(
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
    approval_mode: Option<String>,
    image_model: Option<String>,
    image_size: Option<String>,
    person_generation: Option<String>,
    prominent_people: Option<String>,
    compression_quality: Option<u8>,
    advanced_json: Option<String>,
    safety_filtering: Option<String>,
    safety_harassment: Option<String>,
    safety_hate_speech: Option<String>,
    safety_sexually_explicit: Option<String>,
    safety_dangerous_content: Option<String>,
    autonomy_level: Option<String>,
    director_mode: Option<String>,
    director_provider: Option<String>,
    director_involvement: Option<String>,
    edit_checks_level: Option<u8>,
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
    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let antigravity_bin = configured_or_default_antigravity_bin(bin)?;
        let mut options = antigravity_command_options_with_image(
            model,
            approval_mode,
            image_model,
            image_size,
            person_generation,
            prominent_people,
            compression_quality,
            advanced_json,
            safety_filtering,
            safety_harassment,
            safety_hate_speech,
            safety_sexually_explicit,
            safety_dangerous_content,
        );
        options.keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        let autonomy = ai_autonomy_level(autonomy_level);
        let director_mode = ai_director_mode(director_mode);
        let director_provider = ai_director_provider(director_provider);
        let director_involvement = ai_director_involvement(director_involvement);
        let checks_level = ai_edit_checks_level(edit_checks_level);
        let run_id = if run_id.trim().is_empty() {
            format!("antigravity-retouch-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let (project_dir, job_project_dir, job_path, cleanup_project_job, _temp_job) =
            project_or_temp_job_path(
                &app,
                &project_path,
                "antigravity-retouch",
                &run_id,
                keep_job_dir,
            )?;
        let workspace_path = project_dir
            .as_ref()
            .map(PathBuf::as_path)
            .or_else(|| job_project_dir.as_ref().map(PathBuf::as_path))
            .unwrap_or(job_path.as_path())
            .to_path_buf();

        let placement = plan_ai_edit_placement(
            AiEditProvider::Antigravity,
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
            let job_dir = antigravity_job_dir_label(&workspace_path, &part_path);
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
            let geometry_note = ai_part_prompt_context(&placement, part_index);
            fs::write(
                part_path.join("paintnode_contract.txt"),
                antigravity_retouch_contract_text(&job_dir, autonomy, &geometry_note),
            )
            .map_err(|e| format!("Failed to write AI retouch PaintNode contract: {e}"))?;
            let (reference_paths, reference_names) =
                write_reference_pngs(&part_path, &reference_pngs, "AI retouch")?;
            let base_prompt_text = antigravity_retouch_director_prompt(
                prompt.trim(),
                has_annotated_source,
                has_reference,
                &reference_names,
                &job_dir,
                autonomy,
                director_provider,
                director_mode,
                director_involvement,
                &geometry_note,
                has_overview,
                placement.is_split() && part_index > 0,
                &part.working,
            );

            emit_codex_part_progress(
                &app,
                &run_id,
                part_index,
                placement.parts.len(),
                ai_part_progress_message(
                    &placement,
                    part_index,
                    "Generating through Antigravity image backend",
                ),
            );
            let result_path = part_path.join("result.png");
            let mut generated_bytes = Vec::new();
            let mut retry_note = "";
            for attempt in 0..AI_PROTECTED_DRIFT_MAX_ATTEMPTS {
                let prompt_text = if retry_note.is_empty() {
                    base_prompt_text.clone()
                } else {
                    format!("{base_prompt_text}\n\n{retry_note}")
                };
                write_ai_job_prompt(&part_path, &prompt_text, "Antigravity AI retouch")?;
                let mut image_paths = vec![
                    part_path.join("edit_target.png"),
                    part_path.join("mask.png"),
                    part_path.join("source.png"),
                ];
                if has_overview {
                    image_paths.push(part_path.join("overview.png"));
                }
                if has_annotated_source {
                    image_paths.push(part_path.join("annotated_source.png"));
                }
                if has_reference {
                    image_paths.push(part_path.join("reference.png"));
                }
                image_paths.extend(reference_paths.clone());
                let generated = run_antigravity_direct_image(
                    &app,
                    &run_id,
                    &antigravity_bin,
                    &part_path,
                    antigravity_direct_spec_for_working(
                        prompt_text.clone(),
                        image_paths,
                        &part.working,
                    ),
                    &options,
                )
                .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?;
                fs::write(&result_path, &generated).map_err(|e| {
                    ai_part_progress_message(
                        &placement,
                        part_index,
                        &format!("Failed to write Antigravity AI retouch result: {e}"),
                    )
                })?;
                emit_codex_progress(
                    &app,
                    &run_id,
                    ai_part_progress_message(
                        &placement,
                        part_index,
                        "Reading Antigravity AI retouch result",
                    ),
                );
                let (bytes, result_dimensions, normalized_result) =
                    read_png_bytes_cropped_to_ai_working_canvas(
                        &result_path,
                        &part.working,
                        "AI retouch candidate",
                    )
                    .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?;
                if normalized_result {
                    emit_codex_progress(
                        &app,
                        &run_id,
                        ai_part_progress_message(
                            &placement,
                            part_index,
                            &format!(
                                "Normalized Antigravity AI retouch from {}x{} to {}x{}",
                                result_dimensions.0,
                                result_dimensions.1,
                                part.crop.width,
                                part.crop.height
                            ),
                        ),
                    );
                }
                // Result checks: in-place drift, then seam continuity when
                // the user's check level enables it.
                let rejection = ai_candidate_rejection(
                    checks_level,
                    &inputs.edit_target_png,
                    &inputs.source_png,
                    &inputs.mask_png,
                    &bytes,
                    "AI retouch candidate",
                )
                .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?;
                let Some(rejection) = rejection else {
                    generated_bytes = bytes;
                    break;
                };
                retry_note = if rejection.continuation_retry {
                    AI_SEAM_RETRY_NOTE
                } else {
                    AI_IN_PLACE_RETRY_NOTE
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
                                rejection.reason
                            ),
                        ),
                    );
                    remove_rejected_ai_candidate(&result_path)
                        .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?;
                    continue;
                }
                // Drop the rejected candidate so a resumed retry cannot
                // silently import it via reuse_part_result.
                let _ = fs::remove_file(&result_path);
                return Err(ai_part_progress_message(
                    &placement,
                    part_index,
                    &format!(
                        "The AI image model produced an unusable candidate: {}. Try a smaller edit area, a simpler prompt, or a lower result-checks level.",
                        rejection.reason
                    ),
                ));
            }
            fs::write(part_path.join("part_result.png"), &generated_bytes)
                .map_err(|e| format!("Failed to record AI retouch part result: {e}"))?;
            composer.apply_part_result(part, &generated_bytes, "AI retouch")?;
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
            emit_codex_progress(&app, &run_id, "Saving Antigravity AI retouch result");
            let primary_asset = store_generated_png_asset(
                &project_dir,
                &generated_bytes,
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
            layers: Vec::new(),
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

/// Enlarge a flattened document and restore its detail with tiled AI
/// regeneration (AI -> Upscale). 100% skips the enlarge and only restores.
#[tauri::command]
pub(crate) async fn upscale_antigravity_image(
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
    approval_mode: Option<String>,
    image_model: Option<String>,
    image_size: Option<String>,
    person_generation: Option<String>,
    prominent_people: Option<String>,
    compression_quality: Option<u8>,
    advanced_json: Option<String>,
    safety_filtering: Option<String>,
    safety_harassment: Option<String>,
    safety_hate_speech: Option<String>,
    safety_sexually_explicit: Option<String>,
    safety_dangerous_content: Option<String>,
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
    plan_ai_upscale_placement(AiEditProvider::Antigravity, target_dimensions, "AI upscale")?;

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let antigravity_bin = configured_or_default_antigravity_bin(bin)?;
        let mut options = antigravity_command_options_with_image(
            model,
            approval_mode,
            image_model,
            image_size,
            person_generation,
            prominent_people,
            compression_quality,
            advanced_json,
            safety_filtering,
            safety_harassment,
            safety_hate_speech,
            safety_sexually_explicit,
            safety_dangerous_content,
        );
        options.keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        let autonomy = ai_autonomy_level(autonomy_level);
        let director_mode = ai_director_mode(director_mode);
        let director_provider = ai_director_provider(director_provider);
        let director_involvement = ai_director_involvement(director_involvement);
        let run_id = if run_id.trim().is_empty() {
            format!("antigravity-upscale-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let keep_composed_result = keep_composed_result.unwrap_or(false);
        let (project_dir, job_project_dir, job_path, cleanup_project_job, _temp_job) =
            project_or_temp_job_path(
                &app,
                &project_path,
                "antigravity-upscale",
                &run_id,
                keep_job_dir,
            )?;
        let workspace_path = project_dir
            .as_ref()
            .map(PathBuf::as_path)
            .or_else(|| job_project_dir.as_ref().map(PathBuf::as_path))
            .unwrap_or(job_path.as_path())
            .to_path_buf();
        let new_antigravity_project = job_project_dir.is_none();

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

        let (composed_bytes, layer_results) = antigravity_restore_image_details(
            &app,
            &run_id,
            &antigravity_bin,
            &options,
            autonomy,
            &workspace_path,
            &job_path,
            new_antigravity_project,
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
                    Some("result.png".into()),
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

#[tauri::command]
pub(crate) async fn decouple_antigravity_image(
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
    approval_mode: Option<String>,
    autonomy_level: Option<String>,
    director_mode: Option<String>,
    director_provider: Option<String>,
    director_involvement: Option<String>,
) -> Result<DecoupleImageResult, String> {
    if !is_png(&source_png) {
        return Err("Asset extraction source must be a PNG image.".into());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<DecoupleImageResult, String> {
        let antigravity_bin = configured_or_default_antigravity_bin(bin)?;
        let mut options = antigravity_command_options(model, approval_mode);
        options.keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        let _autonomy = ai_autonomy_level(autonomy_level);
        let director_mode = ai_director_mode(director_mode);
        let director_provider = ai_director_provider(director_provider);
        let director_involvement = ai_director_involvement(director_involvement);
        let run_id = if run_id.trim().is_empty() {
            format!("antigravity-decouple-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let (project_dir, job_project_dir, job_path, cleanup_project_job, _temp_job) =
            project_or_temp_job_path(
                &app,
                &project_path,
                "antigravity-decouple",
                &now_id().to_string(),
                keep_job_dir,
            )?;
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
        let prompt_text = antigravity_decouple_director_prompt(
            user_prompt,
            &job_dir,
            director_provider,
            director_mode,
            director_involvement,
        );
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
            app.clone(),
            run_id.clone(),
            Some("manifest.json"),
        )?;
        let manifest_path = job_path.join("manifest.json");
        if !run.output.status.success() && !run.satisfied_required_output && !manifest_path.exists()
        {
            match synthesize_decouple_asset_manifest(&job_path)? {
                Some(count) => emit_codex_progress(
                    &app,
                    &run_id,
                    format!("Synthesized asset manifest from {count} Antigravity PNG outputs"),
                ),
                None => {
                    return Err(command_failure_with_required_output(
                        "Antigravity asset extraction",
                        &run.output,
                        &job_path,
                        "manifest.json",
                    ));
                }
            }
        }
        let manifest_text = match fs::read_to_string(&manifest_path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                match synthesize_decouple_asset_manifest(&job_path)? {
                    Some(count) => {
                        emit_codex_progress(
                            &app,
                            &run_id,
                            format!(
                                "Synthesized asset manifest from {count} Antigravity PNG outputs"
                            ),
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
                            "Antigravity did not create manifest.json at {}: {e}",
                            manifest_path.display()
                        ));
                    }
                }
            }
            Err(e) => {
                return Err(format!(
                    "Antigravity did not create manifest.json at {}: {e}",
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
            thread_id: None,
            notes: manifest.notes,
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[tauri::command]
pub(crate) async fn compose_antigravity_workflow(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    sources: Vec<WorkflowSourceImage>,
    run_id: String,
    keep_job_dir: Option<bool>,
    keep_debug_artifacts: Option<bool>,
    model: Option<String>,
    approval_mode: Option<String>,
    image_model: Option<String>,
    image_size: Option<String>,
    person_generation: Option<String>,
    prominent_people: Option<String>,
    compression_quality: Option<u8>,
    advanced_json: Option<String>,
    safety_filtering: Option<String>,
    safety_harassment: Option<String>,
    safety_hate_speech: Option<String>,
    safety_sexually_explicit: Option<String>,
    safety_dangerous_content: Option<String>,
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
        let mut options = antigravity_command_options_with_image(
            model,
            approval_mode,
            image_model,
            image_size,
            person_generation,
            prominent_people,
            compression_quality,
            advanced_json,
            safety_filtering,
            safety_harassment,
            safety_hate_speech,
            safety_sexually_explicit,
            safety_dangerous_content,
        );
        options.keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        let autonomy = ai_autonomy_level(autonomy_level);
        let run_id = if run_id.trim().is_empty() {
            format!("antigravity-workflow-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let (project_dir, job_project_dir, job_path, cleanup_project_job, _temp_job) =
            project_or_temp_job_path(
                &app,
                &project_path,
                "antigravity-workflow",
                &now_id().to_string(),
                keep_job_dir,
            )?;
        let workspace_path = project_dir
            .as_ref()
            .map(PathBuf::as_path)
            .or_else(|| job_project_dir.as_ref().map(PathBuf::as_path))
            .unwrap_or(job_path.as_path())
            .to_path_buf();
        let job_dir = antigravity_job_dir_label(&workspace_path, &job_path);
        let input_dir = job_path.join("inputs");
        fs::create_dir_all(&input_dir)
            .map_err(|e| format!("Failed to create workflow input folder: {e}"))?;
        let mut source_names = Vec::new();
        let mut source_paths = Vec::new();
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
            source_paths.push(path);
        }
        let prompt_text =
            antigravity_workflow_prompt(prompt.trim(), &source_names, &job_dir, autonomy);
        write_ai_job_prompt(&job_path, &prompt_text, "Antigravity workflow composition")?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);

        emit_codex_progress(
            &app,
            &run_id,
            "Generating workflow composition through Antigravity image backend",
        );
        let result_path = job_path.join("result.png");
        let bytes = run_antigravity_direct_image(
            &app,
            &run_id,
            &antigravity_bin,
            &job_path,
            AntigravityImageRequestSpec {
                prompt: prompt_text.clone(),
                image_paths: source_paths,
                aspect_ratio: None,
                image_size: None,
            },
            &options,
        )?;
        fs::write(&result_path, &bytes)
            .map_err(|e| format!("Failed to write Antigravity workflow result: {e}"))?;
        let data_url = png_data_url(&bytes)?;
        let asset = if let Some(project_dir) = project_dir {
            let (id, relative_path) =
                write_asset_file(&project_dir, "generated", prompt.trim(), "png", &bytes)?;
            Some(add_asset(
                &project_dir,
                ProjectAsset::generated_png(
                    id,
                    relative_path,
                    format!(
                        "Workflow: {}",
                        prompt.trim().chars().take(48).collect::<String>()
                    ),
                    Some(prompt.trim().into()),
                    Some("result.png".into()),
                ),
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
            layers: Vec::new(),
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::canvas::ai_exact_working_canvas;
    use crate::ai::ANTIGRAVITY_RUNS_DIR;
    use crate::ai::{TempJobDir, PAINTNODE_WORK_DIR};
    use crate::test_util::test_rgba_png;

    #[test]
    fn parses_antigravity_keychain_token_envelope() {
        let envelope = json!({
            "auth_method": "consumer",
            "token": {
                "access_token": "access-redacted",
                "refresh_token": "refresh-redacted",
                "token_type": "Bearer",
                "expiry": "2026-07-08T13:21:59.513345+09:30"
            }
        });
        let encoded = BASE64_STANDARD.encode(envelope.to_string());
        let parsed =
            parse_antigravity_keychain_token(&format!("consumer:{encoded}")).expect("parsed token");

        assert_eq!(parsed.access_token, "access-redacted");
        assert_eq!(parsed.token_type.as_deref(), Some("Bearer"));
        assert_eq!(
            parsed.expiry.as_deref(),
            Some("2026-07-08T13:21:59.513345+09:30")
        );
    }

    #[test]
    fn antigravity_token_refreshes_when_missing_or_near_expiry() {
        assert!(antigravity_token_needs_refresh(None, 100, 60));
        let token = AntigravityAuthToken {
            access_token: "access-redacted".into(),
            token_type: Some("Bearer".into()),
            expiry: Some("1970-01-01T00:03:00Z".into()),
        };

        assert_eq!(
            parse_antigravity_expiry_unix_seconds("1970-01-01T00:03:00Z"),
            Some(180)
        );
        assert!(!antigravity_token_needs_refresh(Some(&token), 100, 60));
        assert!(antigravity_token_needs_refresh(Some(&token), 130, 60));
    }

    #[test]
    fn removes_antigravity_debug_artifacts_when_debug_mode_is_off() {
        let job = TempJobDir::new("paintnode-antigravity-debug-cleanup-test").expect("temp dir");
        for file_name in [
            ANTIGRAVITY_AUTH_LOG_FILE,
            PAINTNODE_ANTIGRAVITY_IMAGE_REQUEST_FILE,
            PAINTNODE_ANTIGRAVITY_IMAGE_RESPONSE_FILE,
        ] {
            fs::write(job.path().join(file_name), b"debug").expect("write debug artifact");
        }

        remove_antigravity_debug_artifacts(job.path());

        for file_name in [
            ANTIGRAVITY_AUTH_LOG_FILE,
            PAINTNODE_ANTIGRAVITY_IMAGE_REQUEST_FILE,
            PAINTNODE_ANTIGRAVITY_IMAGE_RESPONSE_FILE,
        ] {
            assert!(!job.path().join(file_name).exists());
        }
    }

    #[test]
    fn builds_generate_content_request_with_image_config_and_inline_png() {
        let job = TempJobDir::new("paintnode-antigravity-direct-request-test").expect("temp dir");
        let source = job.path().join("source.png");
        fs::write(&source, test_rgba_png(1, 1, &[[255, 0, 0, 255]])).expect("write source");
        let options = antigravity_command_options_with_image(
            None,
            None,
            Some("gemini-3.1-flash-image".into()),
            None,
            Some("ALLOW_NONE".into()),
            Some("BLOCK_PROMINENT_PEOPLE".into()),
            Some(82),
            Some(r#"{"imageOutputOptions":{"mimeType":"IMAGE_JPEG"}}"#.into()),
            None,
            None,
            None,
            None,
            None,
        );
        let request = antigravity_image_request_json(
            &AntigravityImageRequestSpec {
                prompt: "Paint a red square.".into(),
                image_paths: vec![source],
                aspect_ratio: Some("1:1".into()),
                image_size: Some("1K".into()),
            },
            &options,
        )
        .expect("request");

        assert_eq!(request["model"], "gemini-3.1-flash-image");
        assert_eq!(request["request"]["contents"][0]["role"], "user");
        assert!(request["request"]["contents"][0]["parts"][0]["text"]
            .as_str()
            .expect("text")
            .contains("Paint a red square."));
        assert_eq!(
            request["request"]["contents"][0]["parts"][1]["inlineData"]["mimeType"],
            "image/png"
        );
        let image_config = &request["request"]["generationConfig"]["imageConfig"];
        assert_eq!(image_config["aspectRatio"], "1:1");
        assert_eq!(image_config["imageSize"], "1K");
        assert_eq!(image_config["personGeneration"], "ALLOW_NONE");
        assert_eq!(image_config["prominentPeople"], "BLOCK_PROMINENT_PEOPLE");
        assert_eq!(image_config["imageOutputOptions"]["compressionQuality"], 82);
        assert_eq!(image_config["imageOutputOptions"]["mimeType"], "IMAGE_JPEG");
        assert!(request["request"].get("safetySettings").is_none());
    }

    #[test]
    fn omits_generate_content_safety_settings_for_default_filtering() {
        let options = antigravity_command_options_with_image(
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some("default".into()),
            Some("BLOCK_NONE".into()),
            Some("BLOCK_NONE".into()),
            Some("BLOCK_NONE".into()),
            Some("BLOCK_NONE".into()),
        );
        let request = antigravity_image_request_json(
            &AntigravityImageRequestSpec {
                prompt: "Paint a red square.".into(),
                image_paths: Vec::new(),
                aspect_ratio: Some("1:1".into()),
                image_size: Some("1K".into()),
            },
            &options,
        )
        .expect("request");

        assert!(request["request"].get("safetySettings").is_none());
    }

    #[test]
    fn builds_generate_content_safety_settings_for_presets() {
        let options = antigravity_command_options_with_image(
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some("lessRestrictive".into()),
            None,
            None,
            None,
            None,
        );
        let request = antigravity_image_request_json(
            &AntigravityImageRequestSpec {
                prompt: "Paint a red square.".into(),
                image_paths: Vec::new(),
                aspect_ratio: Some("1:1".into()),
                image_size: Some("1K".into()),
            },
            &options,
        )
        .expect("request");
        let settings = request["request"]["safetySettings"]
            .as_array()
            .expect("safety settings");
        assert_eq!(settings.len(), 4);
        assert!(settings
            .iter()
            .all(|setting| setting["threshold"] == "BLOCK_ONLY_HIGH"));

        let options = antigravity_command_options_with_image(
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some("moreRestrictive".into()),
            None,
            None,
            None,
            None,
        );
        let request = antigravity_image_request_json(
            &AntigravityImageRequestSpec {
                prompt: "Paint a red square.".into(),
                image_paths: Vec::new(),
                aspect_ratio: Some("1:1".into()),
                image_size: Some("1K".into()),
            },
            &options,
        )
        .expect("request");
        let settings = request["request"]["safetySettings"]
            .as_array()
            .expect("safety settings");
        assert_eq!(settings.len(), 4);
        assert!(settings
            .iter()
            .all(|setting| setting["threshold"] == "BLOCK_LOW_AND_ABOVE"));
    }

    #[test]
    fn builds_generate_content_safety_settings_for_custom_categories() {
        let options = antigravity_command_options_with_image(
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some("custom".into()),
            Some("BLOCK_NONE".into()),
            Some(ANTIGRAVITY_SAFETY_DEFAULT_THRESHOLD.into()),
            Some("BLOCK_MEDIUM_AND_ABOVE".into()),
            Some("BLOCK_LOW_AND_ABOVE".into()),
        );
        let request = antigravity_image_request_json(
            &AntigravityImageRequestSpec {
                prompt: "Paint a red square.".into(),
                image_paths: Vec::new(),
                aspect_ratio: Some("1:1".into()),
                image_size: Some("1K".into()),
            },
            &options,
        )
        .expect("request");
        let settings = request["request"]["safetySettings"]
            .as_array()
            .expect("safety settings");

        assert_eq!(settings.len(), 3);
        assert!(settings.iter().any(|setting| {
            setting["category"] == "HARM_CATEGORY_HARASSMENT"
                && setting["threshold"] == "BLOCK_NONE"
        }));
        assert!(!settings
            .iter()
            .any(|setting| setting["category"] == "HARM_CATEGORY_HATE_SPEECH"));
        assert!(settings.iter().any(|setting| {
            setting["category"] == "HARM_CATEGORY_SEXUALLY_EXPLICIT"
                && setting["threshold"] == "BLOCK_MEDIUM_AND_ABOVE"
        }));
        assert!(settings.iter().any(|setting| {
            setting["category"] == "HARM_CATEGORY_DANGEROUS_CONTENT"
                && setting["threshold"] == "BLOCK_LOW_AND_ABOVE"
        }));
    }

    #[test]
    fn decodes_inline_png_generate_content_response() {
        let png = test_rgba_png(1, 1, &[[0, 128, 255, 255]]);
        let body = json!({
            "response": {
                "candidates": [{
                    "content": {
                        "role": "model",
                        "parts": [{
                            "inlineData": {
                                "mimeType": "image/png",
                                "data": BASE64_STANDARD.encode(&png)
                            }
                        }]
                    },
                    "finishReason": "STOP"
                }]
            }
        })
        .to_string();
        let decoded =
            decode_antigravity_generate_content_response_text(&body).expect("decoded image");

        assert_eq!(png_dimensions_from_bytes(&decoded), Some((1, 1)));
    }

    #[test]
    fn converts_inline_jpeg_generate_content_response_to_png() {
        let image = image::RgbaImage::from_pixel(2, 1, image::Rgba([240, 40, 20, 255]));
        let mut jpeg = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut jpeg, image::ImageFormat::Jpeg)
            .expect("jpeg");
        let body = json!({
            "response": {
                "candidates": [{
                    "content": {
                        "parts": [{
                            "inlineData": {
                                "mimeType": "image/jpeg",
                                "data": BASE64_STANDARD.encode(jpeg.into_inner())
                            }
                        }]
                    }
                }]
            }
        })
        .to_string();
        let decoded =
            decode_antigravity_generate_content_response_text(&body).expect("decoded image");

        assert!(is_png(&decoded));
        assert_eq!(png_dimensions_from_bytes(&decoded), Some((2, 1)));
    }

    #[test]
    fn surfaces_no_image_finish_message() {
        let body = json!({
            "response": {
                "candidates": [{
                    "finishReason": "STOP",
                    "finishMessage": "Unable to show the generated image."
                }]
            }
        })
        .to_string();
        let error = decode_antigravity_generate_content_response_text(&body)
            .expect_err("should reject no-image response");

        assert!(error.contains("returned no image data"));
        assert!(error.contains("Unable to show the generated image."));
    }

    #[test]
    fn surfaces_prompt_feedback_and_safety_ratings_when_no_image_is_returned() {
        let body = json!({
            "response": {
                "promptFeedback": {
                    "blockReason": "PROHIBITED_CONTENT",
                    "blockReasonMessage": "The prompt was blocked by the image safety system.",
                    "safetyRatings": [{
                        "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                        "probability": "HIGH",
                        "blocked": true
                    }]
                },
                "candidates": [{
                    "finishReason": "SAFETY",
                    "safetyRatings": [{
                        "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                        "probability": "HIGH",
                        "blocked": true
                    }]
                }]
            }
        })
        .to_string();
        let error = decode_antigravity_generate_content_response_text(&body)
            .expect_err("should surface safety diagnostics");

        assert!(error.contains("returned no image data"));
        assert!(error.contains("blockReason: PROHIBITED_CONTENT"));
        assert!(error
            .contains("blockReasonMessage: The prompt was blocked by the image safety system."));
        assert!(error.contains("finishReason: SAFETY"));
        assert!(
            error.contains("Safety rating: HARM_CATEGORY_SEXUALLY_EXPLICIT (HIGH, blocked=true)")
        );
    }

    #[test]
    fn surfaces_sanitized_raw_excerpt_when_no_structured_diagnostics_exist() {
        let body = json!({
            "response": {
                "candidates": [],
                "metadata": {
                    "opaque": "backend returned no candidate details"
                }
            },
            "traceId": "trace-redacted"
        })
        .to_string();
        let error = decode_antigravity_generate_content_response_text(&body)
            .expect_err("should surface raw excerpt");

        assert!(error.contains("returned no image data"));
        assert!(error.contains("Raw response excerpt"));
        assert!(error.contains("backend returned no candidate details"));
        assert!(error.contains("trace-redacted"));
    }

    #[test]
    fn formats_antigravity_http_auth_and_capacity_errors() {
        let auth = antigravity_http_error_message(reqwest::StatusCode::FORBIDDEN, "{}");
        assert!(auth.contains("HTTP 403"));
        assert!(auth.contains("authentication was rejected"));

        let capacity = antigravity_http_error_message(
            reqwest::StatusCode::SERVICE_UNAVAILABLE,
            r#"{"error":{"status":"MODEL_CAPACITY_EXHAUSTED"}}"#,
        );
        assert!(capacity.contains("HTTP 503"));
        assert!(capacity.contains("currently at capacity"));
        assert!(capacity.contains("MODEL_CAPACITY_EXHAUSTED"));
    }

    #[test]
    fn rejects_unsupported_advanced_image_options() {
        let job = TempJobDir::new("paintnode-antigravity-advanced-options-test").expect("temp dir");
        let source = job.path().join("source.png");
        fs::write(&source, test_rgba_png(1, 1, &[[255, 0, 0, 255]])).expect("write source");
        let options = antigravity_command_options_with_image(
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(r#"{"endpointUrl":"https://example.test"}"#.into()),
            None,
            None,
            None,
            None,
            None,
        );
        let error = antigravity_image_request_json(
            &AntigravityImageRequestSpec {
                prompt: "Paint a red square.".into(),
                image_paths: vec![source],
                aspect_ratio: Some("1:1".into()),
                image_size: Some("1K".into()),
            },
            &options,
        )
        .expect_err("unsupported option should fail");

        assert!(error.contains("endpointUrl"));
        assert!(error.contains("not supported"));
    }

    #[test]
    #[ignore = "manual schema probe; set PAINTNODE_ANTIGRAVITY_LIVE_SCHEMA_PROBE=1 and run explicitly"]
    fn live_antigravity_generate_content_schema_probe() {
        assert_eq!(
            std::env::var("PAINTNODE_ANTIGRAVITY_LIVE_SCHEMA_PROBE").as_deref(),
            Ok("1"),
            "set PAINTNODE_ANTIGRAVITY_LIVE_SCHEMA_PROBE=1 to run this live probe"
        );
        let job = TempJobDir::new("paintnode-antigravity-live-schema-probe").expect("temp dir");
        let antigravity_bin =
            configured_or_default_antigravity_bin(None).expect("Antigravity CLI auth helper");
        wake_antigravity_auth(&antigravity_bin, job.path(), true).expect("auth wake");
        let token = load_antigravity_keychain_token().expect("keychain token");
        let client = antigravity_image_http_client(&antigravity_image_user_agent(&antigravity_bin))
            .expect("client");
        let request = antigravity_image_request_json(
            &AntigravityImageRequestSpec {
                prompt: "Generate a simple centered red square icon on a plain white background."
                    .into(),
                image_paths: Vec::new(),
                aspect_ratio: Some("1:1".into()),
                image_size: Some("1K".into()),
            },
            &antigravity_command_options_with_image(
                None,
                None,
                Some(DEFAULT_ANTIGRAVITY_IMAGE_MODEL.into()),
                None,
                Some("ALLOW_NONE".into()),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            ),
        )
        .expect("request");
        fs::write(
            job.path().join(PAINTNODE_ANTIGRAVITY_IMAGE_REQUEST_FILE),
            serde_json::to_vec_pretty(&request).expect("request json"),
        )
        .expect("write request");
        let (status, text) =
            post_antigravity_image_request(&client, &token, &request).expect("post");
        fs::write(job.path().join("response.json"), &text).expect("write response");
        assert!(
            status.is_success(),
            "{}",
            antigravity_http_error_message(status, &text)
        );
        let png = decode_antigravity_generate_content_response_text(&text).expect("image");
        fs::write(job.path().join("result.png"), png).expect("write result");
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
    fn antigravity_restore_prompt_requests_returned_image_without_content_changes() {
        let prompt = antigravity_restore_prompt(
            "paintnode/antigravity-runs/up-1/part-2",
            AiAutonomyLevel::Low,
            AiDirectorMode::Auto,
            AiDirectorInvolvement::FullReview,
            "PaintNode image geometry:\n- The attached images are a crop of a larger PaintNode document; PaintNode will paste your result back into the correct document region automatically.",
            true,
        );
        assert!(prompt.contains("paintnode/antigravity-runs/up-1/part-2/source.png"));
        assert!(prompt.contains("paintnode/antigravity-runs/up-1/part-2/overview.png"));
        assert!(prompt.contains("AI Director participation: Full review"));
        assert!(prompt.contains("Do not add, remove, move, restyle, or reinterpret any content"));
        assert!(prompt.contains("Preserve intentional medium character such as film grain"));
        assert!(prompt.contains("highest output resolution"));
        assert!(prompt.contains("Return exactly one PNG image"));
        assert!(prompt.contains("a crop of a larger PaintNode document"));
        assert!(!prompt.contains("result.png"));
        assert!(!prompt.contains("edit_target.png"));
        assert!(!prompt.contains("Use $imagegen"));
        assert!(!prompt.contains("chroma"));
    }

    #[test]
    fn antigravity_generate_prompt_uses_director_action_contract_when_active() {
        let active = antigravity_generate_director_prompt(
            "sunlit beach photo",
            "paintnode/antigravity-runs/job-1",
            AiAutonomyLevel::Low,
            AiDirectorProvider::Antigravity,
            AiDirectorMode::Auto,
            AiDirectorInvolvement::FullReview,
            &[],
        );

        assert!(active.contains("AI Director provider: Antigravity"));
        assert!(active.contains(PAINTNODE_DIRECTOR_ACTION_FILE));
        assert!(active.contains(PAINTNODE_DIRECTOR_OBSERVATION_FILE));
        assert!(active.contains("Allowed PaintNode tool action: `generateCandidate`"));
        assert!(active.contains("Director review criteria"));
        assert!(!active.contains("Save the final image as"));
        assert!(!active.contains("Do not create `result.png`.\n- PNG only"));

        let plan_only = antigravity_generate_director_prompt(
            "sunlit beach photo",
            "paintnode/antigravity-runs/job-1",
            AiAutonomyLevel::Low,
            AiDirectorProvider::Antigravity,
            AiDirectorMode::Auto,
            AiDirectorInvolvement::PlanOnly,
            &[],
        );

        assert!(plan_only.contains("AI Director participation: Plan only"));
        assert!(plan_only.contains("Save the final image as"));
        assert!(!plan_only.contains(PAINTNODE_DIRECTOR_ACTION_FILE));
    }

    #[test]
    fn antigravity_prompts_require_result_file_without_codex_cache_contract() {
        let geometry_note = "PaintNode image geometry:\n- The attached images are a crop of a larger PaintNode document; PaintNode will paste your result back into the correct document region automatically.\n- The attached images already include finished content adjacent to the editable region. Match its content, lighting, perspective, and style so your result joins it seamlessly.\n\nContinuation rules for this crop:\n- Write the image-tool instruction yourself as a continuation instruction.";
        let retouch = antigravity_retouch_prompt(
            "remove glare",
            false,
            false,
            &[],
            "paintnode/antigravity-runs/job-1/part-2",
            AiAutonomyLevel::Low,
            geometry_note,
            true,
            true,
            &ai_exact_working_canvas((1386, 588), "21:9"),
        );
        assert!(retouch.contains("result.png"));
        assert!(retouch.contains("paintnode/antigravity-runs/job-1/part-2/source.png"));
        assert!(retouch.contains("paintnode/antigravity-runs/job-1/part-2/edit_target.png"));
        assert!(retouch.contains("paintnode/antigravity-runs/job-1/part-2/mask.png"));
        assert!(retouch.contains("paintnode/antigravity-runs/job-1/part-2/overview.png"));
        assert!(retouch.contains("paintnode/antigravity-runs/job-1/part-2/paintnode_contract.txt"));
        assert!(retouch.contains("a crop of a larger PaintNode document"));
        assert!(retouch.contains("your result joins it seamlessly"));
        assert!(retouch.contains("Continuation rules for this crop:"));
        // Prompts must not reveal document dimensions or the split structure
        // to the agent — it forwards prompt text to the image model.
        assert!(!retouch.contains("6000x480"));
        assert!(!retouch.contains("part 1 of"));
        assert!(!retouch.contains("document region x="));
        assert!(!retouch.contains("chroma"));
        assert!(!retouch.contains("#00ff00"));
        assert!(!retouch.contains("centered content rectangle"));
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
        // The agent must drive its image tool with the edit target as the
        // base image and the mask attached as a labeled second image, so the
        // model has a spatial anchor for the editable region.
        assert!(retouch.contains("Image-generation tool call:"));
        assert!(retouch.contains(
            "`paintnode/antigravity-runs/job-1/part-2/edit_target.png` as the base image"
        ));
        assert!(retouch.contains(
            "Also attach `paintnode/antigravity-runs/job-1/part-2/mask.png` as the second image"
        ));
        assert!(retouch.contains(
            "Never attach `paintnode/antigravity-runs/job-1/part-2/paintnode_contract.txt`"
        ));
        assert!(retouch.contains("same framing, same composition, same camera, same crop"));
        // Continuation parts hand the overview to the image model as a
        // scene-continuity reference and phrase the instruction as a
        // continuation, not as the requested change.
        assert!(retouch.contains(
            "Also attach `paintnode/antigravity-runs/job-1/part-2/overview.png` as the third image"
        ));
        assert!(retouch
            .contains("state how the editable area continues the neighboring finished content"));
        assert!(!retouch.contains("state the requested change"));
        // The tool parameters must target the model's real output grid: the
        // smallest tier covering the 1386x588 crop at "21:9" is 1K. The note
        // pins the parameters only — never literal output pixels, which the
        // agent could forward into the image-model instruction.
        assert!(retouch.contains("aspect ratio parameter to `21:9`"));
        assert!(retouch.contains("image size / resolution parameter to `1K`"));
        assert!(!retouch.contains("1584x672"));

        let single_retouch = antigravity_retouch_prompt(
            "remove glare",
            false,
            false,
            &[],
            "paintnode/antigravity-runs/job-1",
            AiAutonomyLevel::Low,
            "PaintNode image geometry:\n- The attached images are the full PaintNode document.",
            false,
            false,
            &ai_exact_working_canvas((1247, 696), "16:9"),
        );
        assert!(!single_retouch.contains("overview.png"));
        assert!(single_retouch.contains("the full PaintNode document"));
        assert!(single_retouch.contains("state the requested change"));

        let contract = antigravity_retouch_contract_text(
            "paintnode/antigravity-runs/job-1",
            AiAutonomyLevel::Low,
            "PaintNode image geometry:\n- The attached images are the full PaintNode document.",
        );
        assert!(contract
            .contains("Paste the result into the document region recorded in `placement.json`"));
        assert!(contract
            .contains("Resize a same-aspect result back to the exact submitted crop dimensions"));
        // The mask is attached as a separate editable layer mask, never baked
        // into the result pixels.
        assert!(contract.contains("attached as a separate linked mask layer"));
        assert!(contract.contains("never baked into your result pixels"));
        assert!(!contract.contains("Restore protected black-mask pixels"));
        assert!(contract.contains("Do not run Python, OpenCV, Pillow"));
        assert!(contract.contains("Do not keep working after"));
        assert!(!contract.contains("chroma"));
        assert!(!contract.contains("centered content rectangle"));

        let unmanaged_contract = antigravity_retouch_contract_text(
            "paintnode/antigravity-runs/job-1",
            AiAutonomyLevel::Unmanaged,
            "PaintNode image geometry:\n- The attached images are the full PaintNode document.",
        );
        assert!(unmanaged_contract
            .contains("Paste the result into the document region recorded in `placement.json`"));
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

        let fill = antigravity_fill_prompt(
            "add a boat",
            "paintnode/antigravity-runs/job-3",
            AiAutonomyLevel::Low,
            "PaintNode image geometry:\n- The attached images are a crop of a larger PaintNode document.",
            "",
            false,
            false,
            false,
            false,
            false,
            &[],
            &ai_exact_working_canvas((600, 600), "1:1"),
        );
        assert!(fill.contains("Image-generation tool call:"));
        assert!(fill.contains("`paintnode/antigravity-runs/job-3/source.png` as the base image"));
        assert!(fill.contains("Do not attach synthetic edit-target or mask images"));
        assert!(!fill.contains("edit_target.png"));
        assert!(!fill.contains("mask.png"));

        let storyboard_fill = antigravity_fill_prompt(
            "a beach photo in film style",
            "paintnode/antigravity-runs/job-4/part-1",
            AiAutonomyLevel::Low,
            "PaintNode image geometry:\n- The attached images are a crop of a larger PaintNode document.",
            "",
            true,
            false,
            true,
            true,
            false,
            &[],
            &ai_exact_working_canvas((1914, 812), "21:9"),
        );
        assert!(storyboard_fill.contains("PaintNode draft enhancement"));
        assert!(storyboard_fill.contains("source.png`: PaintNode edit frame to enhance"));
        assert!(storyboard_fill.contains("`paintnode/antigravity-runs/job-4/part-1/overview.png`"));
        assert!(storyboard_fill
            .contains("Also attach `paintnode/antigravity-runs/job-4/part-1/overview.png`"));
        assert!(storyboard_fill.contains("never use `overview.png` as the source or base image"));
        assert!(storyboard_fill.contains("never reproduce the red outline"));
        assert!(storyboard_fill.contains("image enhancement/restoration pass at the same size"));
        assert!(storyboard_fill.contains("Do not add, remove, duplicate, replace, move"));
        assert!(storyboard_fill.contains("Do not attach storyboard draft files"));
        assert!(!storyboard_fill.contains("edit_target.png"));
        assert!(!storyboard_fill.contains("mask.png"));
        assert!(!storyboard_fill.contains("storyboard-draft-crop.png"));
        assert!(!storyboard_fill.contains("Orchestrator"));
        assert!(!storyboard_fill.contains("beach photo in film style"));
        assert!(!storyboard_fill.contains("beach anchor"));
        assert!(!storyboard_fill.contains("Original user fill prompt"));
        assert!(!storyboard_fill.contains("Global style rules"));
        assert!(!storyboard_fill.contains("part 1 of"));
    }
}
