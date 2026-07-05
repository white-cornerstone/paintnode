//! Antigravity CLI provider: prompts, command building, transcript progress, commands.

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

use tauri::AppHandle;

use crate::ai::canvas::{
    ai_chroma_key_pixel, ai_mask_padding_pixel, ai_retouch_editable_mask_png,
    ai_working_canvas_for_dimensions, ai_working_canvas_instruction, pad_png_to_ai_working_canvas,
    read_png_bytes_cropped_to_ai_working_canvas, validate_optional_target_dimensions,
    AiWorkingCanvas, AI_CHROMA_KEY_HEX, AI_RETOUCH_OUTPUT_MASK_FEATHER_RADIUS,
    AI_RETOUCH_OUTPUT_MASK_GROW_RADIUS,
};
use crate::ai::{
    ai_autonomy_level, ai_retouch_asset_name, clean_option, cleanup_project_agent_job,
    command_failure, command_failure_with_required_output, emit_codex_progress,
    emit_job_file_progress, emit_kept_job_dir, image_agent_autonomy_contract, now_id,
    project_or_temp_job_path, reference_prompt_note, required_png_output_is_ready,
    safe_job_child_path, sanitize_progress_line, should_keep_job_dir, spawn_output_reader,
    validate_reference_pngs, watched_job_files, write_ai_job_prompt, write_reference_pngs,
    AgentRunResult, AiAutonomyLevel, CodexDetectionResult, DecoupleImageResult, DecoupleManifest,
    DecoupledLayerResult, GeneratedImageResult, WorkflowSourceImage, GENERATION_TIMEOUT,
    POLL_INTERVAL,
};
use crate::png::{is_png, png_data_url, png_dimensions_from_bytes, read_png_data_url};
use crate::project::{
    add_asset, safe_stem, store_generated_png_asset, write_asset_file, ProjectAsset,
};

#[derive(Debug, Default)]
struct AntigravityCommandOptions {
    model: Option<String>,
    approval_mode: Option<String>,
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
    timeout: Duration,
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
    let model = clean_option(model).filter(|value| value != "auto");
    let approval_mode = clean_option(approval_mode);
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

pub(crate) fn antigravity_generate_prompt(
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
pub(crate) async fn generate_antigravity_image(
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
pub(crate) async fn generate_antigravity_retouch_image(
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
pub(crate) async fn decouple_antigravity_image(
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
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::ANTIGRAVITY_RUNS_DIR;
    use crate::ai::{TempJobDir, PAINTNODE_WORK_DIR};

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
}
