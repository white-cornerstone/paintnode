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
use std::time::Instant;
use std::time::SystemTime;

use tauri::AppHandle;

use crate::ai::canvas::{
    ai_chroma_key_pixel, ai_codex_working_canvas_for_dimensions, ai_mask_padding_pixel,
    ai_retouch_editable_mask_png, ai_working_canvas_accepts_result_dimensions,
    ai_working_canvas_for_dimensions, ai_working_canvas_instruction, pad_png_to_ai_working_canvas,
    read_png_bytes_cropped_to_ai_working_canvas, validate_optional_target_dimensions,
    AiWorkingCanvas, AI_CHROMA_KEY_HEX, AI_RETOUCH_OUTPUT_MASK_FEATHER_RADIUS,
    AI_RETOUCH_OUTPUT_MASK_GROW_RADIUS,
};
use crate::ai::{
    ai_autonomy_level, ai_job_project_dir, ai_retouch_asset_name, clean_option,
    cleanup_project_agent_job, cleanup_project_job_enabled, codex_agent_message_text,
    command_failure, copy_png_candidate, emit_codex_progress, emit_kept_job_dir,
    image_agent_autonomy_contract, now_id, optional_project_dir, output_tail,
    project_agent_run_dir, reference_prompt_note, safe_job_child_path, safe_png_source_file_name,
    should_keep_job_dir, spawn_output_reader, unique_child_path, validate_reference_pngs,
    write_ai_job_prompt, write_reference_pngs, AgentRunResult, AiAutonomyLevel,
    CodexDetectionResult, DecoupleImageResult, DecoupleManifest, DecoupledLayerResult,
    GeneratedImageResult, TempJobDir, WorkflowSourceImage, CODEX_RUNS_DIR, GENERATION_TIMEOUT,
    POLL_INTERVAL,
};
use crate::png::{
    file_has_png_signature, is_png, png_data_url, png_dimensions, png_dimensions_from_bytes,
    read_png_data_url,
};
use crate::project::{
    add_asset, safe_file_name, safe_stem, store_generated_png_asset, write_asset_file,
    write_asset_file_with_file_name, ProjectAsset,
};

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
    timeout: Duration,
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
        })
    })
    .await
    .map_err(|e| format!("Task error: {e}"))?
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
