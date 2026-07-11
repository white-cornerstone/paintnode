//! Grok (xAI) provider: decoupled direct image backend executor.
//!
//! Image generation is "decoupled" from the `grok` CLI: PaintNode reads the
//! CLI's stored OAuth token from `~/.grok/auth.json` and POSTs directly to the
//! public xAI Images API (`/v1/images/generations`), the same way the
//! Antigravity provider calls Google's image backend. No xAI API key is needed;
//! the CLI's own login is reused. Running any `grok` command refreshes the
//! token file in place, so `grok models` is used to wake/refresh auth.
//!
//! Scope: text-to-image generation (`/v1/images/generations`) plus masked
//! image editing (`/v1/images/edits`) for fill, retouch, upscale/restore, and
//! multi-asset workflow composition. Video is documented in
//! `docs/grok-future-expansion.md` for a later pass.

use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Output;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
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
    ai_candidate_rejection, ai_edit_checks_level, ai_grok_image_capability,
    ai_retouch_editable_mask_png, grok_output_target, read_png_bytes_cropped_to_ai_working_canvas,
    remove_rejected_ai_candidate, validate_optional_target_dimensions, AiWorkingCanvas,
    AI_PROTECTED_DRIFT_MAX_ATTEMPTS, AI_RETOUCH_OUTPUT_MASK_FEATHER_RADIUS,
    AI_RETOUCH_OUTPUT_MASK_GROW_RADIUS, AI_SEAM_RETRY_NOTE,
};
use crate::ai::placement::{
    ai_part_geometry_note, ai_part_progress_message, ai_part_prompt_context,
    ai_upscale_target_dimensions, correct_part_result_drift, cover_crop_png_to_dimensions,
    fill_part_needs_overview, fill_placement_returns_layer_results, plan_ai_edit_placement,
    plan_ai_fill_placement, plan_ai_restore_placement, plan_ai_upscale_placement,
    prepare_ai_job_dir_for_placement, resize_png_to_dimensions, reuse_part_result, AiEditComposer,
    AiEditProvider, AiFillMethod, AiFillRedundancy, AI_RESTORE_UPSCALE_THRESHOLD,
};
use crate::ai::{
    ai_provider_features, ai_retouch_asset_name, ai_run_cancelled, apply_ai_cli_environment,
    clean_option, cleanup_project_agent_job, clear_ai_run_cancelled, command_failure,
    emit_codex_part_progress, emit_codex_progress, emit_job_file_progress, emit_kept_job_dir,
    now_id, output_tail, project_or_temp_job_path, remove_legacy_generative_fill_agent_inputs,
    should_keep_job_dir, spawn_output_reader, validate_reference_pngs, watched_job_files,
    write_ai_job_prompt, write_ai_job_settings, write_reference_pngs, AgentRunResult,
    AiDirectorProvider, AiModelCapability, AiProviderCapabilitiesResult, CodexDetectionResult,
    GeneratedImageLayerResult, GeneratedImageResult, WorkflowSourceImage, AI_RUN_STOPPED_MESSAGE,
    GROK_RUNS_DIR, POLL_INTERVAL,
};
use crate::png::{encode_rgba_png, is_png, png_data_url, png_dimensions_from_bytes};
use crate::project::{safe_stem, store_generated_png_asset};

/// Fixed xAI image model used by Grok Build's `image_gen` tool. The `grok
/// models` CLI listing advertises chat/coding models (used for the Director),
/// not image models, so the image model is a constant here.
const DEFAULT_GROK_IMAGE_MODEL: &str = "grok-imagine-image";
/// Default output resolution tier sent to the xAI Images API.
const GROK_IMAGE_RESOLUTION: &str = "1k";
const GROK_IMAGE_REQUEST_FILE: &str = "paintnode-grok-image-request.json";
const GROK_IMAGE_RESPONSE_FILE: &str = "paintnode-grok-image-response.json";
const GROK_EDIT_REQUEST_FILE: &str = "paintnode-grok-edit-request.json";
const GROK_EDIT_RESPONSE_FILE: &str = "paintnode-grok-edit-response.json";
const GROK_FALLBACK_CLI_VERSION: &str = "0.2.93";
/// The xAI edits endpoint references attached images as `<IMAGE_0>`,
/// `<IMAGE_1>`, ... in the prompt; treat three as the practical maximum.
const GROK_MAX_EDIT_REFERENCE_IMAGES: usize = 3;

/// `~/.grok/auth.json` — the CLI's OIDC credential store.
fn grok_auth_json_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".grok").join("auth.json"))
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
    grok_token_from_auth_json(&text)
}

/// Only credential records (objects with a non-empty `key` string) are read;
/// unrelated top-level entries the CLI may add later are ignored. Records are
/// scanned in sorted-key order so the choice is deterministic.
fn grok_token_from_auth_json(text: &str) -> Result<GrokAuthToken, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("Grok auth file is not valid JSON: {e}"))?;
    let mut records: Vec<(&String, &str)> = value
        .as_object()
        .map(|object| {
            object
                .iter()
                .filter_map(|(host, record)| {
                    record
                        .get("key")
                        .and_then(|key| key.as_str())
                        .map(str::trim)
                        .filter(|key| !key.is_empty())
                        .map(|key| (host, key))
                })
                .collect()
        })
        .unwrap_or_default();
    records.sort_by(|a, b| a.0.cmp(b.0));
    let token = records
        .iter()
        .find(|(host, _)| host.contains("auth.x.ai"))
        .or_else(|| records.first())
        .map(|(_, key)| key.to_string())
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

/// Use the stored token while it is still valid; only spawn the CLI refresh
/// (`grok models`, a network round-trip) when it is missing or near expiry.
/// The 401/403 retry in the request runner covers stale-token races.
fn fresh_grok_auth_token(grok_bin: &str) -> Result<GrokAuthToken, String> {
    match load_grok_auth_token() {
        Ok(token) if !grok_token_needs_refresh(&token, now_unix_seconds(), 120) => Ok(token),
        _ => {
            wake_grok_auth(grok_bin)?;
            load_grok_auth_token()
        }
    }
}

fn configured_or_default_grok_bin(bin: Option<String>) -> Result<String, String> {
    if let Some(bin) = bin
        .map(|value| value.trim().to_string())
        .filter(|v| !v.is_empty())
    {
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
        if command
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
        {
            return Ok(candidate);
        }
    }
    Err(
        "Grok CLI was not found. Install Grok Build, or enter the full path to the `grok` binary."
            .into(),
    )
}

fn grok_version_from_output(text: &str) -> Option<String> {
    text.split_whitespace().find_map(|token| {
        let token = token.trim().trim_start_matches('v');
        let start = token.find(|ch: char| ch.is_ascii_digit())?;
        let version =
            token[start..].trim_matches(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '.'));
        version
            .chars()
            .any(|ch| ch.is_ascii_digit())
            .then(|| version.to_string())
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
        let stderr = output_tail(&output.stderr);
        let detail = if !stderr.is_empty() {
            stderr
        } else {
            output_tail(&output.stdout)
        };
        Err(format!(
            "Grok auth helper failed. Run `grok` in Terminal and sign in, then try again.\n\n{detail}"
        ))
    }
}

/// Shared blocking client so repeated generations reuse connections instead of
/// paying a fresh TLS handshake (and client runtime) per image.
fn grok_image_http_client() -> Result<&'static Client, String> {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Failed to create the Grok image HTTP client: {e}"))?;
    Ok(CLIENT.get_or_init(|| client))
}

#[derive(Debug)]
struct GrokImageRequestSpec {
    prompt: String,
    aspect_ratio: Option<String>,
    resolution: String,
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
        "resolution": spec.resolution,
        "response_format": "b64_json",
    })
}

/// One image-to-image request against the xAI edits endpoint. `image_paths`
/// order matters: the prompt references them as `<IMAGE_0>`, `<IMAGE_1>`, ...
#[derive(Debug)]
struct GrokEditRequestSpec {
    prompt: String,
    image_paths: Vec<PathBuf>,
    /// `None` lets the endpoint default to the first input image's ratio.
    aspect_ratio: Option<String>,
    /// `None` lets the endpoint pick its default resolution tier.
    resolution: Option<String>,
}

/// Read a PNG input image and encode it as a `data:image/png;base64,` URI for
/// the edits endpoint's `image`/`images` fields.
fn grok_png_data_uri(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| {
        format!(
            "Failed to read Grok edit input image at {}: {e}",
            path.display()
        )
    })?;
    if !is_png(&bytes) {
        return Err(format!(
            "Grok edit input image at {} is not a PNG.",
            path.display()
        ));
    }
    Ok(format!(
        "data:image/png;base64,{}",
        BASE64_STANDARD.encode(&bytes)
    ))
}

/// Build the xAI image-edit request body. A single input uses `image`; several
/// use `images` (referenced as `<IMAGE_0>`, `<IMAGE_1>`, ... in the prompt).
/// Output shape is conveyed only through `aspect_ratio` + `resolution`
/// parameters — never pixel geometry in the prompt (see AGENTS.md).
fn grok_edit_request_json(
    spec: &GrokEditRequestSpec,
    image_model: &str,
) -> Result<serde_json::Value, String> {
    if spec.image_paths.is_empty() {
        return Err("Grok image editing needs at least one input image.".into());
    }
    let mut body = json!({
        "model": image_model,
        "prompt": spec.prompt,
        "n": 1,
        "response_format": "b64_json",
    });
    let object = body
        .as_object_mut()
        .expect("edit request body is an object");
    if let Some(aspect_ratio) = spec.aspect_ratio.as_deref() {
        object.insert("aspect_ratio".into(), json!(aspect_ratio));
    }
    if let Some(resolution) = spec.resolution.as_deref() {
        object.insert("resolution".into(), json!(resolution));
    }
    if let [single] = spec.image_paths.as_slice() {
        object.insert("image".into(), json!({ "url": grok_png_data_uri(single)? }));
    } else {
        let images = spec
            .image_paths
            .iter()
            .map(|path| Ok(json!({ "url": grok_png_data_uri(path)? })))
            .collect::<Result<Vec<_>, String>>()?;
        object.insert("images".into(), json!(images));
    }
    Ok(body)
}

/// The user's explicit resolution setting when it names a real tier; `None`
/// for empty/"auto"/unknown values so callers fall back to the grid tier.
fn explicit_grok_resolution(setting: Option<&str>) -> Option<String> {
    setting
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|value| matches!(value.as_str(), "1k" | "2k"))
}

/// Edit resolution: an explicit "1k"/"2k" setting wins; otherwise the smallest
/// tier whose output grid covers the submitted working canvas.
fn grok_edit_resolution(setting: Option<&str>, working: &AiWorkingCanvas) -> Option<String> {
    explicit_grok_resolution(setting).or_else(|| {
        grok_output_target(&working.aspect_label, working.original_dimensions)
            .map(|(tier, _)| tier.to_string())
    })
}

/// Generation resolution: an explicit "1k"/"2k" setting wins; otherwise the
/// smallest tier covering the requested target dimensions, defaulting to
/// [`GROK_IMAGE_RESOLUTION`] when no target is known.
fn grok_generation_resolution(
    setting: Option<&str>,
    aspect_label: Option<&str>,
    target_dimensions: Option<(u32, u32)>,
) -> String {
    explicit_grok_resolution(setting)
        .or_else(|| {
            aspect_label
                .zip(target_dimensions)
                .and_then(|(label, dimensions)| grok_output_target(label, dimensions))
                .map(|(tier, _)| tier.to_string())
        })
        .unwrap_or_else(|| GROK_IMAGE_RESOLUTION.into())
}

/// Edit request geometry for a placement working canvas: the aspect-ratio
/// label is the submission parameter; pixel dimensions only pick the tier.
fn grok_edit_spec_for_working(
    prompt: String,
    image_paths: Vec<PathBuf>,
    working: &AiWorkingCanvas,
    resolution_setting: Option<&str>,
) -> GrokEditRequestSpec {
    GrokEditRequestSpec {
        prompt,
        image_paths,
        aspect_ratio: Some(working.aspect_label.clone()),
        resolution: grok_edit_resolution(resolution_setting, working),
    }
}

fn configured_or_default_grok_image_model(image_model: Option<String>) -> String {
    clean_option(image_model)
        .filter(|value| value != "auto")
        .unwrap_or_else(|| DEFAULT_GROK_IMAGE_MODEL.to_string())
}

fn grok_api_base_url() -> String {
    std::env::var("PAINTNODE_GROK_IMAGE_BASE_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "https://api.x.ai".into())
}

fn grok_images_endpoint() -> String {
    grok_api_base_url() + "/v1/images/generations"
}

fn grok_edits_endpoint() -> String {
    grok_api_base_url() + "/v1/images/edits"
}

fn post_grok_image_request(
    client: &Client,
    token: &GrokAuthToken,
    version: &str,
    endpoint: &str,
    request_body: &serde_json::Value,
) -> Result<(reqwest::StatusCode, String), String> {
    let response = client
        .post(endpoint)
        .bearer_auth(token.access_token.trim())
        .header(reqwest::header::USER_AGENT, grok_image_user_agent(version))
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
        .find(|datum| {
            datum
                .b64_json
                .as_deref()
                .is_some_and(|b| !b.trim().is_empty())
        })
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

fn remove_grok_debug_artifacts(job_path: &Path) {
    for file_name in [
        GROK_IMAGE_REQUEST_FILE,
        GROK_IMAGE_RESPONSE_FILE,
        GROK_EDIT_REQUEST_FILE,
        GROK_EDIT_RESPONSE_FILE,
    ] {
        let _ = fs::remove_file(job_path.join(file_name));
    }
}

/// One prepared POST against an xAI Images endpoint plus its debug artifacts.
struct GrokDirectRequest<'a> {
    endpoint: String,
    request_body: serde_json::Value,
    request_file: &'a str,
    response_file: &'a str,
    progress: &'a str,
}

/// Authenticate, POST to the xAI Images API, and return decoded PNG bytes.
/// Shared engine for the generation and edit endpoints: cancel checks, token
/// refresh, one 401/403 retry, and debug-artifact capture.
fn run_grok_direct_request(
    app: &AppHandle,
    run_id: &str,
    grok_bin: &str,
    job_path: &Path,
    request: &GrokDirectRequest,
    keep_debug_artifacts: bool,
) -> Result<Vec<u8>, String> {
    if ai_run_cancelled(run_id) {
        return Err(AI_RUN_STOPPED_MESSAGE.into());
    }
    if !keep_debug_artifacts {
        remove_grok_debug_artifacts(job_path);
    }
    emit_codex_progress(app, run_id, "Authenticating Grok account");
    let mut token = fresh_grok_auth_token(grok_bin)?;

    let version = grok_cli_version(grok_bin);
    if keep_debug_artifacts {
        if let Ok(pretty) = serde_json::to_vec_pretty(&request.request_body) {
            let _ = fs::write(job_path.join(request.request_file), pretty);
        }
    }
    if ai_run_cancelled(run_id) {
        return Err(AI_RUN_STOPPED_MESSAGE.into());
    }

    let client = grok_image_http_client()?;
    emit_codex_progress(app, run_id, request.progress);
    let (mut status, mut text) = post_grok_image_request(
        client,
        &token,
        &version,
        &request.endpoint,
        &request.request_body,
    )?;
    if status.as_u16() == 401 || status.as_u16() == 403 {
        emit_codex_progress(app, run_id, "Refreshing Grok auth after backend rejection");
        wake_grok_auth(grok_bin)?;
        token = load_grok_auth_token()?;
        let retry = post_grok_image_request(
            client,
            &token,
            &version,
            &request.endpoint,
            &request.request_body,
        )?;
        status = retry.0;
        text = retry.1;
    }
    if keep_debug_artifacts {
        let _ = fs::write(job_path.join(request.response_file), &text);
    }
    if ai_run_cancelled(run_id) {
        return Err(AI_RUN_STOPPED_MESSAGE.into());
    }
    if !status.is_success() {
        return Err(grok_image_http_error_message(status, &text));
    }
    decode_grok_images_response(&text)
}

/// Text-to-image generation through `/v1/images/generations`.
fn run_grok_direct_image(
    app: &AppHandle,
    run_id: &str,
    grok_bin: &str,
    job_path: &Path,
    spec: GrokImageRequestSpec,
    image_model: &str,
    keep_debug_artifacts: bool,
) -> Result<Vec<u8>, String> {
    run_grok_direct_request(
        app,
        run_id,
        grok_bin,
        job_path,
        &GrokDirectRequest {
            endpoint: grok_images_endpoint(),
            request_body: grok_image_request_json(&spec, image_model),
            request_file: GROK_IMAGE_REQUEST_FILE,
            response_file: GROK_IMAGE_RESPONSE_FILE,
            progress: "Calling the Grok image backend",
        },
        keep_debug_artifacts,
    )
}

/// Image-to-image editing through `/v1/images/edits`.
fn run_grok_direct_edit(
    app: &AppHandle,
    run_id: &str,
    grok_bin: &str,
    job_path: &Path,
    spec: GrokEditRequestSpec,
    image_model: &str,
    keep_debug_artifacts: bool,
) -> Result<Vec<u8>, String> {
    run_grok_direct_request(
        app,
        run_id,
        grok_bin,
        job_path,
        &GrokDirectRequest {
            endpoint: grok_edits_endpoint(),
            request_body: grok_edit_request_json(&spec, image_model)?,
            request_file: GROK_EDIT_REQUEST_FILE,
            response_file: GROK_EDIT_RESPONSE_FILE,
            progress: "Calling the Grok image edit backend",
        },
        keep_debug_artifacts,
    )
}

/// PaintNode-owned masked image edit for one placement part, used by the
/// Codex-directed fill pipeline and the grok commands below.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run_grok_owned_image_edit(
    app: &AppHandle,
    run_id: &str,
    bin: Option<String>,
    job_path: &Path,
    prompt: String,
    image_paths: Vec<PathBuf>,
    working: &AiWorkingCanvas,
    image_model: Option<String>,
    image_resolution: Option<String>,
    keep_debug_artifacts: bool,
) -> Result<Vec<u8>, String> {
    let grok_bin = configured_or_default_grok_bin(bin)?;
    let image_model = configured_or_default_grok_image_model(image_model);
    run_grok_direct_edit(
        app,
        run_id,
        &grok_bin,
        job_path,
        grok_edit_spec_for_working(prompt, image_paths, working, image_resolution.as_deref()),
        &image_model,
        keep_debug_artifacts,
    )
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
    if lower.contains("supergrok") || lower.contains("subscription") || lower.contains("upgrade") {
        return format!("Grok image generation requires a SuperGrok subscription.\n\n{detail}");
    }
    // 401/403 without a subscription hint is an auth rejection (this message
    // is only reached after the refresh-and-retry pass already failed).
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return format!(
            "Grok rejected the sign-in. Run `grok` in Terminal and sign in again, then retry.\n\n{detail}"
        );
    }
    format!(
        "Grok image generation failed (HTTP {}).\n\n{detail}",
        status.as_u16()
    )
}

/// Prompt for reference-guided generation through the edit endpoint: the
/// references are attachments the model sees as `<IMAGE_n>`.
fn grok_reference_generation_prompt(user_prompt: &str, reference_names: &[String]) -> String {
    let mut lines = vec![
        "Generate one new image guided by the attached reference images.".to_string(),
        String::new(),
        "Attached reference images:".to_string(),
    ];
    for (index, name) in reference_names.iter().enumerate() {
        lines.push(format!(
            "- <IMAGE_{index}>: `{name}`, a user-added visual reference."
        ));
    }
    lines.push(String::new());
    lines.push("Use the references as visual guidance for style, identity, material, palette, composition, or specific details requested by the prompt. Do not paste them directly unless the prompt explicitly asks for copied content.".into());
    lines.push(String::new());
    lines.push("User image prompt:".into());
    lines.push(user_prompt.to_string());
    lines.join("\n")
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
    image_resolution: Option<String>,
    target_width: Option<u32>,
    target_height: Option<u32>,
) -> Result<GeneratedImageResult, String> {
    if prompt.trim().is_empty() {
        return Err("Enter a prompt.".into());
    }
    validate_reference_pngs(&reference_pngs, "Generate image")?;
    if reference_pngs.len() > GROK_MAX_EDIT_REFERENCE_IMAGES {
        return Err("Grok supports up to 3 reference images per generation. Remove extra references, or use Antigravity or Codex for more references.".into());
    }
    let target_dimensions = validate_optional_target_dimensions(target_width, target_height)?;

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let grok_bin = configured_or_default_grok_bin(bin)?;
        let image_model = configured_or_default_grok_image_model(image_model);
        let keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        let run_id = if run_id.trim().is_empty() {
            format!("grok-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let (project_dir, _job_project_dir, job_path, cleanup_project_job, _temp_job) =
            project_or_temp_job_path(
                &app,
                &project_path,
                GROK_RUNS_DIR,
                "grok",
                &run_id,
                keep_job_dir,
            )?;

        let aspect_ratio = target_dimensions.and_then(grok_closest_aspect_label);
        let resolution = grok_generation_resolution(
            image_resolution.as_deref(),
            aspect_ratio.as_deref(),
            target_dimensions,
        );
        let (reference_paths, reference_names) =
            write_reference_pngs(&job_path, &reference_pngs, "Generate image")?;
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
                    "resolution": resolution,
                },
                "targetDimensions": target_dimensions
                    .map(|(width, height)| json!({ "width": width, "height": height })),
                "referenceImages": reference_names,
                "keepJobDir": keep_job_dir,
                "debugArtifacts": keep_debug_artifacts,
            }),
        )?;
        // Reference-guided generation routes through the edit endpoint, which
        // accepts the references as input images (prompt-driven).
        let prompt_text = if reference_names.is_empty() {
            prompt.trim().to_string()
        } else {
            grok_reference_generation_prompt(prompt.trim(), &reference_names)
        };
        write_ai_job_prompt(&job_path, &prompt_text, "Grok image generation")?;
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
            let bytes = if reference_paths.is_empty() {
                run_grok_direct_image(
                    &app,
                    &run_id,
                    &grok_bin,
                    &job_path,
                    GrokImageRequestSpec {
                        prompt: prompt_text.clone(),
                        aspect_ratio: aspect_ratio.clone(),
                        resolution: resolution.clone(),
                    },
                    &image_model,
                    keep_debug_artifacts,
                )?
            } else {
                run_grok_direct_edit(
                    &app,
                    &run_id,
                    &grok_bin,
                    &job_path,
                    GrokEditRequestSpec {
                        prompt: prompt_text.clone(),
                        image_paths: reference_paths,
                        aspect_ratio: aspect_ratio.clone(),
                        resolution: Some(resolution.clone()),
                    },
                    &image_model,
                    keep_debug_artifacts,
                )?
            };
            fs::write(&result_path, &bytes)
                .map_err(|e| format!("Failed to write Grok image result: {e}"))?;
            png_dimensions_from_bytes(&bytes)
                .ok_or_else(|| "Grok image PNG dimensions are invalid.".to_string())?;
            bytes
        };

        // Cover-crop the model output to the requested pixel dimensions.
        let bytes = if let Some(target) = target_dimensions {
            let (mut bytes, source_dimensions, upscale_factor) =
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
            if upscale_factor > AI_RESTORE_UPSCALE_THRESHOLD {
                emit_codex_progress(
                    &app,
                    &run_id,
                    format!("Result enlarged {upscale_factor:.2}x; restoring image detail"),
                );
                let (restored, _) = grok_restore_image_details(
                    &app,
                    &run_id,
                    &grok_bin,
                    &image_model,
                    image_resolution.as_deref(),
                    keep_debug_artifacts,
                    &job_path.join("restore"),
                    &bytes,
                    "Generated image restoration",
                    false,
                    true,
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
            emit_codex_progress(&app, &run_id, "Saving Grok image to the project");
            Some(store_generated_png_asset(
                &project_dir,
                &bytes,
                prompt.trim().chars().take(48).collect::<String>(),
                Some(prompt.trim().into()),
                Some("result.png".into()),
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
// Image editing: fill, retouch, upscale/restore, and workflow composition
// ---------------------------------------------------------------------------

/// Ordered edit-endpoint attachments plus their prompt descriptions. The xAI
/// edits endpoint references inputs positionally (`<IMAGE_0>`, `<IMAGE_1>`,
/// ...), so building both together keeps prompt indices and upload order in
/// sync by construction.
struct GrokEditAttachments {
    paths: Vec<PathBuf>,
    notes: Vec<String>,
}

impl GrokEditAttachments {
    fn new() -> Self {
        Self {
            paths: Vec::new(),
            notes: Vec::new(),
        }
    }

    fn push(&mut self, path: PathBuf, description: impl Into<String>) {
        let index = self.paths.len();
        self.notes
            .push(format!("- <IMAGE_{index}>: {}", description.into()));
        self.paths.push(path);
    }

    fn notes_block(&self) -> String {
        self.notes.join("\n")
    }
}

const GROK_OVERVIEW_ATTACHMENT_NOTE: &str = "a downscaled preview of the surrounding document content with the editable region outlined in red (`overview.png`). Use it only as non-editable composition and continuity guidance; never copy its pixels, its resolution, or the red outline into the output.";

/// Generative fill prompt for one placement part. Equivalent wording to the
/// Antigravity fill prompt, adapted to positional edit-endpoint attachments.
fn grok_fill_prompt(prompt: &str, attachments_note: &str, geometry_note: &str) -> String {
    format!(
        r#"Perform one PaintNode generative fill on the attached images.

Attached images:
{attachments_note}

{geometry_note}

Original user fill prompt:
{prompt}

Required output:
- Return exactly one PNG image with the same framing as <IMAGE_0>.
- Keep the attached frame registered: no crop, zoom, reframe, or shift.
- Fill the intended editable/empty area implied by the attached frame and prompt.
- Match surrounding texture, lighting, perspective, color, focus, and grain.
- PaintNode will crop, paste, and apply the editable mask after import. Do not draw mask edges, gray buffers, borders, or guides into the pixels.
- Do not include UI chrome, borders, labels, watermarks, or mask visualization."#
    )
}

/// AI retouch prompt for one placement part. Equivalent wording to the
/// Antigravity retouch prompt, adapted to positional edit-endpoint
/// attachments (`<IMAGE_0>` = edit target, `<IMAGE_1>` = mask).
fn grok_retouch_prompt(prompt: &str, attachments_note: &str, geometry_note: &str) -> String {
    format!(
        r#"Perform one PaintNode AI retouch on the attached images.

Attached images:
{attachments_note}

{geometry_note}

User retouch prompt:
{prompt}

Required output:
- Return exactly one PNG image with the same framing as <IMAGE_0>.
- Treat the edit as an in-place retouch of <IMAGE_0>; do not crop, zoom, reframe, or shift it.
- Treat the mask as the maximum allowed edit area, not as an instruction to repaint every white pixel. Change only the content explicitly requested by the user prompt and preserve unrequested masked content.
- Keep every newly generated, removed, replaced, reconstructed, relit, recolored, cleaned, extended, blended, shadowed, reflected, or otherwise changed visible pixel inside the white/gray mask footprint.
- Any edit whose visible change extends outside the mask is a failed retouch, even though the app masks the imported layer afterward. Scale, simplify, or localize the requested change so the complete visible edit fits inside the mask footprint.
- If the prompt changes clothing or accessories, preserve the person's identity, face, hair, skin, hands, pose, body proportions, expression, gaze, and all unrequested surrounding content unless the user explicitly asks to alter those details.
- Blend naturally through any gray feather buffer. PaintNode attaches the mask as a separate user-editable layer mask — it is never baked into your pixels — so the result itself must preserve protected and unrequested areas.
- Keep every black/transparent-mask protected area visually identical to <IMAGE_0>: no enhancement, denoise, sharpening, relight, recolor, cleanup, straightening, or reframing outside the mask.
- Use surrounding texture, lighting, perspective, grain, focus, and edges to blend the retouched area naturally.
- Do not include UI chrome, checkerboard transparency, selection outlines, masks, annotations, labels, or guide marks in the output."#
    )
}

/// Detail-restoration prompt for one placement part. Equivalent wording to
/// the Antigravity restore prompt, adapted to positional attachments.
fn grok_restore_prompt(attachments_note: &str, geometry_note: &str) -> String {
    format!(
        r#"Perform one PaintNode detail restoration on the attached images.

This is a fixed-canvas image refinement task, not a new image generation task.

Attached images:
{attachments_note}

{geometry_note}

Restoration goal:
- Re-render this exact image with crisp, natural, high-frequency detail: sharp edges and realistic texture for skin, hair, fabric, foliage, and surfaces.
- Preserve the composition, framing, camera geometry, subjects, identities, poses, expressions, colors, lighting, and style exactly.
- Match the color balance, tone, brightness, contrast, grain, and detail level of the already-restored areas exactly, so the result joins them without visible seams.
- Preserve intentional medium character such as film grain, scan texture, halation, bloom, lens softness, motion softness, slight overexposure, underexposure, or vintage color cast. Do not treat those traits as defects unless the user explicitly asked for cleanup, denoise, or restoration beyond upscale/detail recovery.
- Do not add, remove, move, restyle, or reinterpret any content.
- Do not change global brightness, contrast, or color balance.
- If a detail is too blurred to identify, render a plausible neutral texture instead of inventing new objects, readable text, faces, or logos.
- Do not translate, shift, crop, zoom, rotate, scale, stretch, warp, resize, reframe, straighten, or change the camera perspective.

Required output:
- Return exactly one PNG image with the same aspect ratio as <IMAGE_0>.
- Do not include UI chrome, borders, labels, watermarks, or mask visualization."#
    )
}

/// Multi-asset workflow composition prompt. Equivalent wording to the
/// Antigravity workflow prompt, adapted to positional attachments.
fn grok_workflow_prompt(prompt: &str, attachments_note: &str) -> String {
    format!(
        r#"Compose one new PaintNode raster image from the attached workflow asset images.

Attached source assets:
{attachments_note}

User composition prompt:
{prompt}

Required output:
- Return exactly one final composed PNG image.
- Do not include UI chrome, borders, labels, or watermarks."#
    )
}

/// Appended to the prompt when a candidate fails the protected-region drift
/// gate: the model regenerated the scene instead of editing in place.
const GROK_IN_PLACE_RETRY_NOTE: &str = r#"IMPORTANT — previous candidate rejected:
- The previous candidate repainted pixels outside the editable mask, which means the scene was regenerated instead of edited in place. PaintNode discarded it.
- This is a strict in-place edit of <IMAGE_0>: apply the requested change only inside the white mask area of <IMAGE_1> and reproduce every pixel outside the mask exactly as it appears in <IMAGE_0>.
- If the requested change cannot be honored inside the mask, make the closest faithful change possible rather than re-imagining the scene."#;

/// Deterministic post-processing notes recorded in the part folder for
/// debugging; the Grok image backend never sees this file.
fn grok_retouch_contract_text(geometry_note: &str) -> String {
    format!(
        r#"PaintNode deterministic AI retouch contract (Grok)

The Grok image edit backend returns the retouch candidate directly; PaintNode owns every deterministic step.

{geometry_note}

PaintNode will do after the candidate is returned:
- Validate that the result is a PNG.
- Resize a same-aspect result back to the exact submitted crop dimensions if needed.
- Paste the result into the document region recorded in `placement.json`.
- Import the pasted result as a new layer with the editable mask attached as a separate linked mask layer. The mask is never baked into the result pixels, so the user can still edit the mask afterwards.
- Store the generated asset in the project.
"#
    )
}

/// Run a tiled detail-restoration pass over an enlarged image: every part is
/// regenerated at model-native density and pasted back at its position.
#[allow(clippy::too_many_arguments)]
fn grok_restore_image_details(
    app: &AppHandle,
    run_id: &str,
    grok_bin: &str,
    image_model: &str,
    image_resolution: Option<&str>,
    keep_debug_artifacts: bool,
    restore_root: &Path,
    enlarged_png: &[u8],
    label: &str,
    upscale_layers: bool,
    return_composed: bool,
) -> Result<(Option<Vec<u8>>, Vec<GeneratedImageLayerResult>), String> {
    let dimensions = png_dimensions_from_bytes(enlarged_png)
        .ok_or_else(|| format!("{label} PNG dimensions are invalid."))?;
    let placement = if upscale_layers {
        plan_ai_upscale_placement(AiEditProvider::Grok, dimensions, label)?
    } else {
        plan_ai_restore_placement(AiEditProvider::Grok, dimensions, label)?
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
        if !keep_debug_artifacts {
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
        let mut attachments = GrokEditAttachments::new();
        attachments.push(
            part_path.join("source.png"),
            "the image region to restore (`source.png`). It was enlarged from a lower-resolution image, so it is soft and lacks fine detail.",
        );
        attachments.push(
            part_path.join("mask.png"),
            "an editable-area mask over <IMAGE_0> (`mask.png`). White pixels are editable. Gray pixels are a feathered hand-off band into already-restored content; PaintNode cross-fades the result there, so render that band seamlessly consistent with the neighboring restored pixels. Black or transparent pixels were already restored and must remain unchanged. The mask itself must never appear in the output.",
        );
        if has_overview {
            fs::write(
                part_path.join("overview.png"),
                composer.overview_png(part, label)?,
            )
            .map_err(|e| format!("Failed to write {label} overview image: {e}"))?;
            attachments.push(
                part_path.join("overview.png"),
                GROK_OVERVIEW_ATTACHMENT_NOTE,
            );
        }
        let geometry_note = ai_part_geometry_note(&placement, part_index);
        let prompt_text = grok_restore_prompt(&attachments.notes_block(), &geometry_note);
        write_ai_job_prompt(&part_path, &prompt_text, label)?;
        emit_codex_part_progress(
            app,
            run_id,
            part_index,
            placement.parts.len(),
            ai_part_progress_message(&placement, part_index, "Restoring image detail with Grok"),
        );
        let result_path = part_path.join("result.png");
        let bytes = run_grok_direct_edit(
            app,
            run_id,
            grok_bin,
            &part_path,
            grok_edit_spec_for_working(
                prompt_text.clone(),
                attachments.paths,
                &part.working,
                image_resolution,
            ),
            image_model,
            keep_debug_artifacts,
        )
        .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?;
        fs::write(&result_path, &bytes).map_err(|e| {
            ai_part_progress_message(
                &placement,
                part_index,
                &format!("Failed to write Grok detail restoration result: {e}"),
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
            if keep_debug_artifacts {
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
#[allow(clippy::too_many_arguments)]
pub(crate) async fn generate_grok_fill_image(
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
    image_model: Option<String>,
    image_resolution: Option<String>,
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
        let grok_bin = configured_or_default_grok_bin(bin)?;
        let image_model = configured_or_default_grok_image_model(image_model);
        let keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        // The fill pipeline has no drift/seam gate (PaintNode owns paste-back
        // masking); the level is accepted for command-shape parity.
        let _checks_level = ai_edit_checks_level(edit_checks_level);
        let fill_aspect_ratio = fill_aspect_ratio
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let run_id = if run_id.trim().is_empty() {
            format!("grok-fill-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let (project_dir, _job_project_dir, job_path, cleanup_project_job, _temp_job) =
            project_or_temp_job_path(
                &app,
                &project_path,
                GROK_RUNS_DIR,
                "grok-fill",
                &run_id,
                keep_job_dir,
            )?;
        let store_asset = store_asset.unwrap_or(true);

        let placement = plan_ai_fill_placement(
            AiEditProvider::Grok,
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
                                let asset = store_generated_png_asset(
                                    project_dir,
                                    &layer_png,
                                    layer_name.clone(),
                                    Some(prompt.trim().into()),
                                    None,
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
            let inputs = composer.part_inputs(part, "Generative fill")?;
            fs::write(part_path.join("source.png"), &inputs.source_png)
                .map_err(|e| format!("Failed to write generative fill source image: {e}"))?;
            let mut attachments = GrokEditAttachments::new();
            attachments.push(
                part_path.join("source.png"),
                "the current content of the document area being edited (`source.png`). Generate directly against this frame.",
            );
            if fill_part_needs_overview(&placement, part_index) {
                fs::write(
                    part_path.join("overview.png"),
                    composer.overview_png(part, "Generative fill")?,
                )
                .map_err(|e| format!("Failed to write generative fill overview image: {e}"))?;
                attachments.push(part_path.join("overview.png"), GROK_OVERVIEW_ATTACHMENT_NOTE);
            }
            let (reference_paths, reference_names) =
                write_reference_pngs(&part_path, &reference_pngs, "Generative fill")?;
            for (reference_path, reference_name) in
                reference_paths.into_iter().zip(&reference_names)
            {
                attachments.push(
                    reference_path,
                    format!("`{reference_name}`, a user-added visual reference. Use it as visual guidance for style, identity, material, palette, composition, or specific details requested by the prompt. Do not paste it directly unless the prompt explicitly asks for copied content."),
                );
            }
            let geometry_note = ai_part_prompt_context(&placement, part_index);
            let prompt_text = grok_fill_prompt(
                prompt.trim(),
                &attachments.notes_block(),
                &geometry_note,
            );
            write_ai_job_prompt(&part_path, &prompt_text, "Grok generative fill")?;

            emit_codex_part_progress(
                &app,
                &run_id,
                part_index,
                placement.parts.len(),
                ai_part_progress_message(
                    &placement,
                    part_index,
                    "Generating through the Grok image edit backend",
                ),
            );
            let result_path = part_path.join("result.png");
            let generated = run_grok_direct_edit(
                &app,
                &run_id,
                &grok_bin,
                &part_path,
                grok_edit_spec_for_working(
                    prompt_text.clone(),
                    attachments.paths,
                    &part.working,
                    image_resolution.as_deref(),
                ),
                &image_model,
                keep_debug_artifacts,
            )
            .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?;
            fs::write(&result_path, &generated).map_err(|e| {
                ai_part_progress_message(
                    &placement,
                    part_index,
                    &format!("Failed to write Grok generative fill result: {e}"),
                )
            })?;
            let (generated_bytes, result_dimensions, normalized_result) =
                read_png_bytes_cropped_to_ai_working_canvas(
                    &result_path,
                    &part.working,
                    "Grok generative fill",
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
                            "Normalized Grok fill from {}x{} to {}x{}",
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
                        let asset = store_generated_png_asset(
                            project_dir,
                            &layer_png,
                            layer_name.clone(),
                            Some(prompt.trim().into()),
                            None,
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
                Some(store_generated_png_asset(
                    &project_dir,
                    &bytes,
                    prompt.trim().chars().take(48).collect::<String>(),
                    Some(prompt.trim().into()),
                    Some("result.png".into()),
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
#[allow(clippy::too_many_arguments)]
pub(crate) async fn generate_grok_retouch_image(
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
    image_model: Option<String>,
    image_resolution: Option<String>,
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
        let grok_bin = configured_or_default_grok_bin(bin)?;
        let image_model = configured_or_default_grok_image_model(image_model);
        let keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        let checks_level = ai_edit_checks_level(edit_checks_level);
        let run_id = if run_id.trim().is_empty() {
            format!("grok-retouch-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let (project_dir, _job_project_dir, job_path, cleanup_project_job, _temp_job) =
            project_or_temp_job_path(
                &app,
                &project_path,
                GROK_RUNS_DIR,
                "grok-retouch",
                &run_id,
                keep_job_dir,
            )?;

        let placement = plan_ai_edit_placement(
            AiEditProvider::Grok,
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
            let inputs = composer.part_inputs(part, "AI retouch")?;
            fs::write(part_path.join("source.png"), &inputs.source_png)
                .map_err(|e| format!("Failed to write AI retouch source image: {e}"))?;
            fs::write(part_path.join("edit_target.png"), &inputs.edit_target_png)
                .map_err(|e| format!("Failed to write AI retouch edit target image: {e}"))?;
            fs::write(part_path.join("mask.png"), &inputs.mask_png)
                .map_err(|e| format!("Failed to write AI retouch mask image: {e}"))?;
            let mut attachments = GrokEditAttachments::new();
            attachments.push(
                part_path.join("edit_target.png"),
                "the image to edit in place (`edit_target.png`). Apply the requested change to this image directly.",
            );
            attachments.push(
                part_path.join("mask.png"),
                "a same-size edit mask over <IMAGE_0> (`mask.png`). White pixels are editable. Gray pixels are a feathered transition buffer. Black or transparent pixels are protected context and are not editable. The mask itself must never appear in the output.",
            );
            attachments.push(
                part_path.join("source.png"),
                "the original source image for this edit (`source.png`).",
            );
            if placement.is_split() {
                fs::write(
                    part_path.join("overview.png"),
                    composer.overview_png(part, "AI retouch")?,
                )
                .map_err(|e| format!("Failed to write AI retouch overview image: {e}"))?;
                attachments.push(part_path.join("overview.png"), GROK_OVERVIEW_ATTACHMENT_NOTE);
            }
            if let Some(annotated) = &inputs.annotated_source_png {
                fs::write(part_path.join("annotated_source.png"), annotated).map_err(|e| {
                    format!("Failed to write AI retouch annotated source image: {e}")
                })?;
                attachments.push(
                    part_path.join("annotated_source.png"),
                    "a guide image with PaintNode callouts (`annotated_source.png`). Use it only to locate the requested edit.",
                );
            }
            if let Some(reference_png) = &reference_png {
                fs::write(part_path.join("reference.png"), reference_png)
                    .map_err(|e| format!("Failed to write AI retouch reference image: {e}"))?;
                attachments.push(
                    part_path.join("reference.png"),
                    "a sampled reference area (`reference.png`). Use it as visual guidance, not as pasted content unless the user explicitly requests copying.",
                );
            }
            let (reference_paths, reference_names) =
                write_reference_pngs(&part_path, &reference_pngs, "AI retouch")?;
            for (reference_path, reference_name) in
                reference_paths.into_iter().zip(&reference_names)
            {
                attachments.push(
                    reference_path,
                    format!("`{reference_name}`, a user-added visual reference. Use it as visual guidance for style, identity, material, palette, composition, or specific details requested by the prompt. Do not paste it directly unless the user explicitly asks for copied content."),
                );
            }
            let geometry_note = ai_part_prompt_context(&placement, part_index);
            fs::write(
                part_path.join("paintnode_contract.txt"),
                grok_retouch_contract_text(&geometry_note),
            )
            .map_err(|e| format!("Failed to write AI retouch PaintNode contract: {e}"))?;
            let base_prompt_text = grok_retouch_prompt(
                prompt.trim(),
                &attachments.notes_block(),
                &geometry_note,
            );

            emit_codex_part_progress(
                &app,
                &run_id,
                part_index,
                placement.parts.len(),
                ai_part_progress_message(
                    &placement,
                    part_index,
                    "Generating through the Grok image edit backend",
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
                write_ai_job_prompt(&part_path, &prompt_text, "Grok AI retouch")?;
                let generated = run_grok_direct_edit(
                    &app,
                    &run_id,
                    &grok_bin,
                    &part_path,
                    grok_edit_spec_for_working(
                        prompt_text.clone(),
                        attachments.paths.clone(),
                        &part.working,
                        image_resolution.as_deref(),
                    ),
                    &image_model,
                    keep_debug_artifacts,
                )
                .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?;
                fs::write(&result_path, &generated).map_err(|e| {
                    ai_part_progress_message(
                        &placement,
                        part_index,
                        &format!("Failed to write Grok AI retouch result: {e}"),
                    )
                })?;
                emit_codex_progress(
                    &app,
                    &run_id,
                    ai_part_progress_message(
                        &placement,
                        part_index,
                        "Reading Grok AI retouch result",
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
                                "Normalized Grok AI retouch from {}x{} to {}x{}",
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
                    GROK_IN_PLACE_RETRY_NOTE
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
            emit_codex_progress(&app, &run_id, "Saving Grok AI retouch result");
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
#[allow(clippy::too_many_arguments)]
pub(crate) async fn upscale_grok_image(
    app: AppHandle,
    bin: Option<String>,
    project_path: Option<String>,
    keep_job_dir: Option<bool>,
    keep_composed_result: Option<bool>,
    keep_debug_artifacts: Option<bool>,
    source_png: Vec<u8>,
    scale_percent: u32,
    run_id: String,
    image_model: Option<String>,
    image_resolution: Option<String>,
) -> Result<GeneratedImageResult, String> {
    if !is_png(&source_png) {
        return Err("AI upscale source is not a PNG image.".into());
    }
    let source_dimensions = png_dimensions_from_bytes(&source_png)
        .ok_or_else(|| "AI upscale source PNG dimensions are invalid.".to_string())?;
    let target_dimensions = ai_upscale_target_dimensions(source_dimensions, scale_percent)?;
    // Reject over-large jobs before allocating the enlarged image.
    plan_ai_upscale_placement(AiEditProvider::Grok, target_dimensions, "AI upscale")?;

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let grok_bin = configured_or_default_grok_bin(bin)?;
        let image_model = configured_or_default_grok_image_model(image_model);
        let keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        let run_id = if run_id.trim().is_empty() {
            format!("grok-upscale-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let keep_composed_result = keep_composed_result.unwrap_or(false);
        let (project_dir, _job_project_dir, job_path, cleanup_project_job, _temp_job) =
            project_or_temp_job_path(
                &app,
                &project_path,
                GROK_RUNS_DIR,
                "grok-upscale",
                &run_id,
                keep_job_dir,
            )?;

        let enlarged_png = if target_dimensions == source_dimensions {
            source_png
        } else {
            emit_codex_progress(
                &app,
                &run_id,
                format!(
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

        let (composed_bytes, layer_results) = grok_restore_image_details(
            &app,
            &run_id,
            &grok_bin,
            &image_model,
            image_resolution.as_deref(),
            keep_debug_artifacts,
            &job_path,
            &enlarged_png,
            "AI upscale",
            true,
            keep_composed_result,
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
#[allow(clippy::too_many_arguments)]
pub(crate) async fn compose_grok_workflow(
    app: AppHandle,
    bin: Option<String>,
    prompt: String,
    project_path: Option<String>,
    sources: Vec<WorkflowSourceImage>,
    run_id: String,
    keep_job_dir: Option<bool>,
    keep_debug_artifacts: Option<bool>,
    image_model: Option<String>,
    image_resolution: Option<String>,
) -> Result<GeneratedImageResult, String> {
    if prompt.trim().is_empty() {
        return Err("Enter a composition prompt.".into());
    }
    if sources.is_empty() {
        return Err("Add at least one asset node before generating.".into());
    }
    if sources.len() > GROK_MAX_EDIT_REFERENCE_IMAGES {
        return Err("Grok multi-asset compose supports up to 3 source images. Connect at most 3 assets, or switch the image generator to Codex or Antigravity.".into());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let grok_bin = configured_or_default_grok_bin(bin)?;
        let image_model = configured_or_default_grok_image_model(image_model);
        let keep_debug_artifacts = keep_debug_artifacts.unwrap_or(false);
        let run_id = if run_id.trim().is_empty() {
            format!("grok-workflow-{}", now_id())
        } else {
            run_id
        };
        clear_ai_run_cancelled(&run_id);
        let keep_job_dir = should_keep_job_dir(keep_job_dir);
        let (project_dir, _job_project_dir, job_path, cleanup_project_job, _temp_job) =
            project_or_temp_job_path(
                &app,
                &project_path,
                GROK_RUNS_DIR,
                "grok-workflow",
                &run_id,
                keep_job_dir,
            )?;
        let input_dir = job_path.join("inputs");
        fs::create_dir_all(&input_dir)
            .map_err(|e| format!("Failed to create workflow input folder: {e}"))?;
        let mut attachments = GrokEditAttachments::new();
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
            attachments.push(path, format!("workflow asset `{name}`."));
        }
        let prompt_text = grok_workflow_prompt(prompt.trim(), &attachments.notes_block());
        write_ai_job_prompt(&job_path, &prompt_text, "Grok workflow composition")?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);

        emit_codex_progress(
            &app,
            &run_id,
            "Generating workflow composition through the Grok image edit backend",
        );
        let result_path = job_path.join("result.png");
        let bytes = run_grok_direct_edit(
            &app,
            &run_id,
            &grok_bin,
            &job_path,
            GrokEditRequestSpec {
                prompt: prompt_text.clone(),
                image_paths: attachments.paths,
                // Let the endpoint follow the first input image's ratio.
                aspect_ratio: None,
                resolution: explicit_grok_resolution(image_resolution.as_deref()),
            },
            &image_model,
            keep_debug_artifacts,
        )?;
        fs::write(&result_path, &bytes)
            .map_err(|e| format!("Failed to write Grok workflow result: {e}"))?;
        let data_url = png_data_url(&bytes)?;
        let asset = if let Some(project_dir) = project_dir {
            Some(store_generated_png_asset(
                &project_dir,
                &bytes,
                format!(
                    "Workflow: {}",
                    prompt.trim().chars().take(48).collect::<String>()
                ),
                Some(prompt.trim().into()),
                Some("result.png".into()),
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

/// `grok-composer-2.5-fast` -> `Grok Composer 2.5 Fast`.
fn grok_model_label(id: &str) -> String {
    id.split('-')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
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
        features: ai_provider_features(AiDirectorProvider::Grok),
    }
}

/// Parse `grok models` stdout. Model lines look like `  * grok-4.5 (default)`
/// or `  - grok-composer-2.5-fast`. Bulleted lines that are not model slugs
/// (hints, notices) are skipped.
fn parse_grok_capabilities(text: &str) -> Result<AiProviderCapabilitiesResult, String> {
    let mut models = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        let Some(rest) = trimmed
            .strip_prefix("* ")
            .or_else(|| trimmed.strip_prefix("- "))
        else {
            continue;
        };
        let is_default = rest.contains("(default)");
        let id = rest
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
        if !id.starts_with("grok") {
            continue;
        }
        let label = grok_model_label(&id);
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
        features: ai_provider_features(AiDirectorProvider::Grok),
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
                fallback_grok_capabilities(Some(format!(
                    "Grok capability discovery failed. {detail}"
                )))
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
    reasoning_effort: Option<String>,
}

fn grok_director_options(
    model: Option<String>,
    reasoning_effort: Option<String>,
) -> GrokDirectorOptions {
    GrokDirectorOptions {
        model: clean_option(model).filter(|value| value != "auto"),
        reasoning_effort: clean_option(reasoning_effort)
            .map(|value| value.to_ascii_lowercase())
            .filter(|value| matches!(value.as_str(), "low" | "medium" | "high")),
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
    if let Some(reasoning_effort) = options.reasoning_effort.as_deref() {
        command.arg("--reasoning-effort").arg(reasoning_effort);
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
    reasoning_effort: Option<String>,
    _keep_debug_artifacts: bool,
    job_path: &Path,
    prompt: &str,
    session_id: Option<&str>,
) -> Result<AgentRunResult, String> {
    // The CLI refreshes its own stored token on launch, so no auth pre-wake
    // is needed here; a sign-in failure surfaces through the exit status.
    let grok_bin = configured_or_default_grok_bin(bin)?;
    let options = grok_director_options(model, reasoning_effort);
    let mut command =
        build_grok_director_command(&grok_bin, job_path, prompt, &options, session_id);
    let run = run_grok_with_progress(&mut command, app.clone(), run_id.to_string(), job_path)?;
    if run.output.status.success() {
        Ok(run)
    } else if let Some(message) = final_grok_agent_message(&run.output) {
        Err(format!("Grok Director failed.\n\n{message}"))
    } else {
        Err(command_failure("Grok Director", &run.output))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_json_token_reads_key_and_expiry_and_tolerates_extra_entries() {
        // exp = 4102444800 (2100-01-01); base64url payload of {"exp":4102444800}
        let payload = BASE64_URL_SAFE_NO_PAD.encode(br#"{"exp":4102444800}"#);
        let jwt = format!("hdr.{payload}.sig");
        // Non-object and key-less sibling entries must not break the parse,
        // and the auth.x.ai record wins over other credential records.
        let json = format!(
            r#"{{"version":1,"other.issuer::client":{{"key":"other"}},"https://auth.x.ai::client":{{"key":"{jwt}","refresh_token":"r"}}}}"#
        );
        let token = grok_token_from_auth_json(&json).unwrap();
        assert_eq!(token.access_token, jwt);
        assert_eq!(token.expiry_unix, Some(4102444800));
        assert!(grok_token_from_auth_json("{}").is_err());
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
            resolution: "1k".into(),
        };
        let body = grok_image_request_json(&spec, DEFAULT_GROK_IMAGE_MODEL);
        let text = serde_json::to_string(&body).unwrap();
        assert!(text.contains("\"aspect_ratio\":\"16:9\""));
        assert!(text.contains("\"resolution\":\"1k\""));
        assert!(!text.contains("1024"));
        assert!(!text.contains('x')); // no "1024x768"-style geometry
    }

    #[test]
    fn standard_imagine_model_is_forwarded_without_aliasing_to_quality() {
        assert_eq!(
            configured_or_default_grok_image_model(Some("grok-imagine-image".into())),
            "grok-imagine-image"
        );
        assert_eq!(
            configured_or_default_grok_image_model(None),
            DEFAULT_GROK_IMAGE_MODEL
        );
    }

    /// Write a valid 1x1 PNG into `dir` and return its path.
    fn write_test_png(dir: &Path, name: &str) -> PathBuf {
        let png = BASE64_STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
            .unwrap();
        let path = dir.join(name);
        fs::write(&path, png).expect("write test png");
        path
    }

    #[test]
    fn edit_request_body_uses_single_image_data_uri() {
        let dir = std::env::temp_dir().join(format!("paintnode-grok-edit-single-{}", now_id()));
        fs::create_dir_all(&dir).expect("create test dir");
        let image_path = write_test_png(&dir, "edit_target.png");
        let spec = GrokEditRequestSpec {
            prompt: "replace the sky with a sunset".into(),
            image_paths: vec![image_path],
            aspect_ratio: Some("16:9".into()),
            resolution: Some("1k".into()),
        };
        let body = grok_edit_request_json(&spec, DEFAULT_GROK_IMAGE_MODEL).expect("edit body");
        assert_eq!(body["model"], DEFAULT_GROK_IMAGE_MODEL);
        assert_eq!(body["n"], 1);
        assert_eq!(body["response_format"], "b64_json");
        assert_eq!(body["aspect_ratio"], "16:9");
        assert_eq!(body["resolution"], "1k");
        let url = body["image"]["url"].as_str().expect("image url");
        assert!(url.starts_with("data:image/png;base64,"));
        assert!(body.get("images").is_none());
        // No pixel geometry anywhere in the prompt or scalar parameters.
        let prompt = body["prompt"].as_str().expect("prompt");
        assert!(!prompt.contains("1024"));
        assert!(!prompt.contains('x'));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_request_body_uses_images_array_for_multiple_inputs() {
        let dir = std::env::temp_dir().join(format!("paintnode-grok-edit-multi-{}", now_id()));
        fs::create_dir_all(&dir).expect("create test dir");
        let first = write_test_png(&dir, "edit_target.png");
        let second = write_test_png(&dir, "mask.png");
        let third = write_test_png(&dir, "source.png");
        let spec = GrokEditRequestSpec {
            prompt: "edit <IMAGE_0> using the mask <IMAGE_1> and source <IMAGE_2>".into(),
            image_paths: vec![first, second, third],
            aspect_ratio: None,
            resolution: None,
        };
        let body = grok_edit_request_json(&spec, DEFAULT_GROK_IMAGE_MODEL).expect("edit body");
        assert!(body.get("image").is_none());
        // Aspect ratio and resolution stay unset so the endpoint follows the
        // first input image.
        assert!(body.get("aspect_ratio").is_none());
        assert!(body.get("resolution").is_none());
        let images = body["images"].as_array().expect("images array");
        assert_eq!(images.len(), 3);
        for image in images {
            let url = image["url"].as_str().expect("image url");
            assert!(url.starts_with("data:image/png;base64,"));
        }
        let text = serde_json::to_string(&body).unwrap();
        assert!(!text.contains("1024x1024"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_request_rejects_missing_and_non_png_inputs() {
        let dir = std::env::temp_dir().join(format!("paintnode-grok-edit-invalid-{}", now_id()));
        fs::create_dir_all(&dir).expect("create test dir");
        let not_png = dir.join("not-a-png.png");
        fs::write(&not_png, b"plain text").expect("write non-png");
        let spec = GrokEditRequestSpec {
            prompt: "edit".into(),
            image_paths: vec![not_png],
            aspect_ratio: None,
            resolution: None,
        };
        let err = grok_edit_request_json(&spec, DEFAULT_GROK_IMAGE_MODEL)
            .expect_err("non-png input should fail");
        assert!(err.contains("is not a PNG"));

        let empty = GrokEditRequestSpec {
            prompt: "edit".into(),
            image_paths: Vec::new(),
            aspect_ratio: None,
            resolution: None,
        };
        let err = grok_edit_request_json(&empty, DEFAULT_GROK_IMAGE_MODEL)
            .expect_err("empty inputs should fail");
        assert!(err.contains("at least one input image"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_resolution_prefers_explicit_setting_over_grid_tier() {
        let working = crate::ai::canvas::ai_exact_working_canvas((1024, 1024), "1:1");
        // Explicit setting wins, case-insensitively.
        assert_eq!(
            grok_edit_resolution(Some("2k"), &working).as_deref(),
            Some("2k")
        );
        assert_eq!(
            grok_edit_resolution(Some("2K"), &working).as_deref(),
            Some("2k")
        );
        // "auto"/empty/unknown settings fall back to the covering grid tier.
        assert_eq!(
            grok_edit_resolution(Some("auto"), &working).as_deref(),
            Some("1k")
        );
        assert_eq!(grok_edit_resolution(None, &working).as_deref(), Some("1k"));
        let large = crate::ai::canvas::ai_exact_working_canvas((2048, 2048), "1:1");
        assert_eq!(grok_edit_resolution(None, &large).as_deref(), Some("2k"));
        // A non-grok aspect label yields no tier at all.
        let unknown = crate::ai::canvas::ai_exact_working_canvas((1024, 1024), "codex-crop");
        assert_eq!(grok_edit_resolution(None, &unknown), None);
    }

    #[test]
    fn generation_resolution_prefers_setting_then_target_then_default() {
        // Explicit setting wins over everything.
        assert_eq!(
            grok_generation_resolution(Some("2k"), Some("1:1"), Some((512, 512))),
            "2k"
        );
        // Otherwise the smallest tier covering the target dimensions.
        assert_eq!(
            grok_generation_resolution(None, Some("1:1"), Some((2048, 2048))),
            "2k"
        );
        assert_eq!(
            grok_generation_resolution(Some("auto"), Some("1:1"), Some((512, 512))),
            "1k"
        );
        // No target: the constant default.
        assert_eq!(grok_generation_resolution(None, None, None), "1k");
    }

    #[test]
    fn director_command_forwards_supported_reasoning_effort() {
        let options = grok_director_options(Some("grok-4.5".into()), Some("high".into()));
        let command =
            build_grok_director_command("grok", Path::new("/tmp"), "review", &options, None);
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args.windows(2).any(|pair| pair == ["--model", "grok-4.5"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--reasoning-effort", "high"]));
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
        let text = "You are logged in.\n\nAvailable models:\n  * grok-4.5 (default)\n  - grok-composer-2.5-fast\n\n  - Run `grok settings` to change models\n";
        let caps = parse_grok_capabilities(text).unwrap();
        assert_eq!(caps.models.len(), 2);
        assert_eq!(caps.models[0].id, "grok-4.5");
        assert_eq!(caps.models[0].label, "Grok 4.5");
        assert!(caps.models[0].is_default);
        assert_eq!(caps.models[1].label, "Grok Composer 2.5 Fast");
        assert_eq!(caps.source, "cli");
    }

    #[test]
    fn closest_aspect_label_picks_nearest_ratio() {
        assert_eq!(
            grok_closest_aspect_label((1920, 1080)).as_deref(),
            Some("16:9")
        );
        assert_eq!(
            grok_closest_aspect_label((1000, 1000)).as_deref(),
            Some("1:1")
        );
        assert_eq!(
            grok_closest_aspect_label((800, 1200)).as_deref(),
            Some("2:3")
        );
    }
}
