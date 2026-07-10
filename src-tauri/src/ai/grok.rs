//! Grok (xAI) provider: decoupled direct image backend executor.
//!
//! Image generation is "decoupled" from the `grok` CLI: PaintNode reads the
//! CLI's stored OAuth token from `~/.grok/auth.json` and POSTs directly to the
//! public xAI Images API (`/v1/images/generations`), the same way the
//! Antigravity provider calls Google's image backend. No xAI API key is needed;
//! the CLI's own login is reused. Running any `grok` command refreshes the
//! token file in place, so `grok models` is used to wake/refresh auth.
//!
//! Scope: text-to-image generation. Image editing (image-to-image) and video
//! are documented in `docs/grok-future-expansion.md` for a later pass.

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
use std::time::Instant;
use std::time::SystemTime;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64_URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::blocking::Client;
use serde::Deserialize;
use serde_json::json;
use tauri::AppHandle;

use crate::ai::canvas::{
    ai_grok_image_capability, validate_optional_target_dimensions,
};
use crate::ai::placement::cover_crop_png_to_dimensions;
use crate::ai::{
    ai_run_cancelled, apply_ai_cli_environment, clean_option, clear_ai_run_cancelled,
    cleanup_project_agent_job, emit_codex_progress, emit_job_file_progress, emit_kept_job_dir,
    now_id, project_or_temp_job_path, should_keep_job_dir, spawn_output_reader, watched_job_files,
    write_ai_job_prompt, write_ai_job_settings, AgentRunResult, AiModelCapability,
    AiProviderCapabilitiesResult, AiProviderFeatureCapabilities, CodexDetectionResult,
    GeneratedImageResult, WorkflowSourceImage, AI_RUN_STOPPED_MESSAGE, POLL_INTERVAL,
};
use crate::png::{encode_rgba_png, is_png, png_data_url, png_dimensions_from_bytes};
use crate::project::{add_asset, write_asset_file, ProjectAsset};

/// Fixed xAI image model used by Grok Build's `image_gen` tool. The `grok
/// models` CLI listing advertises chat/coding models (used for the Director),
/// not image models, so the image model is a constant here.
const DEFAULT_GROK_IMAGE_MODEL: &str = "grok-imagine-image-quality";
/// Default output resolution tier sent to the xAI Images API.
const GROK_IMAGE_RESOLUTION: &str = "1k";
const GROK_IMAGE_REQUEST_FILE: &str = "paintnode-grok-image-request.json";
const GROK_IMAGE_RESPONSE_FILE: &str = "paintnode-grok-image-response.json";
const GROK_FALLBACK_CLI_VERSION: &str = "0.2.93";

/// `~/.grok/auth.json` — the CLI's OIDC credential store.
fn grok_auth_json_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".grok").join("auth.json"))
}

#[derive(Debug, Deserialize)]
struct GrokStoredRecord {
    key: Option<String>,
}

#[derive(Debug)]
struct GrokAuthToken {
    access_token: String,
    /// Unix seconds parsed from the JWT `exp` claim, when present.
    expiry_unix: Option<i64>,
}

/// Read the access token (and its expiry) from `~/.grok/auth.json`. The file is
/// a JSON object keyed by `"<issuer>::<client_id>"`; the account record's `key`
/// field is the bearer JWT. Prefer the `auth.x.ai` record if several exist.
fn load_grok_auth_token() -> Result<GrokAuthToken, String> {
    let path = grok_auth_json_path()
        .ok_or_else(|| "Could not locate the Grok auth file (HOME is unset).".to_string())?;
    let text = fs::read_to_string(&path).map_err(|e| {
        format!(
            "Could not read the Grok login at {}: {e}. Run `grok` in Terminal and sign in, then try again.",
            path.display()
        )
    })?;
    let records: std::collections::HashMap<String, GrokStoredRecord> =
        serde_json::from_str(&text).map_err(|e| format!("Grok auth file is not valid JSON: {e}"))?;
    let token = records
        .iter()
        .find(|(host, record)| host.contains("auth.x.ai") && record.key.is_some())
        .or_else(|| records.iter().find(|(_, record)| record.key.is_some()))
        .and_then(|(_, record)| record.key.clone())
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
        .ok_or_else(|| {
            "Grok auth file has no access token. Run `grok` in Terminal and sign in, then try again."
                .to_string()
        })?;
    let expiry_unix = grok_jwt_expiry_unix(&token);
    Ok(GrokAuthToken {
        access_token: token,
        expiry_unix,
    })
}

/// Decode the `exp` claim (unix seconds) from a JWT without verifying it.
fn grok_jwt_expiry_unix(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let decoded = BASE64_URL_SAFE_NO_PAD.decode(payload.as_bytes()).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    claims.get("exp").and_then(|value| value.as_i64())
}

fn grok_token_needs_refresh(token: &GrokAuthToken, now_unix: i64, margin_secs: i64) -> bool {
    match token.expiry_unix {
        Some(expiry) => expiry <= now_unix + margin_secs,
        None => false,
    }
}

fn now_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn configured_or_default_grok_bin(bin: Option<String>) -> Result<String, String> {
    if let Some(bin) = bin.map(|value| value.trim().to_string()).filter(|v| !v.is_empty()) {
        return Ok(bin);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        "grok".to_string(),
        format!("{home}/.local/bin/grok"),
        format!("{home}/.grok/bin/grok"),
        "/opt/homebrew/bin/grok".to_string(),
        "/usr/local/bin/grok".to_string(),
    ];
    for candidate in candidates {
        let mut command = Command::new(&candidate);
        apply_ai_cli_environment(&mut command).arg("--version");
        if command.output().map(|output| output.status.success()).unwrap_or(false) {
            return Ok(candidate);
        }
    }
    Err("Grok CLI was not found. Install Grok Build, or enter the full path to the `grok` binary."
        .into())
}

fn grok_version_from_output(text: &str) -> Option<String> {
    text.split_whitespace().find_map(|token| {
        let token = token.trim().trim_start_matches('v');
        let start = token.find(|ch: char| ch.is_ascii_digit())?;
        let version =
            token[start..].trim_matches(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '.'));
        version.chars().any(|ch| ch.is_ascii_digit()).then(|| version.to_string())
    })
}

fn grok_cli_version(grok_bin: &str) -> String {
    let mut command = Command::new(grok_bin);
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
    grok_version_from_output(&text).unwrap_or_else(|| GROK_FALLBACK_CLI_VERSION.into())
}

fn grok_image_user_agent(version: &str) -> String {
    format!("xai-grok-build/{version}")
}

/// Run `grok models` so the CLI refreshes its stored OAuth token in place. This
/// is the "mint/refresh" trigger before the token is re-read from disk.
fn wake_grok_auth(grok_bin: &str) -> Result<(), String> {
    let mut command = Command::new(grok_bin);
    apply_ai_cli_environment(&mut command).arg("models");
    let output = command
        .output()
        .map_err(|e| format!("Failed to launch the Grok auth helper at '{grok_bin}': {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            stdout.trim().to_string()
        };
        Err(format!(
            "Grok auth helper failed. Run `grok` in Terminal and sign in, then try again.\n\n{detail}"
        ))
    }
}

fn grok_image_http_client(user_agent: &str) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(300))
        .user_agent(user_agent.to_string())
        .build()
        .map_err(|e| format!("Failed to create the Grok image HTTP client: {e}"))
}

#[derive(Debug)]
struct GrokImageRequestSpec {
    prompt: String,
    aspect_ratio: Option<String>,
}

/// Build the OpenAI-compatible xAI Images request body. Output shape is conveyed
/// only through `aspect_ratio` + `resolution` parameters — never pixel geometry
/// in the prompt (see AGENTS.md).
fn grok_image_request_json(spec: &GrokImageRequestSpec, image_model: &str) -> serde_json::Value {
    json!({
        "model": image_model,
        "prompt": spec.prompt,
        "n": 1,
        "aspect_ratio": spec.aspect_ratio.as_deref().unwrap_or("1:1"),
        "resolution": GROK_IMAGE_RESOLUTION,
        "response_format": "b64_json",
    })
}

fn grok_images_endpoint() -> String {
    std::env::var("PAINTNODE_GROK_IMAGE_BASE_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "https://api.x.ai".into())
        + "/v1/images/generations"
}

fn post_grok_image_request(
    client: &Client,
    token: &GrokAuthToken,
    version: &str,
    request_body: &serde_json::Value,
) -> Result<(reqwest::StatusCode, String), String> {
    let response = client
        .post(grok_images_endpoint())
        .bearer_auth(token.access_token.trim())
        .header("x-grok-client-version", version)
        .json(request_body)
        .send()
        .map_err(|e| {
            let mut message = format!("Grok image generation request failed: {e}");
            if e.is_timeout() {
                message.push_str("\n\nThe request timed out while contacting xAI. Check the network connection, VPN/proxy, then retry.");
            } else if e.is_connect() {
                message.push_str("\n\nPaintNode could not connect to xAI. Check the network connection, VPN/proxy, and firewall, then retry.");
            }
            message
        })?;
    let status = response.status();
    let text = response
        .text()
        .map_err(|e| format!("Grok image generation response could not be read: {e}"))?;
    Ok((status, text))
}

#[derive(Debug, Deserialize)]
struct GrokImagesResponse {
    #[serde(default)]
    data: Vec<GrokImageDatum>,
}

#[derive(Debug, Deserialize)]
struct GrokImageDatum {
    b64_json: Option<String>,
    #[allow(dead_code)]
    mime_type: Option<String>,
}

/// Extract the first image from an xAI Images response and return PNG bytes.
fn decode_grok_images_response(text: &str) -> Result<Vec<u8>, String> {
    let parsed: GrokImagesResponse = serde_json::from_str(text)
        .map_err(|e| format!("Grok image generation returned an unreadable response: {e}"))?;
    let datum = parsed
        .data
        .into_iter()
        .find(|datum| datum.b64_json.as_deref().is_some_and(|b| !b.trim().is_empty()))
        .ok_or_else(|| "Grok image generation returned no image data.".to_string())?;
    let b64 = datum.b64_json.unwrap_or_default();
    let bytes = BASE64_STANDARD
        .decode(b64.trim().as_bytes())
        .map_err(|e| format!("Grok image generation returned invalid base64 image data: {e}"))?;
    grok_image_bytes_to_png(&bytes, datum.mime_type.as_deref())
}

/// The xAI Images API returns JPEG by default; PaintNode works in PNG, so
/// re-encode anything that is not already PNG.
fn grok_image_bytes_to_png(bytes: &[u8], mime_type: Option<&str>) -> Result<Vec<u8>, String> {
    if is_png(bytes) {
        return Ok(bytes.to_vec());
    }
    let image = image::load_from_memory(bytes)
        .map_err(|e| {
            let mime = mime_type.unwrap_or("unknown");
            format!("Grok image generation returned unsupported image data ({mime}): {e}")
        })?
        .to_rgba8();
    encode_rgba_png(image, "Grok generated image")
}

/// Map a pixel target to the nearest xAI-supported aspect-ratio label (by
/// log-ratio error), so the shape is expressed as a parameter, not geometry.
fn grok_closest_aspect_label(dimensions: (u32, u32)) -> Option<String> {
    let target_ratio = dimensions.0 as f64 / dimensions.1 as f64;
    ai_grok_image_capability()
        .aspect_ratios
        .iter()
        .min_by(|a, b| {
            let a_error = ((a.width as f64 / a.height as f64) / target_ratio).ln().abs();
            let b_error = ((b.width as f64 / b.height as f64) / target_ratio).ln().abs();
            a_error.partial_cmp(&b_error).unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|ratio| ratio.label.clone())
}

fn remove_grok_debug_artifacts(job_path: &Path) {
    for file_name in [GROK_IMAGE_REQUEST_FILE, GROK_IMAGE_RESPONSE_FILE] {
        let _ = fs::remove_file(job_path.join(file_name));
    }
}

/// Authenticate, POST to the xAI Images API, and return decoded PNG bytes.
fn run_grok_direct_image(
    app: &AppHandle,
    run_id: &str,
    grok_bin: &str,
    job_path: &Path,
    spec: GrokImageRequestSpec,
    image_model: &str,
    keep_debug_artifacts: bool,
) -> Result<Vec<u8>, String> {
    if ai_run_cancelled(run_id) {
        return Err(AI_RUN_STOPPED_MESSAGE.into());
    }
    if !keep_debug_artifacts {
        remove_grok_debug_artifacts(job_path);
    }
    emit_codex_progress(app, run_id, "Authenticating Grok account");
    wake_grok_auth(grok_bin)?;
    let mut token = load_grok_auth_token()?;
    if grok_token_needs_refresh(&token, now_unix_seconds(), 120) {
        wake_grok_auth(grok_bin)?;
        token = load_grok_auth_token()?;
    }

    let version = grok_cli_version(grok_bin);
    let request_body = grok_image_request_json(&spec, image_model);
    if keep_debug_artifacts {
        if let Ok(pretty) = serde_json::to_vec_pretty(&request_body) {
            let _ = fs::write(job_path.join(GROK_IMAGE_REQUEST_FILE), pretty);
        }
    }
    if ai_run_cancelled(run_id) {
        return Err(AI_RUN_STOPPED_MESSAGE.into());
    }

    let client = grok_image_http_client(&grok_image_user_agent(&version))?;
    emit_codex_progress(app, run_id, "Calling the Grok image backend");
    let (mut status, mut text) = post_grok_image_request(&client, &token, &version, &request_body)?;
    if status.as_u16() == 401 || status.as_u16() == 403 {
        emit_codex_progress(app, run_id, "Refreshing Grok auth after backend rejection");
        wake_grok_auth(grok_bin)?;
        token = load_grok_auth_token()?;
        let retry = post_grok_image_request(&client, &token, &version, &request_body)?;
        status = retry.0;
        text = retry.1;
    }
    if keep_debug_artifacts {
        let _ = fs::write(job_path.join(GROK_IMAGE_RESPONSE_FILE), &text);
    }
    if ai_run_cancelled(run_id) {
        return Err(AI_RUN_STOPPED_MESSAGE.into());
    }
    if !status.is_success() {
        return Err(grok_image_http_error_message(status, &text));
    }
    decode_grok_images_response(&text)
}

fn grok_image_http_error_message(status: reqwest::StatusCode, text: &str) -> String {
    // xAI returns `{ "code", "error", "usage" }` on failure; surface the error.
    let detail = serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| text.trim().chars().take(400).collect());
    let lower = detail.to_ascii_lowercase();
    if lower.contains("moderation") {
        return format!(
            "Grok blocked this prompt during content moderation. Try a different prompt.\n\n{detail}"
        );
    }
    if status.as_u16() == 403 || lower.contains("supergrok") || lower.contains("upgrade") {
        return format!(
            "Grok image generation requires a SuperGrok subscription.\n\n{detail}"
        );
    }
    format!("Grok image generation failed (HTTP {}).\n\n{detail}", status.as_u16())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn generate_grok_image(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    keep_job_dir: Option<bool>,
    keep_debug_artifacts: Option<bool>,
    reference_pngs: Vec<WorkflowSourceImage>,
    run_id: String,
    image_model: Option<String>,
    target_width: Option<u32>,
    target_height: Option<u32>,
) -> Result<GeneratedImageResult, String> {
    if prompt.trim().is_empty() {
        return Err("Enter a prompt.".into());
    }
    if !reference_pngs.is_empty() {
        return Err("Grok reference images require image editing, which is coming soon. Remove the references, or use Antigravity or Codex for reference-guided edits.".into());
    }
    let target_dimensions = validate_optional_target_dimensions(target_width, target_height)?;

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let grok_bin = configured_or_default_grok_bin(bin)?;
        let image_model = image_model
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_GROK_IMAGE_MODEL.to_string());
        let keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        let run_id = if run_id.trim().is_empty() {
            format!("grok-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let (project_dir, _job_project_dir, job_path, cleanup_project_job, _temp_job) =
            project_or_temp_job_path(&app, &project_path, "grok", &run_id, keep_job_dir)?;

        let aspect_ratio = target_dimensions.and_then(grok_closest_aspect_label);
        write_ai_job_settings(
            &job_path,
            json!({
                "version": 1,
                "workflow": "generate_image",
                "runId": run_id,
                "provider": "Grok",
                "imageGenerator": {
                    "provider": "Grok",
                    "model": image_model,
                    "aspectRatio": aspect_ratio,
                    "resolution": GROK_IMAGE_RESOLUTION,
                },
                "targetDimensions": target_dimensions
                    .map(|(width, height)| json!({ "width": width, "height": height })),
                "keepJobDir": keep_job_dir,
                "debugArtifacts": keep_debug_artifacts,
            }),
        )?;
        write_ai_job_prompt(&job_path, prompt.trim(), "Grok image generation")?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);

        let result_path = job_path.join("result.png");
        // Reuse a salvaged result from a previous attempt instead of paying for
        // another generation.
        let salvaged = fs::read(&result_path)
            .ok()
            .filter(|bytes| is_png(bytes) && png_dimensions_from_bytes(bytes).is_some());
        let raw_bytes = if let Some(bytes) = salvaged {
            emit_codex_progress(&app, &run_id, "Reusing the previously generated image");
            bytes
        } else {
            let _ = fs::remove_file(&result_path);
            emit_codex_progress(&app, &run_id, "Generating through the Grok image backend");
            let bytes = run_grok_direct_image(
                &app,
                &run_id,
                &grok_bin,
                &job_path,
                GrokImageRequestSpec {
                    prompt: prompt.trim().to_string(),
                    aspect_ratio: aspect_ratio.clone(),
                },
                &image_model,
                keep_debug_artifacts,
            )?;
            fs::write(&result_path, &bytes)
                .map_err(|e| format!("Failed to write Grok image result: {e}"))?;
            png_dimensions_from_bytes(&bytes)
                .ok_or_else(|| "Grok image PNG dimensions are invalid.".to_string())?;
            bytes
        };

        // Cover-crop the model output to the requested pixel dimensions.
        let bytes = if let Some(target) = target_dimensions {
            let (bytes, source_dimensions, _upscale) =
                cover_crop_png_to_dimensions(&raw_bytes, target, "Grok generated image")?;
            if source_dimensions != target {
                emit_codex_progress(
                    &app,
                    &run_id,
                    format!(
                        "Cover-cropped Grok result from {}x{} to {}x{}",
                        source_dimensions.0, source_dimensions.1, target.0, target.1
                    ),
                );
            }
            bytes
        } else {
            raw_bytes
        };

        let data_url = png_data_url(&bytes)?;
        let asset = if let Some(project_dir) = project_dir {
            emit_codex_progress(&app, &run_id, "Saving Grok image to the project");
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

// ---------------------------------------------------------------------------
// Detection + capabilities (Director model list comes from `grok models`)
// ---------------------------------------------------------------------------

fn grok_provider_features() -> AiProviderFeatureCapabilities {
    // Grok as a Director drives the local `grok` CLI with structured
    // streaming-json events (thought/text/end), and supports `--json-schema`
    // structured output and session reuse via `--session-id`/`--resume`.
    AiProviderFeatureCapabilities {
        transport: "cli".into(),
        session_reuse: true,
        structured_output: true,
        app_mediated_user_input: false,
        autonomous_subagents: true,
        managed_subagents: false,
        structured_progress: true,
    }
}

#[tauri::command]
pub(crate) async fn detect_grok(bin: Option<String>) -> Result<CodexDetectionResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> CodexDetectionResult {
        let grok_bin = match configured_or_default_grok_bin(bin) {
            Ok(path) => path,
            Err(error) => {
                return CodexDetectionResult {
                    found: false,
                    path: None,
                    version: None,
                    error: Some(error),
                }
            }
        };
        match wake_grok_auth(&grok_bin) {
            Ok(()) => CodexDetectionResult {
                found: true,
                path: Some(grok_bin.clone()),
                version: Some(format!("Grok {}", grok_cli_version(&grok_bin))),
                error: None,
            },
            Err(error) => CodexDetectionResult {
                found: false,
                path: Some(grok_bin),
                version: None,
                error: Some(error),
            },
        }
    })
    .await
    .map_err(|e| format!("Task error: {e}"))
}

fn grok_capability_model(id: &str, label: &str, is_default: bool) -> AiModelCapability {
    AiModelCapability {
        id: id.into(),
        label: label.into(),
        description: None,
        supported_reasoning_efforts: Vec::new(),
        default_reasoning_effort: None,
        is_default,
    }
}

fn fallback_grok_capabilities(warning: Option<String>) -> AiProviderCapabilitiesResult {
    let models = vec![
        grok_capability_model("grok-4.5", "Grok 4.5", true),
        grok_capability_model("grok-composer-2.5-fast", "Composer 2.5", false),
    ];
    AiProviderCapabilitiesResult {
        models,
        source: "fallback".into(),
        warning,
        features: grok_provider_features(),
    }
}

/// Parse `grok models` stdout. Model lines look like `  * grok-4.5 (default)`
/// or `  - grok-composer-2.5-fast`.
fn parse_grok_capabilities(text: &str) -> Result<AiProviderCapabilitiesResult, String> {
    let mut models = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("* ").or_else(|| trimmed.strip_prefix("- ")) else {
            continue;
        };
        let is_default = rest.contains("(default)");
        let id = rest
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if id.is_empty() {
            continue;
        }
        let label = id
            .strip_prefix("grok-")
            .unwrap_or(&id)
            .replace('-', " ");
        models.push(grok_capability_model(&id, &label, is_default));
    }
    if models.is_empty() {
        return Err("Grok did not advertise any available models.".into());
    }
    if !models.iter().any(|model| model.is_default) {
        if let Some(first) = models.first_mut() {
            first.is_default = true;
        }
    }
    Ok(AiProviderCapabilitiesResult {
        models,
        source: "cli".into(),
        warning: None,
        features: grok_provider_features(),
    })
}

#[tauri::command]
pub(crate) async fn discover_grok_capabilities(
    bin: Option<String>,
) -> Result<AiProviderCapabilitiesResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let grok_bin = match configured_or_default_grok_bin(bin) {
            Ok(bin) => bin,
            Err(error) => return fallback_grok_capabilities(Some(error)),
        };
        let mut command = Command::new(&grok_bin);
        apply_ai_cli_environment(&mut command).arg("models");
        match command.output() {
            Ok(output) if output.status.success() => {
                parse_grok_capabilities(&String::from_utf8_lossy(&output.stdout))
                    .unwrap_or_else(|error| fallback_grok_capabilities(Some(error)))
            }
            Ok(output) => {
                let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
                fallback_grok_capabilities(Some(format!("Grok capability discovery failed. {detail}")))
            }
            Err(error) => fallback_grok_capabilities(Some(format!(
                "Failed to launch Grok capability discovery: {error}"
            ))),
        }
    })
    .await
    .map_err(|error| format!("Grok capability task failed: {error}"))
}

// ---------------------------------------------------------------------------
// AI Director: drive the local `grok` CLI through the shared job-folder protocol
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct GrokDirectorOptions {
    model: Option<String>,
}

fn grok_director_options(model: Option<String>) -> GrokDirectorOptions {
    GrokDirectorOptions {
        model: clean_option(model).filter(|value| value != "auto"),
    }
}

/// The Grok Director agent runs single-turn in the job folder: it reads
/// `prompt.txt` / the observation, then writes `paintnode-director-action.json`.
/// `--always-approve` lets its file tools run unattended; streaming-json output
/// carries the `end` event whose `sessionId` we reuse across turns.
fn build_grok_director_command(
    grok_bin: &str,
    job_path: &Path,
    prompt: &str,
    options: &GrokDirectorOptions,
    session_id: Option<&str>,
) -> Command {
    let mut command = Command::new(grok_bin);
    apply_ai_cli_environment(&mut command);
    command.current_dir(job_path);
    command.arg("--output-format").arg("streaming-json");
    command.arg("--always-approve");
    command.arg("--disable-web-search");
    if let Some(model) = options.model.as_deref() {
        command.arg("--model").arg(model);
    }
    if let Some(session_id) = session_id {
        command.arg("--resume").arg(session_id);
    }
    command.arg("-p").arg(prompt.trim());
    command
}

/// The last `end` event's `sessionId` (a UUID) for session reuse.
fn grok_session_id_from_output(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let mut found = None;
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("end") {
            if let Some(session_id) = value
                .get("sessionId")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                found = Some(session_id.to_string());
            }
        }
    }
    found
}

/// Concatenate all `text` events into the Director's final message (used only to
/// enrich error output when the action file is missing).
pub(crate) fn final_grok_agent_message(output: &Output) -> Option<String> {
    let text = String::from_utf8_lossy(&output.stdout);
    let mut buffer = String::new();
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) == Some("text") {
            if let Some(data) = value.get("data").and_then(|v| v.as_str()) {
                buffer.push_str(data);
            }
        }
    }
    let trimmed = buffer.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn run_grok_with_progress(
    command: &mut Command,
    app: AppHandle,
    run_id: String,
    job_path: &Path,
) -> Result<AgentRunResult, String> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to launch Grok: {e}"))?;

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
            "Grok".into(),
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
            "Grok".into(),
        ));
    }

    let mut last_file_poll = Instant::now();
    let mut file_snapshot = watched_job_files(job_path);
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("Failed to wait for Grok: {e}"))?
        {
            emit_job_file_progress(&app, &run_id, "Grok", job_path, &mut file_snapshot, None);
            break status;
        }
        if last_file_poll.elapsed() >= Duration::from_millis(1000) {
            emit_job_file_progress(&app, &run_id, "Grok", job_path, &mut file_snapshot, None);
            last_file_poll = Instant::now();
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
    let stdout = stdout.lock().map(|bytes| bytes.clone()).unwrap_or_default();
    let stderr = stderr.lock().map(|bytes| bytes.clone()).unwrap_or_default();
    let session_id = grok_session_id_from_output(&stdout);
    Ok(AgentRunResult {
        output: Output {
            status,
            stdout,
            stderr,
        },
        thread_id: session_id,
        satisfied_required_output: false,
    })
}

/// Run one Director turn on the Grok CLI. `bin`/`model` are optional overrides;
/// when omitted, the default `grok` binary and model are used.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_grok_director_request(
    app: &AppHandle,
    run_id: &str,
    bin: Option<String>,
    model: Option<String>,
    _keep_debug_artifacts: bool,
    job_path: &Path,
    prompt: &str,
    session_id: Option<&str>,
) -> Result<AgentRunResult, String> {
    let grok_bin = configured_or_default_grok_bin(bin)?;
    // Ensure the CLI's stored token is fresh before it calls the model.
    wake_grok_auth(&grok_bin)?;
    let options = grok_director_options(model);
    let mut command = build_grok_director_command(&grok_bin, job_path, prompt, &options, session_id);
    run_grok_with_progress(&mut command, app.clone(), run_id.to_string(), job_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_grok_auth_token_reads_key_and_expiry() {
        // exp = 4102444800 (2100-01-01); base64url payload of {"exp":4102444800}
        let payload = BASE64_URL_SAFE_NO_PAD.encode(br#"{"exp":4102444800}"#);
        let jwt = format!("hdr.{payload}.sig");
        let json = format!(
            r#"{{"https://auth.x.ai::client":{{"key":"{jwt}","refresh_token":"r"}}}}"#
        );
        let records: std::collections::HashMap<String, GrokStoredRecord> =
            serde_json::from_str(&json).unwrap();
        let key = records.values().find_map(|r| r.key.clone()).unwrap();
        assert_eq!(grok_jwt_expiry_unix(&key), Some(4102444800));
    }

    #[test]
    fn token_needs_refresh_when_expired_or_near() {
        let token = GrokAuthToken {
            access_token: "t".into(),
            expiry_unix: Some(1000),
        };
        assert!(grok_token_needs_refresh(&token, 900, 120)); // 900+120 >= 1000
        assert!(!grok_token_needs_refresh(&token, 700, 120)); // 700+120 < 1000
        let no_expiry = GrokAuthToken {
            access_token: "t".into(),
            expiry_unix: None,
        };
        assert!(!grok_token_needs_refresh(&no_expiry, 999_999, 120));
    }

    #[test]
    fn request_body_carries_no_pixel_geometry() {
        let spec = GrokImageRequestSpec {
            prompt: "a red apple on a table".into(),
            aspect_ratio: Some("16:9".into()),
        };
        let body = grok_image_request_json(&spec, DEFAULT_GROK_IMAGE_MODEL);
        let text = serde_json::to_string(&body).unwrap();
        assert!(text.contains("\"aspect_ratio\":\"16:9\""));
        assert!(text.contains("\"resolution\":\"1k\""));
        assert!(!text.contains("1024"));
        assert!(!text.contains('x')); // no "1024x768"-style geometry
    }

    #[test]
    fn decode_response_extracts_first_b64_png() {
        // 1x1 transparent PNG
        let png = BASE64_STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
            .unwrap();
        let b64 = BASE64_STANDARD.encode(&png);
        let text = format!(r#"{{"data":[{{"b64_json":"{b64}","mime_type":"image/png"}}]}}"#);
        let out = decode_grok_images_response(&text).unwrap();
        assert!(is_png(&out));
    }

    #[test]
    fn parse_capabilities_reads_model_lines() {
        let text = "You are logged in.\n\nAvailable models:\n  * grok-4.5 (default)\n  - grok-composer-2.5-fast\n";
        let caps = parse_grok_capabilities(text).unwrap();
        assert_eq!(caps.models.len(), 2);
        assert_eq!(caps.models[0].id, "grok-4.5");
        assert!(caps.models[0].is_default);
        assert_eq!(caps.source, "cli");
    }
}
