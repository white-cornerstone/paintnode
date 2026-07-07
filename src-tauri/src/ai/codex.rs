//! Codex CLI provider: prompts, command building, cached-PNG discovery, commands.

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

use tauri::AppHandle;

use crate::ai::canvas::{
    ai_candidate_rejection, ai_edit_checks_level, ai_retouch_editable_mask_png,
    ai_working_canvas_accepts_result_dimensions, read_png_bytes_cropped_to_ai_working_canvas,
    remove_rejected_ai_candidate, validate_optional_target_dimensions, AiWorkingCanvas,
    AI_CHROMA_KEY_HEX, AI_PROTECTED_DRIFT_MAX_ATTEMPTS, AI_RETOUCH_OUTPUT_MASK_FEATHER_RADIUS,
    AI_RETOUCH_OUTPUT_MASK_GROW_RADIUS, AI_SEAM_RETRY_NOTE,
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
    cover_crop_png_to_dimensions, normalize_storyboard_draft_png, plan_ai_edit_placement,
    plan_ai_fill_placement, plan_ai_restore_placement, prepare_ai_job_dir_for_placement,
    resize_png_to_dimensions, reuse_part_result, AiEditComposer, AiEditPlacement, AiEditProvider,
    AiFillMethod, AiFillRedundancy, AI_RESTORE_UPSCALE_THRESHOLD,
};
use crate::ai::{
    ai_autonomy_level, ai_job_project_dir, ai_retouch_asset_name, ai_run_cancelled,
    apply_ai_cli_environment, clean_option, cleanup_project_agent_job, cleanup_project_job_enabled,
    clear_ai_run_cancelled, codex_agent_message_text, command_failure, copy_png_candidate,
    emit_codex_part_progress, emit_codex_progress, emit_kept_job_dir,
    image_agent_autonomy_contract, now_id, optional_project_dir, output_tail,
    project_agent_run_dir, project_agent_run_dir_for_run, reference_prompt_note,
    remove_legacy_generative_fill_agent_inputs, safe_job_child_path, safe_png_source_file_name,
    should_keep_job_dir, spawn_output_reader, synthesize_decouple_asset_manifest,
    unique_child_path, validate_reference_pngs, write_ai_job_prompt, write_reference_pngs,
    AgentRunResult, AiAutonomyLevel, CodexDetectionResult, DecoupleImageResult, DecoupleManifest,
    DecoupledLayerResult, GeneratedImageLayerResult, GeneratedImageResult, TempJobDir,
    WorkflowSourceImage, AI_RUN_STOPPED_MESSAGE, CODEX_RUNS_DIR, POLL_INTERVAL,
};
use crate::png::{
    file_has_png_signature, is_png, png_data_url, png_dimensions, png_dimensions_from_bytes,
    read_png_data_url,
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

#[derive(Debug, Default)]
struct CodexCommandOptions {
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
}

#[derive(Debug)]
struct CodexImageRunResult {
    run: AgentRunResult,
    image_cached_before_exit: bool,
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

fn final_codex_agent_message(output: &Output) -> Option<String> {
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

fn run_codex_with_progress_until_cached_png(
    command: &mut Command,
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

    Ok(CodexImageRunResult {
        run: AgentRunResult {
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

fn configured_or_default_codex_bin(bin: Option<String>) -> Result<String, String> {
    if let Some(bin) = bin.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
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

fn codex_command_options(
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
) -> CodexCommandOptions {
    CodexCommandOptions {
        model: clean_option(model),
        reasoning_effort: clean_option(reasoning_effort),
        service_tier: clean_option(service_tier),
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

pub(crate) fn codex_prompt(
    user_prompt: &str,
    autonomy: AiAutonomyLevel,
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
- Use the largest image size / highest output resolution your image-generation tool supports.
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
    json_progress: bool,
) -> Command {
    let mut command = Command::new(codex_bin);
    apply_ai_cli_environment(&mut command)
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
        command.arg(codex_prompt(prompt.trim(), autonomy, reference_names));
    } else {
        command.arg("-i");
        for path in reference_paths {
            command.arg(path);
        }
        command
            .arg("--")
            .arg(codex_prompt(prompt.trim(), autonomy, reference_names));
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
    apply_ai_cli_environment(&mut command)
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
    geometry_note: &str,
    storyboard_note: &str,
    storyboard_anchor: bool,
    storyboard_fallback: bool,
    has_overview: bool,
    has_storyboard_draft: bool,
    reference_names: &[String],
) -> String {
    let autonomy_contract = image_agent_autonomy_contract(autonomy, "Codex");
    let task_intro = "Use $imagegen to perform one PaintNode generative fill.";
    let managed_method_requirements = if autonomy == AiAutonomyLevel::Unmanaged {
        "- Use the normal Codex image-generation flow for the visual fill. PaintNode owns deterministic crop, paste-back, masking, and import from `placement.json`; do not try to apply a mask yourself.\n"
    } else {
        "- Use the normal Codex image-generation flow for the visual fill. PaintNode owns deterministic crop, paste-back, masking, and import from `placement.json`; do not try to apply a mask yourself.\n- Do not create, edit, or delete files in the working directory except `result.png`.\n"
    };
    let reference_note = reference_prompt_note(reference_names, "");
    let has_storyboard = !storyboard_note.trim().is_empty();
    let overview_note = if has_overview {
        "\n2. `overview.png` may be present as a downscaled surrounding-document preview with a red outline around this local frame. Use it only as non-editable composition and continuity guidance. `source.png` is the only base/edit image; never use `overview.png` as the source or base image, never copy its pixels or resolution, and never reproduce the red outline."
    } else {
        ""
    };
    if has_storyboard_draft {
        return format!(
            r#"Use $imagegen to perform one PaintNode draft enhancement.

Input files:
1. `source.png` is the PaintNode edit frame to enhance. It already contains the orchestrator's rough low-detail visual draft.
{overview_note}

{geometry_note}

Task:
- This is an image enhancement/restoration pass at the same size, not a new composition, new generative fill, outpaint, story continuation, or scene redesign.
- Improve clarity, texture, natural detail, edge quality, lighting consistency, and local realism only for pixels already visible in the low-detail draft.
- Preserve the exact subject count, object count, identities/classes, poses, placement, scale, camera angle, horizon, shoreline, lighting, colors, and activities already visible in `source.png`.
- Do not add, remove, duplicate, replace, move, resize, re-pose, or reinterpret any visible person, object, prop, landform, wave, cloud, or scene element.
- If a draft area is soft or ambiguous, refine the existing visible shapes conservatively instead of inventing extra content.

{autonomy_contract}

Requirements:
- Save the final PNG as `result.png` in the current working directory. This file is required.
- Treat `result.png` as an in-place enhancement of `source.png`, not as a newly composed independent image.
- When using the image-generation tool, use `source.png` as the only base image. Do not use `overview.png` as the image source, edit target, or output template.
- Keep the attached frame registered: no crop, zoom, reframe, or shift.
- PaintNode will crop, paste, and apply the editable mask after import. Do not draw mask edges, gray buffers, borders, or guides into the pixels.
- Do not include PaintNode UI, checkerboard transparency pattern, selection outlines, red guide marks, borders, labels, or mask visualization in the output.
{managed_method_requirements}
- Do not ask follow-up questions.
- If a safety or quality adjustment is needed, make a reasonable compliant rephrasing while preserving the existing visible draft content and composition.

Final response should be one short sentence confirming `result.png` was created."#
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

{storyboard_note}{fallback_prompt}

{autonomy_contract}

Requirements:
- Save the final PNG as `result.png` in the current working directory. This file is required.
- Treat `result.png` as an in-place edit of `source.png`, not as a newly composed independent image.
{storyboard_instruction_note}
- When using the image-generation tool, use `source.png` as the only base image. Do not use `overview.png` as the image source, edit target, or output template.
- Keep the attached frame registered: no crop, zoom, reframe, or shift.
- PaintNode will crop, paste, and apply the editable mask after import. Do not draw mask edges, gray buffers, borders, or guides into the pixels.
- Do not include PaintNode UI, checkerboard transparency pattern, selection outlines, red guide marks, borders, labels, or mask visualization in the output.
{managed_method_requirements}
- Do not ask follow-up questions.
- If a safety or quality adjustment is needed, make a reasonable compliant rephrasing and continue.

Final response should be one short sentence confirming `result.png` was created."#
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

{storyboard_note}

{user_prompt_heading}
{prompt}

{autonomy_contract}

Requirements:
- Prefer one full PNG with the exact same framing as `source.png`.
- Save the final PNG as `result.png` in the current working directory. This file is required.
- Treat `result.png` as an in-place edit of `source.png`, not as a newly composed photograph.
- When using the image-generation tool, use `source.png` as the only base image. Do not use `overview.png` as the image source, edit target, or output template.
- Fill the intended editable/empty area implied by the attached frame and prompt, matching surrounding scene, perspective, lighting, focus, color, grain, and camera style.
- Keep existing visible context stable and registered. PaintNode will crop, paste, and apply the editable mask after import.
- Do not include PaintNode UI, checkerboard transparency pattern, selection outlines, red guide marks, borders, labels, or mask visualization in the output.
- If extending a real photo, avoid inventing crisp readable text in newly generated distant signs or advertisements; partial or indistinct text is preferable.
{managed_method_requirements}
- Do not ask follow-up questions.
- If a safety or quality adjustment is needed, make a reasonable compliant rephrasing and continue.

Final response should be one short sentence confirming `result.png` was created."#
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
    json_progress: bool,
) -> Command {
    let mut command = Command::new(codex_bin);
    apply_ai_cli_environment(&mut command)
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
    command.arg("-i").arg(job_path.join("source.png"));
    if has_overview {
        command.arg(job_path.join("overview.png"));
    }
    for path in storyboard_draft_paths {
        command.arg(path);
    }
    for path in reference_paths {
        command.arg(path);
    }
    command
        .arg("--")
        .arg(prompt_text)
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY");
    command
}

fn build_fill_storyboard_codex_command(
    codex_bin: &str,
    job_path: &Path,
    prompt_text: &str,
    has_overview: bool,
    reference_paths: &[PathBuf],
    options: &CodexCommandOptions,
    json_progress: bool,
) -> Command {
    let mut command = Command::new(codex_bin);
    apply_ai_cli_environment(&mut command)
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
    if has_overview {
        command
            .arg("-i")
            .arg(job_path.join(FILL_STORYBOARD_OVERVIEW_FILE));
        for path in reference_paths {
            command.arg(path);
        }
    } else if !reference_paths.is_empty() {
        command.arg("-i");
        for path in reference_paths {
            command.arg(path);
        }
    }
    command
        .arg("--")
        .arg(prompt_text)
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY");
    command
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

fn ai_retouch_prompt(
    prompt: &str,
    has_annotated_source: bool,
    has_reference: bool,
    reference_names: &[String],
    autonomy: AiAutonomyLevel,
    geometry_note: &str,
) -> String {
    let attached_image_notes =
        ai_retouch_attached_image_notes(has_annotated_source, has_reference, reference_names);
    let autonomy_contract = image_agent_autonomy_contract(autonomy, "Codex");
    let managed_method_requirements = if autonomy == AiAutonomyLevel::Unmanaged {
        "Use the normal Codex image-generation flow and keep the generated image in Codex's generated-images cache."
    } else {
        "Use the normal Codex image-generation flow and keep the generated image in Codex's generated-images cache.\nDo not create, edit, copy, verify, or delete files in the working directory.\nYou do not need to copy the generated PNG to `result.png`, crop, resize, write helper scripts, or prove exact pixel preservation. Those are deterministic PaintNode responsibilities. The mask is attached as a separate user-editable layer mask and is never baked into your candidate, so protected pixels must stay visually identical in the candidate itself."
    };
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

{geometry_note}

Critical registration rule:
Do not translate, shift, crop, zoom, rotate, scale, stretch, warp, resize, reframe, straighten, or change the camera perspective.
The output must stay registered to the input image.

Before using image generation, inspect `source.png`, `edit_target.png`, and `mask.png` and identify the actual stable registration anchors from the visible pixels.
When invoking image generation, include only those image-specific anchors you observed from the attached inputs.
Do not use or invent a generic anchor checklist.

If the requested edit cannot be completed without moving, resizing, or reframing the subject or camera, simplify the edit instead.

User retouch prompt:
{prompt}

{autonomy_contract}

Retouch scope:
Only change pixels necessary to satisfy the user retouch prompt.
The visible edit must stay inside the white/gray mask footprint.
Do not use the mask as an instruction to repaint everything inside it. Treat `mask.png` as the maximum allowed edit area.
Do not change unrequested content inside the mask.
PaintNode imports your candidate as a new layer and attaches `mask.png` as a separate linked layer mask: white-mask pixels show your candidate and black/transparent-mask pixels keep the original visible. The mask is never baked into your candidate's pixels, so the user can still edit the mask afterwards.
Because of that, make your generated candidate visually identical to `source.png` everywhere `mask.png` is black or transparent. Do not clean up, enhance, crop out, remove, sharpen, denoise, recolor, relight, straighten, or reframe any protected area.
Keep every newly generated, removed, replaced, reconstructed, relit, recolored, cleaned, extended, blended, shadowed, reflected, or otherwise changed visible pixel inside the white/gray mask footprint.
Any edit whose visible change extends outside the mask is a failed retouch, even though the app masks the imported layer afterward. Scale, simplify, or localize the requested change so the complete visible edit fits inside the mask footprint.

Person preservation:
You may redraw clothing inside the editable area.
Do not move or rescale the person.
Preserve the original pose, head location, gaze, expression, body proportions, silhouette alignment, lighting direction, focus, grain, and camera style.
If the prompt changes clothing or accessories, preserve the person's identity, face, hair, skin, hands, pose, body proportions, expression, gaze, and all unrequested surrounding content unless the user explicitly asks to alter those details.

Locked context:
Black or transparent mask areas are locked. They must look copied from the original image.
Do not clean up, enhance, denoise, sharpen, recolor, relight, beautify, or reinterpret locked context.
If `annotated_source.png` is attached, use its arrows, labels, and callout positions as guidance for what each nearby mask region should become.
For text, logos, painted marks, signs, glare, or surface blemishes, remove only the foreground mark and reconstruct the continuous underlying surface. Do not cover it with a flat rectangle, paint swatch, or unrelated color block.
Match the surrounding scene, perspective, lighting, focus, color, texture, grain, and camera style.

Output requirements:
Return one full-canvas PNG candidate with the same dimensions and framing as `edit_target.png`.
Do not include PaintNode UI, checkerboard transparency, selection outlines, borders, labels, red arrows, yellow callout boxes, annotation text, guide marks, or mask visualization.
{managed_method_requirements}
Do not ask follow-up questions.
If a safety or quality adjustment is needed, make a reasonable compliant rephrasing and continue.

Final response:
One short sentence confirming the AI retouch image was generated."#
    )
}

fn build_ai_retouch_codex_command(
    codex_bin: &str,
    job_path: &Path,
    prompt_text: &str,
    has_annotated_source: bool,
    has_reference: bool,
    has_overview: bool,
    reference_paths: &[PathBuf],
    options: &CodexCommandOptions,
    json_progress: bool,
) -> Command {
    let mut command = Command::new(codex_bin);
    apply_ai_cli_environment(&mut command)
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
    if has_overview {
        command.arg(job_path.join("overview.png"));
    }
    for path in reference_paths {
        command.arg(path);
    }
    command
        .arg("--")
        .arg(prompt_text)
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
    apply_ai_cli_environment(&mut command)
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
        let (reference_paths, reference_names) =
            write_reference_pngs(&job_path, &reference_pngs, "Generate image")?;
        write_ai_job_prompt(
            &job_path,
            &codex_prompt(prompt.trim(), autonomy, &reference_names),
            "Codex image generation",
        )?;
        emit_kept_job_dir(&app, &run_id, &job_path, keep_job_dir);
        // A failed previous attempt may have gotten past generation; reuse its
        // image instead of paying for another one.
        let (recovered_source_path, staged_result_path) = if let Some(previous) =
            newest_previous_generated_png(&job_path)
        {
            emit_codex_progress(&app, &run_id, "Reusing the previously generated image");
            (previous.clone(), previous)
        } else {
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
                true,
            );
            let mut run = run_codex_with_progress(&mut command, app.clone(), run_id.clone())
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
                    false,
                );
                run = run_codex_with_progress(&mut fallback, app.clone(), run_id.clone())
                    .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;
            }

            if !run.output.status.success() {
                if let Some(message) = final_codex_agent_message(&run.output) {
                    return Err(format!("Codex did not generate an image.\n\n{message}"));
                }
                return Err(command_failure("Codex", &run.output));
            }

            let Some(copied) =
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
                    "Codex completed without exposing a generated PNG that PaintNode could copy."
                        .into()
                };
                return Err(format!(
                    "PaintNode could not find a new PNG in Codex's generated-images cache.\n\n{detail}"
                ));
            };
            copied
        };

        emit_codex_progress(&app, &run_id, "Reading copied PNG");
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
                bytes = codex_restore_image_details(
                    &app,
                    &run_id,
                    &codex_bin,
                    &codex_options,
                    autonomy,
                    &job_path.join("restore"),
                    &bytes,
                    "Generated image restoration",
                )?;
                fs::write(job_path.join("restore").join("result.png"), &bytes).map_err(|e| {
                    format!("Failed to write restored generated image: {e}")
                })?;
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
    let mut run = run_codex_with_progress(&mut command, app.clone(), run_id.to_string())
        .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;

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
        run = run_codex_with_progress(&mut fallback, app.clone(), run_id.to_string())
            .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;
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

/// Run one generative-fill placement part end-to-end: launch Codex on the
/// part folder, recover `result.png` or the newest cached PNG, and normalize
/// it to the part's crop size.
#[allow(clippy::too_many_arguments)]
fn run_codex_fill_part(
    app: &AppHandle,
    run_id: &str,
    codex_bin: &str,
    options: &CodexCommandOptions,
    part_path: &Path,
    prompt_text: &str,
    has_overview: bool,
    storyboard_draft_paths: &[PathBuf],
    reference_paths: &[PathBuf],
    working: &AiWorkingCanvas,
) -> Result<CodexPartRun, String> {
    let codex_started_at = SystemTime::now();
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
    let mut run = run_codex_with_progress(&mut command, app.clone(), run_id.to_string())
        .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;

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
        run = run_codex_with_progress(&mut fallback, app.clone(), run_id.to_string())
            .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;
    }

    if !run.output.status.success() {
        if let Some(message) = final_codex_agent_message(&run.output) {
            return Err(format!("Codex did not generate a fill image.\n\n{message}"));
        }
        return Err(command_failure("Codex generative fill", &run.output));
    }

    let requested_result_path = part_path.join("result.png");
    let (recovered_source_path, staged_result_path) = if requested_result_path.exists() {
        (requested_result_path.clone(), requested_result_path)
    } else {
        let Some((recovered_source_path, staged_result_path)) =
            copy_codex_cached_png_to_job(part_path, run.thread_id.as_deref(), codex_started_at)?
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

    emit_codex_progress(app, run_id, "Reading generative fill PNG");
    let (normalized_png, result_dimensions, normalized) =
        read_png_bytes_cropped_to_ai_working_canvas(
            &staged_result_path,
            working,
            "Codex generative fill",
        )?;
    Ok(CodexPartRun {
        normalized_png,
        result_dimensions,
        normalized,
        recovered_source_path,
    })
}

/// Run one AI-retouch placement part end-to-end, stopping Codex as soon as a
/// usable cached PNG for this part appears.
#[allow(clippy::too_many_arguments)]
fn run_codex_retouch_part(
    app: &AppHandle,
    run_id: &str,
    codex_bin: &str,
    options: &CodexCommandOptions,
    part_path: &Path,
    prompt_text: &str,
    has_annotated_source: bool,
    has_reference: bool,
    has_overview: bool,
    reference_paths: &[PathBuf],
    working: &AiWorkingCanvas,
) -> Result<CodexPartRun, String> {
    let codex_started_at = SystemTime::now();
    let mut command = build_ai_retouch_codex_command(
        codex_bin,
        part_path,
        prompt_text,
        has_annotated_source,
        has_reference,
        has_overview,
        reference_paths,
        options,
        true,
    );
    let mut image_run = run_codex_with_progress_until_cached_png(
        &mut command,
        app.clone(),
        run_id.to_string(),
        codex_started_at,
        working,
    )
    .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;

    if !image_run.image_cached_before_exit
        && !image_run.run.output.status.success()
        && output_mentions_unsupported_json(&image_run.run.output)
    {
        emit_codex_progress(
            app,
            run_id,
            "Codex progress stream unavailable; retrying AI retouch",
        );
        let mut fallback = build_ai_retouch_codex_command(
            codex_bin,
            part_path,
            prompt_text,
            has_annotated_source,
            has_reference,
            has_overview,
            reference_paths,
            options,
            false,
        );
        image_run = run_codex_with_progress_until_cached_png(
            &mut fallback,
            app.clone(),
            run_id.to_string(),
            codex_started_at,
            working,
        )
        .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;
    }

    if !image_run.image_cached_before_exit && !image_run.run.output.status.success() {
        if let Some(message) = final_codex_agent_message(&image_run.run.output) {
            return Err(format!(
                "Codex did not generate an AI retouch image.\n\n{message}"
            ));
        }
        return Err(command_failure("Codex AI retouch", &image_run.run.output));
    }

    let cached_results = copy_codex_cached_pngs_to_job(
        part_path,
        image_run.run.thread_id.as_deref(),
        codex_started_at,
    )?;
    let requested_result_path = part_path.join("result.png");
    let (recovered_source_path, staged_result_path) = if let Some((
        recovered_source_path,
        staged_result_path,
    )) = cached_results.last().cloned()
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
            "PaintNode could not find an AI retouch PNG in Codex's generated-images cache.".into(),
        );
    };
    let (normalized_png, result_dimensions, normalized) =
        read_png_bytes_cropped_to_ai_working_canvas(
            &staged_result_path,
            working,
            "AI retouch candidate",
        )?;
    Ok(CodexPartRun {
        normalized_png,
        result_dimensions,
        normalized,
        recovered_source_path,
    })
}

fn codex_restore_prompt(autonomy: AiAutonomyLevel, geometry_note: &str) -> String {
    let autonomy_contract = image_agent_autonomy_contract(autonomy, "Codex");
    let managed_method_requirements = if autonomy == AiAutonomyLevel::Unmanaged {
        "Use the normal Codex image-generation flow and keep the generated image in Codex's generated-images cache."
    } else {
        "Use the normal Codex image-generation flow and keep the generated image in Codex's generated-images cache.\nDo not create, edit, copy, verify, or delete files in the working directory.\nYou do not need to copy the generated PNG to `result.png`, crop, resize, or write helper scripts. Those are deterministic PaintNode responsibilities."
    };
    format!(
        r#"Use $imagegen to perform one in-place PaintNode detail restoration.

This is a fixed-canvas image refinement task, not a new image generation task.

Attached images:
1. `source.png` is the image region to restore. It was enlarged from a lower-resolution image, so it is soft and lacks fine detail.
2. `edit_target.png` is the same image to re-render in place.
3. `mask.png` marks the editable area. White pixels are editable. Gray pixels are a feathered hand-off band into already-restored content; PaintNode cross-fades your result there, so render that band seamlessly consistent with the neighboring restored pixels. Black or transparent pixels were already restored and must remain unchanged.

{geometry_note}

Restoration goal:
Re-render this exact image with crisp, natural, high-frequency detail: sharp edges and realistic texture for skin, hair, fabric, foliage, and surfaces.
Preserve the composition, framing, camera geometry, subjects, identities, poses, expressions, colors, lighting, and style exactly.
Match the color balance, tone, brightness, contrast, grain, and detail level of the already-restored areas exactly, so the result joins them without visible seams.
Do not add, remove, move, restyle, or reinterpret any content.
Do not change global brightness, contrast, or color balance.
If a detail is too blurred to identify, render a plausible neutral texture instead of inventing new objects, readable text, faces, or logos.

Critical registration rule:
Do not translate, shift, crop, zoom, rotate, scale, stretch, warp, resize, reframe, straighten, or change the camera perspective.
The output must stay registered to the input image.

{autonomy_contract}

Output requirements:
Return one full-canvas PNG candidate with the same framing as `edit_target.png`, at the highest output resolution available to you.
Do not include PaintNode UI, borders, labels, watermarks, or mask visualization.
{managed_method_requirements}
Do not ask follow-up questions.

Final response:
One short sentence confirming the restored image was generated."#
    )
}

/// Run a tiled detail-restoration pass over an enlarged image: every part is
/// regenerated at model-native density and pasted back at its position.
fn codex_restore_image_details(
    app: &AppHandle,
    run_id: &str,
    codex_bin: &str,
    options: &CodexCommandOptions,
    autonomy: AiAutonomyLevel,
    restore_root: &Path,
    enlarged_png: &[u8],
    label: &str,
) -> Result<Vec<u8>, String> {
    let dimensions = png_dimensions_from_bytes(enlarged_png)
        .ok_or_else(|| format!("{label} PNG dimensions are invalid."))?;
    let placement = plan_ai_restore_placement(AiEditProvider::Codex, dimensions, label)?;
    let mut composer = AiEditComposer::new_full_coverage(enlarged_png, label)?;
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
                composer.apply_part_result(part, &bytes, label)?;
                continue;
            }
            let _ = fs::remove_file(part_path.join("part_result.png"));
            let _ = fs::remove_file(part_path.join("result.png"));
        }
        let inputs = composer.part_inputs(part, label)?;
        fs::write(part_path.join("source.png"), &inputs.source_png)
            .map_err(|e| format!("Failed to write {label} source image: {e}"))?;
        fs::write(part_path.join("edit_target.png"), &inputs.edit_target_png)
            .map_err(|e| format!("Failed to write {label} edit target image: {e}"))?;
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
        let prompt_text = codex_restore_prompt(autonomy, &geometry_note);
        write_ai_job_prompt(&part_path, &prompt_text, label)?;
        emit_codex_part_progress(
            app,
            run_id,
            part_index,
            placement.parts.len(),
            ai_part_progress_message(&placement, part_index, "Restoring image detail with Codex"),
        );
        let part_run = run_codex_retouch_part(
            app,
            run_id,
            codex_bin,
            options,
            &part_path,
            &prompt_text,
            false,
            false,
            has_overview,
            &[],
            &part.working,
        )
        .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?;
        fs::write(part_path.join("part_result.png"), &part_run.normalized_png)
            .map_err(|e| format!("Failed to record {label} part result: {e}"))?;
        composer.apply_part_result(part, &part_run.normalized_png, label)?;
    }
    composer.composed_png(label)
}

/// Run local Codex headlessly for a mask-guided generative fill.
#[tauri::command]
pub(crate) async fn generate_codex_fill_image(
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
    edit_checks_level: Option<u8>,
    fill_aspect_ratio: Option<String>,
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
        let codex_bin = configured_or_default_codex_bin(bin)?;
        let codex_options = codex_command_options(model, reasoning_effort, service_tier);
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
            project_agent_run_dir_for_run(job_project_dir, CODEX_RUNS_DIR, "fill", &run_id)?
        } else {
            temp_job = TempJobDir::new("paintnode-fill")?;
            temp_job.path().to_path_buf()
        };

        let placement = plan_ai_fill_placement(
            AiEditProvider::Codex,
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
        let storyboard = prepare_codex_fill_storyboard(
            &app,
            &run_id,
            &codex_bin,
            &codex_options,
            &job_path,
            &placement,
            &composer,
            prompt.trim(),
            &reference_pngs,
        )?;

        let mut recovered_source_path: Option<PathBuf> = None;
        let return_part_layers = placement.is_split();
        let mut layer_results = Vec::new();
        let mut layer_assets = Vec::new();
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
            let has_overview = placement.is_split();
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
            let base_prompt_text = generative_fill_prompt(
                prompt.trim(),
                autonomy,
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
                    "Starting local Codex generative fill",
                ),
            );
            let result_path = part_path.join("result.png");
            write_ai_job_prompt(&part_path, &base_prompt_text, "Codex generative fill")?;
            let part_run = run_codex_fill_part(
                &app,
                &run_id,
                &codex_bin,
                &codex_options,
                &part_path,
                &base_prompt_text,
                has_overview && (!has_storyboard_draft || part_index > 0),
                &storyboard_draft_paths,
                &reference_paths,
                &part.working,
            )
            .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?;
            if part_run.normalized {
                emit_codex_progress(
                    &app,
                    &run_id,
                    ai_part_progress_message(
                        &placement,
                        part_index,
                        &format!(
                            "Normalized Codex fill from {}x{} to {}x{}",
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
        let assets = if return_part_layers {
            layer_assets
        } else {
            asset.iter().cloned().collect()
        };
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
        let codex_bin = configured_or_default_codex_bin(bin)?;
        let codex_options = codex_command_options(model, reasoning_effort, service_tier);
        let autonomy = ai_autonomy_level(autonomy_level);
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
            let base_prompt_text = ai_retouch_prompt(
                prompt.trim(),
                has_annotated_source,
                has_reference,
                &reference_names,
                autonomy,
                &geometry_note,
            );

            emit_codex_part_progress(
                &app,
                &run_id,
                part_index,
                placement.parts.len(),
                ai_part_progress_message(&placement, part_index, "Starting local Codex AI retouch"),
            );
            let result_path = part_path.join("result.png");
            let mut accepted_run = None;
            let mut retry_note = "";
            for attempt in 0..AI_PROTECTED_DRIFT_MAX_ATTEMPTS {
                let prompt_text = if retry_note.is_empty() {
                    base_prompt_text.clone()
                } else {
                    format!("{base_prompt_text}\n\n{retry_note}")
                };
                write_ai_job_prompt(&part_path, &prompt_text, "Codex AI retouch")?;
                let part_run = run_codex_retouch_part(
                    &app,
                    &run_id,
                    &codex_bin,
                    &codex_options,
                    &part_path,
                    &prompt_text,
                    has_annotated_source,
                    has_reference,
                    has_overview,
                    &reference_paths,
                    &part.working,
                )
                .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?;
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
                // Result checks: in-place drift, then seam continuity when
                // the user's check level enables it.
                let rejection = ai_candidate_rejection(
                    checks_level,
                    &inputs.edit_target_png,
                    &inputs.source_png,
                    &inputs.mask_png,
                    &part_run.normalized_png,
                    "AI retouch candidate",
                )
                .map_err(|e| ai_part_progress_message(&placement, part_index, &e))?;
                let Some(rejection) = rejection else {
                    accepted_run = Some(part_run);
                    break;
                };
                retry_note = if rejection.continuation_retry {
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
            let part_run = accepted_run
                .ok_or_else(|| "AI retouch produced no accepted candidate.".to_string())?;
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
    source_png: Vec<u8>,
    scale_percent: u32,
    run_id: String,
    model: Option<String>,
    reasoning_effort: Option<String>,
    service_tier: Option<String>,
    autonomy_level: Option<String>,
) -> Result<GeneratedImageResult, String> {
    if !is_png(&source_png) {
        return Err("AI upscale source is not a PNG image.".into());
    }
    let source_dimensions = png_dimensions_from_bytes(&source_png)
        .ok_or_else(|| "AI upscale source PNG dimensions are invalid.".to_string())?;
    let target_dimensions = ai_upscale_target_dimensions(source_dimensions, scale_percent)?;
    // Reject over-large jobs before allocating the enlarged image.
    plan_ai_restore_placement(AiEditProvider::Codex, target_dimensions, "AI upscale")?;

    tauri::async_runtime::spawn_blocking(move || -> Result<GeneratedImageResult, String> {
        let codex_bin = configured_or_default_codex_bin(bin)?;
        let codex_options = codex_command_options(model, reasoning_effort, service_tier);
        let autonomy = ai_autonomy_level(autonomy_level);
        let run_id = if run_id.trim().is_empty() {
            format!("upscale-{}", now_id())
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

        let bytes = codex_restore_image_details(
            &app,
            &run_id,
            &codex_bin,
            &codex_options,
            autonomy,
            &job_path,
            &enlarged_png,
            "AI upscale",
        )?;
        fs::write(job_path.join("result.png"), &bytes)
            .map_err(|e| format!("Failed to write AI upscale result: {e}"))?;
        let data_url = png_data_url(&bytes)?;
        let mut assets = Vec::new();
        let asset = if let Some(project_dir) = project_dir {
            emit_codex_progress(&app, &run_id, "Saving upscaled image to the project");
            let primary_asset = store_generated_png_asset(
                &project_dir,
                &bytes,
                format!("AI Upscale {scale_percent}%"),
                Some(format!("AI upscale to {scale_percent}%")),
                None,
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
            mask_data_url: None,
            layers: Vec::new(),
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
        let mut run = run_codex_with_progress(&mut command, app.clone(), run_id.clone())
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
            run = run_codex_with_progress(&mut fallback, app.clone(), run_id.clone())
                .map_err(|e| format!("Failed to run Codex at '{codex_bin}': {e}"))?;
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
        let mut run = run_codex_with_progress(&mut command, app.clone(), run_id.clone())
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
            run = run_codex_with_progress(&mut fallback, app.clone(), run_id.clone())
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
            let asset = ProjectAsset::generated_png(
                id,
                relative_path,
                format!(
                    "Workflow: {}",
                    prompt.trim().chars().take(48).collect::<String>()
                ),
                Some(prompt.trim().into()),
                recovered_source_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_string),
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
            );
            let command = build_codex_command(
                "codex",
                job.path(),
                "make an image",
                &[],
                &[],
                &options,
                AiAutonomyLevel::Low,
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
    fn codex_command_uses_augmented_cli_path() {
        let job = TempJobDir::new("paintnode-codex-path-test").expect("temp dir");
        let command = build_codex_command(
            "codex",
            job.path(),
            "make an image",
            &[],
            &[],
            &CodexCommandOptions::default(),
            AiAutonomyLevel::Low,
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

    const TEST_GEOMETRY_NOTE: &str =
        "PaintNode image geometry:\n- The attached images are the full PaintNode document.";

    #[test]
    fn unmanaged_autonomy_prompts_omit_method_guardrails() {
        let prompt = codex_prompt("make an image", AiAutonomyLevel::Unmanaged, &[]);
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
            TEST_GEOMETRY_NOTE,
        );
        assert!(retouch.contains("Autonomy level: Unmanaged"));
        assert!(retouch.contains("Use $imagegen"));
        assert!(retouch.contains("normal Codex image-generation flow"));
        assert!(!retouch.contains("Do not create, edit, copy, verify, or delete files"));
        assert!(!retouch.contains("write helper scripts"));

        let fill = generative_fill_prompt(
            "extend photo",
            AiAutonomyLevel::Unmanaged,
            TEST_GEOMETRY_NOTE,
            "",
            false,
            false,
            false,
            false,
            &[],
        );
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
        assert_eq!(args[image_idx + 2], reference_paths[0].to_string_lossy());
        assert_eq!(args[image_idx + 3], "--");
        assert!(!args
            .iter()
            .any(|arg| arg == &job.path().join("edit_target.png").to_string_lossy()));
        assert!(!args
            .iter()
            .any(|arg| arg == &job.path().join("mask.png").to_string_lossy()));
        let prompt_arg = &args[image_idx + 4];
        assert!(prompt_arg.contains("the full PaintNode document"));
        assert!(!prompt_arg.contains("chroma"));
        assert!(!prompt_arg.contains("#00ff00"));
        assert!(!prompt_arg.contains("centered content rectangle"));
        assert!(prompt_arg.contains("PaintNode will crop, paste, and apply the editable mask"));
        assert!(!prompt_arg.contains("edit_target.png"));
        assert!(!prompt_arg.contains("mask.png"));
        assert!(prompt_arg.contains("Save the final PNG as `result.png`"));
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
    fn fill_and_retouch_commands_attach_overview_for_split_parts() {
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
        let fill_args = fill
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        let source_idx = fill_args
            .iter()
            .position(|arg| *arg == job.path().join("source.png").to_string_lossy())
            .expect("source arg");
        assert_eq!(
            fill_args[source_idx + 1],
            job.path().join("overview.png").to_string_lossy()
        );
        assert_eq!(fill_args[source_idx + 2], "--");
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

        let retouch = build_ai_retouch_codex_command(
            "codex",
            job.path(),
            "prompt",
            false,
            false,
            true,
            &[],
            &CodexCommandOptions::default(),
            true,
        );
        let retouch_args = retouch
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        let mask_idx = retouch_args
            .iter()
            .position(|arg| *arg == job.path().join("mask.png").to_string_lossy())
            .expect("mask arg");
        assert_eq!(
            retouch_args[mask_idx + 1],
            job.path().join("overview.png").to_string_lossy()
        );
    }

    #[test]
    fn ai_retouch_command_attaches_optional_guidance_before_reference() {
        let job = TempJobDir::new("paintnode-retouch-command-test").expect("temp dir");
        let prompt_text = ai_retouch_prompt(
            "remove glare",
            true,
            true,
            &[],
            AiAutonomyLevel::Low,
            TEST_GEOMETRY_NOTE,
        );
        let command = build_ai_retouch_codex_command(
            "codex",
            job.path(),
            &prompt_text,
            true,
            true,
            false,
            &[],
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
        let prompt_arg = &args[image_idx + 7];
        assert!(prompt_arg.contains("Use $imagegen to perform one in-place PaintNode retouch"));
        assert!(prompt_arg.contains("the full PaintNode document"));
        assert!(!prompt_arg.contains("chroma"));
        assert!(!prompt_arg.contains("#00ff00"));
        assert!(!prompt_arg.contains("centered content rectangle"));
        assert!(prompt_arg.contains("Black pixels are locked context"));
        assert!(!prompt_arg.contains("PaintNode will crop"));
        assert!(prompt_arg.contains("`annotated_source.png` is an optional guide image"));
        assert!(prompt_arg.contains("arrows, labels, and callout positions as guidance"));
        assert!(prompt_arg.contains("red arrows, yellow callout boxes, annotation text"));
        assert!(prompt_arg.contains("User retouch prompt:\nremove glare"));
        // The mask is attached as a separate editable layer mask, never baked
        // into the candidate's pixels.
        assert!(prompt_arg.contains("attaches `mask.png` as a separate linked layer mask"));
        assert!(prompt_arg.contains("never baked into your candidate's pixels"));
        assert!(prompt_arg.contains(
            "visually identical to `source.png` everywhere `mask.png` is black or transparent"
        ));
        assert!(prompt_arg.contains("Do not clean up, enhance, crop out, remove"));
        assert!(prompt_arg.contains("maximum allowed edit area"));
        assert!(prompt_arg.contains(
            "every newly generated, removed, replaced, reconstructed, relit, recolored, cleaned, extended, blended, shadowed, reflected, or otherwise changed visible pixel inside the white/gray mask footprint"
        ));
        assert!(prompt_arg.contains("visible change extends outside the mask is a failed retouch"));
        assert!(prompt_arg.contains("preserve the person's identity, face, hair, skin, hands"));
        assert!(prompt_arg.contains("all unrequested surrounding content"));
        assert!(!prompt_arg.contains("nearby bag"));
        assert!(!prompt_arg.contains("seat, window"));
        assert!(prompt_arg.contains("Those are deterministic PaintNode responsibilities"));
        assert!(prompt_arg.contains("generated image in Codex's generated-images cache"));
        assert!(!prompt_arg.contains("Save the final exact-size PNG as `result.png`"));
    }

    #[test]
    fn codex_restore_prompt_targets_detail_without_content_changes() {
        let prompt = codex_restore_prompt(AiAutonomyLevel::Low, TEST_GEOMETRY_NOTE);
        assert!(
            prompt.contains("Use $imagegen to perform one in-place PaintNode detail restoration")
        );
        assert!(prompt.contains("Do not add, remove, move, restyle, or reinterpret any content"));
        assert!(prompt.contains("highest output resolution"));
        assert!(prompt.contains("the full PaintNode document"));
        assert!(prompt.contains("generated-images cache"));
        assert!(prompt.contains("Critical registration rule"));
        assert!(!prompt.contains("chroma"));
        assert!(!prompt.contains("User retouch prompt"));
    }

    #[test]
    fn ai_retouch_prompt_keeps_registration_rules_without_chroma_geometry() {
        let prompt = ai_retouch_prompt(
            "remove glare",
            false,
            false,
            &[],
            AiAutonomyLevel::Low,
            "PaintNode image geometry:\n- The attached images are a crop of a larger PaintNode document; PaintNode will paste your result back into the correct document region automatically.",
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
        assert!(prompt.contains("a crop of a larger PaintNode document"));
        assert!(prompt
            .contains("paste your result back into the correct document region automatically"));
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
