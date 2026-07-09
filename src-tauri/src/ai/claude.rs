//! Claude Director provider: uses the Claude Agent SDK to write PaintNode request files.

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Deserialize;
use tauri::AppHandle;

use crate::ai::{
    ai_run_cancelled, apply_ai_cli_environment, clear_ai_run_cancelled, codex_agent_message_text,
    output_tail, spawn_output_reader, AgentRunResult, AiModelCapability,
    AiProviderCapabilitiesResult, AiReasoningCapability, CodexDetectionResult,
    AI_RUN_STOPPED_MESSAGE, POLL_INTERVAL,
};

#[derive(Debug)]
pub(crate) struct ClaudeCommandOptions {
    bin: String,
    model: Option<String>,
    effort: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeDetectEvent {
    found: bool,
    path: Option<String>,
    version: Option<String>,
    error: Option<String>,
}

pub(crate) fn claude_command_options(
    bin: Option<String>,
    model: Option<String>,
    effort: Option<String>,
) -> ClaudeCommandOptions {
    ClaudeCommandOptions {
        bin: bin
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_default(),
        model: model
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && value != "default"),
        effort: effort
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && value != "auto"),
    }
}

pub(crate) fn claude_command_label(options: &ClaudeCommandOptions) -> &str {
    if options.bin.trim().is_empty() {
        "Claude Agent SDK bundled CLI"
    } else {
        &options.bin
    }
}

fn claude_agent_runner_script() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(|root| root.join("scripts").join("claude-agent-runner.mjs"))
        .unwrap_or_else(|| PathBuf::from("scripts").join("claude-agent-runner.mjs"))
}

fn build_claude_agent_command(
    options: &ClaudeCommandOptions,
    job_path: &Path,
    prompt_text: &str,
    image_paths: &[PathBuf],
) -> Command {
    let mut command = Command::new("node");
    apply_ai_cli_environment(&mut command)
        .current_dir(job_path)
        .arg(claude_agent_runner_script())
        .arg("--cwd")
        .arg(job_path);
    if !options.bin.trim().is_empty() {
        command.arg("--claude-path").arg(&options.bin);
    }
    if let Some(model) = options.model.as_deref() {
        command.arg("--model").arg(model);
    }
    if let Some(effort) = options.effort.as_deref() {
        command.arg("--effort").arg(effort);
    }
    for path in image_paths {
        command.arg("--image").arg(path);
    }
    command.arg("--").arg(prompt_text);
    command
}

pub(crate) fn build_generative_fill_claude_command(
    options: &ClaudeCommandOptions,
    job_path: &Path,
    prompt_text: &str,
    has_overview: bool,
    reference_paths: &[PathBuf],
) -> Command {
    let mut image_paths = vec![job_path.join("source.png")];
    if has_overview {
        image_paths.push(job_path.join("overview.png"));
    }
    image_paths.extend(reference_paths.iter().cloned());
    build_claude_agent_command(options, job_path, prompt_text, &image_paths)
}

pub(crate) fn build_director_claude_command(
    options: &ClaudeCommandOptions,
    job_path: &Path,
    prompt_text: &str,
    image_paths: &[PathBuf],
) -> Command {
    build_claude_agent_command(options, job_path, prompt_text, image_paths)
}

pub(crate) fn run_claude_with_progress(
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
            "Claude".into(),
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
            "Claude".into(),
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

    Ok(AgentRunResult {
        output: Output {
            status,
            stdout,
            stderr,
        },
        thread_id: None,
        satisfied_required_output: false,
    })
}

pub(crate) fn final_claude_agent_message(output: &Output) -> Option<String> {
    let mut messages = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout)
        .lines()
        .chain(String::from_utf8_lossy(&output.stderr).lines())
    {
        if let Some(message) = codex_agent_message_text(line) {
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

pub(crate) fn claude_command_failure(prefix: &str, output: &Output) -> String {
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
        return format!("{prefix} failed because Claude Code is not logged in. Run `claude` in Terminal and sign in with your Claude account, then try again.\n\n{detail}");
    }

    format!("{prefix} exited with {}:\n{detail}", output.status)
}

#[tauri::command]
pub(crate) async fn detect_claude(bin: Option<String>) -> Result<CodexDetectionResult, String> {
    tauri::async_runtime::spawn_blocking(move || -> CodexDetectionResult {
        let bin = bin
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        if let Some(path) = bin.as_deref() {
            let mut command = Command::new(path);
            apply_ai_cli_environment(&mut command).arg("--version");
            match command.output() {
                Ok(output) if output.status.success() => {
                    let version = String::from_utf8_lossy(&output.stdout)
                        .lines()
                        .next()
                        .map(str::trim)
                        .filter(|line| !line.is_empty())
                        .map(str::to_string);
                    return CodexDetectionResult {
                        found: true,
                        path: Some(path.to_string()),
                        version,
                        error: None,
                    };
                }
                Ok(output) => {
                    return CodexDetectionResult {
                        found: false,
                        path: Some(path.to_string()),
                        version: None,
                        error: Some(claude_command_failure("Claude detection", &output)),
                    };
                }
                Err(error) => {
                    return CodexDetectionResult {
                        found: false,
                        path: Some(path.to_string()),
                        version: None,
                        error: Some(format!("Failed to run Claude Code at '{path}': {error}")),
                    };
                }
            }
        }

        let mut command = Command::new("node");
        apply_ai_cli_environment(&mut command)
            .arg(claude_agent_runner_script())
            .arg("--detect");
        match command.output() {
            Ok(output) if output.status.success() => {
                for line in String::from_utf8_lossy(&output.stdout).lines() {
                    let Ok(event) = serde_json::from_str::<ClaudeDetectEvent>(line) else {
                        continue;
                    };
                    return CodexDetectionResult {
                        found: event.found,
                        path: event.path,
                        version: event.version,
                        error: event.error,
                    };
                }
                CodexDetectionResult {
                    found: false,
                    path: None,
                    version: None,
                    error: Some("Claude Agent SDK detection returned no status.".into()),
                }
            }
            Ok(output) => CodexDetectionResult {
                found: false,
                path: None,
                version: None,
                error: Some(claude_command_failure("Claude detection", &output)),
            },
            Err(error) => CodexDetectionResult {
                found: false,
                path: None,
                version: None,
                error: Some(format!("Failed to run Claude Agent SDK detection: {error}")),
            },
        }
    })
    .await
    .map_err(|e| format!("Claude detection task failed: {e}"))
}

fn claude_effort_label(value: &str) -> String {
    match value {
        "xhigh" => "Extra High".into(),
        other => {
            let mut chars = other.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        }
    }
}

fn fallback_claude_capabilities(warning: Option<String>) -> AiProviderCapabilitiesResult {
    let efforts = || {
        ["low", "medium", "high", "xhigh", "max"]
            .into_iter()
            .map(|value| AiReasoningCapability {
                value: value.into(),
                label: claude_effort_label(value),
            })
            .collect()
    };
    AiProviderCapabilitiesResult {
        models: [
            ("default", "Default"),
            ("sonnet", "Sonnet"),
            ("opus", "Opus"),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (id, label))| AiModelCapability {
            id: id.into(),
            label: label.into(),
            description: None,
            supported_reasoning_efforts: efforts(),
            default_reasoning_effort: Some("auto".into()),
            is_default: index == 0,
        })
        .collect(),
        source: "fallback".into(),
        warning,
    }
}

fn parse_claude_capabilities(bytes: &[u8]) -> Result<AiProviderCapabilitiesResult, String> {
    let payload: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("Claude returned invalid capability data: {error}"))?;
    let models = payload
        .get("models")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "Claude capability data did not include a model list.".to_string())?
        .iter()
        .filter_map(|item| {
            let id = item.get("value")?.as_str()?.trim();
            if id.is_empty() {
                return None;
            }
            let efforts: Vec<AiReasoningCapability> = item
                .get("supportedEffortLevels")
                .and_then(serde_json::Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(|value| AiReasoningCapability {
                            value: value.into(),
                            label: claude_effort_label(value),
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(AiModelCapability {
                id: id.into(),
                label: item
                    .get("displayName")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(id)
                    .into(),
                description: item
                    .get("description")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                default_reasoning_effort: Some("auto".into()),
                supported_reasoning_efforts: efforts,
                is_default: id == "default",
            })
        })
        .collect::<Vec<_>>();
    if models.is_empty() {
        return Err("Claude did not advertise any available models.".into());
    }
    Ok(AiProviderCapabilitiesResult {
        models,
        source: "agentSdk".into(),
        warning: None,
    })
}

#[tauri::command]
pub(crate) async fn discover_claude_capabilities(
    bin: Option<String>,
) -> Result<AiProviderCapabilitiesResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new("node");
        apply_ai_cli_environment(&mut command)
            .arg(claude_agent_runner_script())
            .arg("--capabilities");
        if let Some(bin) = bin
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            command.arg("--claude-path").arg(bin);
        }
        match command.output() {
            Ok(output) if output.status.success() => parse_claude_capabilities(&output.stdout)
                .unwrap_or_else(|error| fallback_claude_capabilities(Some(error))),
            Ok(output) => fallback_claude_capabilities(Some(claude_command_failure(
                "Claude capability discovery",
                &output,
            ))),
            Err(error) => fallback_claude_capabilities(Some(format!(
                "Failed to launch Claude capability discovery: {error}"
            ))),
        }
    })
    .await
    .map_err(|error| format!("Claude capability task failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::TempJobDir;

    #[test]
    fn capability_parser_preserves_models_and_per_model_efforts() {
        let result = parse_claude_capabilities(
            br#"{"models":[{"value":"default","displayName":"Default (recommended)","description":"Best available","supportedEffortLevels":["low","medium","high","xhigh","max"]},{"value":"haiku","displayName":"Haiku","description":"Fast"}]}"#,
        )
        .expect("Claude capabilities");
        assert_eq!(result.source, "agentSdk");
        assert_eq!(result.models.len(), 2);
        assert_eq!(result.models[0].id, "default");
        assert_eq!(result.models[0].supported_reasoning_efforts.len(), 5);
        assert!(result.models[1].supported_reasoning_efforts.is_empty());
    }

    #[test]
    fn command_applies_discovered_model_and_effort() {
        let job = TempJobDir::new("paintnode-claude-capability-test").expect("temp dir");
        let options = claude_command_options(None, Some("sonnet".into()), Some("max".into()));
        let command = build_claude_agent_command(&options, job.path(), "review", &[]);
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(args.windows(2).any(|pair| pair == ["--model", "sonnet"]));
        assert!(args.windows(2).any(|pair| pair == ["--effort", "max"]));
    }

    #[test]
    fn command_omits_automatic_effort() {
        let options = claude_command_options(None, Some("haiku".into()), Some("auto".into()));
        assert!(options.effort.is_none());
    }
}
