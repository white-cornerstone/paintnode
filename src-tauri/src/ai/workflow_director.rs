//! Provider-neutral workflow drafting through a configured AI Director.
//!
//! The provider runs in an isolated temporary directory and receives only the
//! strict context DTO below. PaintNode validates the returned GraphDraft again
//! in the framework-independent TypeScript workflow domain before preview or
//! application. This command never calls an image executor.

use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::ai::antigravity::run_antigravity_director_request;
use crate::ai::claude::run_claude_workflow_draft_request;
use crate::ai::codex::run_codex_workflow_draft_request;
use crate::ai::{
    ai_run_cancelled, clear_ai_run_cancelled, request_ai_run_cancel, TempJobDir,
    AI_RUN_STOPPED_MESSAGE,
};

const WORKFLOW_DIRECTOR_CONTEXT_VERSION: u8 = 1;
const WORKFLOW_DIRECTOR_DRAFT_FILE: &str = "paintnode-workflow-draft.json";
const MAX_CONTEXT_JSON_BYTES: usize = 512 * 1024;
const MAX_DRAFT_JSON_BYTES: u64 = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 180_000;
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 600_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowDirectorRegistryPort {
    id: String,
    label: String,
    data_type: String,
    required: bool,
    multiple: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowDirectorRegistryNode {
    #[serde(rename = "type")]
    node_type: String,
    label: String,
    description: String,
    inputs: Vec<WorkflowDirectorRegistryPort>,
    outputs: Vec<WorkflowDirectorRegistryPort>,
    settings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowDirectorAsset {
    id: String,
    name: String,
    kind: String,
    mime: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    available: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowDirectorRequestedOutput {
    id: String,
    name: String,
    width: u32,
    height: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowDirectorCapability {
    id: String,
    available: bool,
    reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowDirectorContext {
    version: u8,
    brief: String,
    registry: Vec<WorkflowDirectorRegistryNode>,
    assets: Vec<WorkflowDirectorAsset>,
    requested_outputs: Vec<WorkflowDirectorRequestedOutput>,
    capabilities: Vec<WorkflowDirectorCapability>,
}

fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 160 {
        return Err(format!(
            "{label} must contain between 1 and 160 characters."
        ));
    }
    Ok(())
}

fn validate_context(context: &WorkflowDirectorContext) -> Result<String, String> {
    if context.version != WORKFLOW_DIRECTOR_CONTEXT_VERSION {
        return Err(format!(
            "Workflow Director context version must be {WORKFLOW_DIRECTOR_CONTEXT_VERSION}."
        ));
    }
    if context.brief.trim().is_empty() || context.brief.len() > 20_000 {
        return Err("Workflow Director brief must contain between 1 and 20000 characters.".into());
    }
    if context.registry.is_empty() || context.registry.len() > 16 {
        return Err(
            "Workflow Director registry must contain between 1 and 16 creator types.".into(),
        );
    }
    if context.assets.len() > 500
        || context.requested_outputs.is_empty()
        || context.requested_outputs.len() > 32
    {
        return Err("Workflow Director context contains an unsupported number of assets or requested outputs.".into());
    }
    for node in &context.registry {
        validate_identifier(&node.node_type, "Registry node type")?;
        validate_identifier(&node.label, "Registry node label")?;
    }
    for asset in &context.assets {
        validate_identifier(&asset.id, "Project asset id")?;
        validate_identifier(&asset.name, "Project asset name")?;
    }
    for output in &context.requested_outputs {
        validate_identifier(&output.id, "Requested output id")?;
        validate_identifier(&output.name, "Requested output name")?;
        if !(64..=16_384).contains(&output.width) || !(64..=16_384).contains(&output.height) {
            return Err(format!(
                "Requested output {} has unsupported dimensions.",
                output.name
            ));
        }
    }
    for capability in &context.capabilities {
        validate_identifier(&capability.id, "Capability id")?;
    }
    let json = serde_json::to_string(context)
        .map_err(|error| format!("Workflow Director context could not be serialized: {error}"))?;
    if json.len() > MAX_CONTEXT_JSON_BYTES {
        return Err("Workflow Director context is too large.".into());
    }
    Ok(json)
}

fn workflow_director_prompt(context_json: &str) -> String {
    format!(
        r#"You are PaintNode's workflow-drafting AI Director. Draft an inspectable creator workflow only.

Safety boundary:
- Use only the supplied creator registry, its exact stable node `type` values, and its exact named ports.
- Use only the supplied project-asset metadata, requested outputs, and capability availability.
- Do not inspect the filesystem, environment, credentials, project files, application state, or network resources.
- Do not call image-generation, image-editing, shell, code-execution, or authentication tools.
- Do not execute the workflow. This task returns a proposal only.
- Do not invent provider-specific nodes, arbitrary code, positions, sizes, colours, raw config, run records, or internal state.

Return one strict GraphDraft v1 JSON object with exactly these top-level fields:
- `version`: 1
- `name`: non-empty workflow name
- `summary`: non-empty creator-facing explanation
- `nodes`: creator nodes using one exact shape for their type:
  - input: id,type,title,assetId(string or null),role,required(boolean)
  - brief: id,type,title,objective,guidance
  - art-direction: id,type,title,prompt
  - transform: id,type,title,capability,instructions
  - review: id,type,title,mode(`human` or `ai`),instructions
  - output: id,type,title,width,height
- `edges`: id plus source and target objects, each containing only nodeId and an exact registry portId.

Every requested output must appear. Connect all required ports. Keep the graph acyclic. If a capability is unavailable, it may be proposed only when its requirement and unsupported status should be visible in preview; PaintNode will prevent acceptance.

Return only the JSON object. When file tools are available, write the same UTF-8 JSON object to `{WORKFLOW_DIRECTOR_DRAFT_FILE}` and do not create or change any other file.

PaintNode Director context v1:
{context_json}"#
    )
}

fn workflow_director_timeout(timeout_ms: Option<u64>) -> Duration {
    Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    )
}

fn run_with_timeout<T, Run>(run_id: &str, timeout: Duration, run: Run) -> Result<T, String>
where
    Run: FnOnce() -> Result<T, String>,
{
    if ai_run_cancelled(run_id) {
        clear_ai_run_cancelled(run_id);
        return Err(AI_RUN_STOPPED_MESSAGE.into());
    }
    let timed_out = Arc::new(AtomicBool::new(false));
    let timeout_flag = Arc::clone(&timed_out);
    let timeout_run_id = run_id.to_string();
    let (finished_tx, finished_rx) = mpsc::channel::<()>();
    let timer = thread::spawn(move || {
        if matches!(
            finished_rx.recv_timeout(timeout),
            Err(mpsc::RecvTimeoutError::Timeout)
        ) {
            timeout_flag.store(true, Ordering::SeqCst);
            let _ = request_ai_run_cancel(&timeout_run_id);
        }
    });
    let result = run();
    let _ = finished_tx.send(());
    let _ = timer.join();
    let did_time_out = timed_out.load(Ordering::SeqCst);
    clear_ai_run_cancelled(run_id);
    if did_time_out {
        Err(format!(
            "AI Director timed out after {} seconds and was stopped.",
            timeout.as_secs_f64()
        ))
    } else {
        result
    }
}

fn read_workflow_draft(job: &TempJobDir) -> Result<Value, String> {
    let path = job.path().join(WORKFLOW_DIRECTOR_DRAFT_FILE);
    let metadata = fs::metadata(&path).map_err(|error| {
        format!("AI Director did not return {WORKFLOW_DIRECTOR_DRAFT_FILE}: {error}")
    })?;
    if metadata.len() == 0 || metadata.len() > MAX_DRAFT_JSON_BYTES {
        return Err("AI Director returned an empty or oversized workflow draft.".into());
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("Failed to read the AI Director workflow draft: {error}"))?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("AI Director returned malformed workflow draft JSON: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "AI Director workflow draft must be a JSON object.".to_string())?;
    let expected = ["version", "name", "summary", "nodes", "edges"];
    if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
        return Err("AI Director workflow draft does not match the GraphDraft v1 envelope.".into());
    }
    if object.get("version").and_then(Value::as_u64) != Some(1)
        || object
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .map_or(true, str::is_empty)
        || object
            .get("summary")
            .and_then(Value::as_str)
            .map(str::trim)
            .map_or(true, str::is_empty)
        || object
            .get("nodes")
            .and_then(Value::as_array)
            .map_or(true, Vec::is_empty)
        || object.get("edges").and_then(Value::as_array).is_none()
    {
        return Err(
            "AI Director workflow draft has an invalid GraphDraft v1 semantic envelope.".into(),
        );
    }
    Ok(value)
}

#[allow(clippy::too_many_arguments)]
fn run_workflow_director(
    app: &AppHandle,
    provider: &str,
    context: WorkflowDirectorContext,
    run_id: &str,
    codex_bin: Option<String>,
    codex_model: Option<String>,
    codex_reasoning_effort: Option<String>,
    codex_service_tier: Option<String>,
    claude_bin: Option<String>,
    claude_model: Option<String>,
    claude_effort: Option<String>,
    antigravity_bin: Option<String>,
    antigravity_model: Option<String>,
    antigravity_approval_mode: Option<String>,
    timeout: Duration,
) -> Result<Value, String> {
    validate_identifier(run_id, "Workflow Director run id")?;
    let context_json = validate_context(&context)?;
    let prompt = workflow_director_prompt(&context_json);
    let job = TempJobDir::new("paintnode-workflow-director")?;
    run_with_timeout(run_id, timeout, || {
        match provider.trim() {
            "codex" => {
                run_codex_workflow_draft_request(
                    app,
                    run_id,
                    codex_bin,
                    codex_model,
                    codex_reasoning_effort,
                    codex_service_tier,
                    job.path(),
                    &prompt,
                    WORKFLOW_DIRECTOR_DRAFT_FILE,
                )?;
            }
            "claude" => {
                run_claude_workflow_draft_request(
                    app,
                    run_id,
                    claude_bin,
                    claude_model,
                    claude_effort,
                    job.path(),
                    &prompt,
                    WORKFLOW_DIRECTOR_DRAFT_FILE,
                )?;
            }
            "antigravity" => {
                let run = run_antigravity_director_request(
                    app,
                    run_id,
                    antigravity_bin,
                    antigravity_model,
                    antigravity_approval_mode,
                    false,
                    job.path(),
                    job.path(),
                    &prompt,
                    false,
                    WORKFLOW_DIRECTOR_DRAFT_FILE,
                    None,
                )?;
                if !run.output.status.success() {
                    return Err("Antigravity workflow Director failed. Review the provider progress for details.".into());
                }
            }
            other => {
                return Err(format!(
                    "Unsupported workflow Director provider: {}.",
                    if other.is_empty() { "<empty>" } else { other }
                ));
            }
        }
        Ok(())
    })?;
    read_workflow_draft(&job)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn draft_workflow_with_director(
    app: AppHandle,
    provider: String,
    context: WorkflowDirectorContext,
    run_id: String,
    codex_bin: Option<String>,
    codex_model: Option<String>,
    codex_reasoning_effort: Option<String>,
    codex_service_tier: Option<String>,
    claude_bin: Option<String>,
    claude_model: Option<String>,
    claude_effort: Option<String>,
    antigravity_bin: Option<String>,
    antigravity_model: Option<String>,
    antigravity_approval_mode: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let timeout = workflow_director_timeout(timeout_ms);
    tauri::async_runtime::spawn_blocking(move || {
        run_workflow_director(
            &app,
            &provider,
            context,
            &run_id,
            codex_bin,
            codex_model,
            codex_reasoning_effort,
            codex_service_tier,
            claude_bin,
            claude_model,
            claude_effort,
            antigravity_bin,
            antigravity_model,
            antigravity_approval_mode,
            timeout,
        )
    })
    .await
    .map_err(|error| format!("Workflow Director task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> WorkflowDirectorContext {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "brief": "Create a product campaign.",
            "registry": [{
                "type": "output",
                "label": "Output",
                "description": "Delivery",
                "inputs": [{ "id": "source", "label": "Source", "dataType": "layout", "required": true, "multiple": false }],
                "outputs": [],
                "settings": ["width", "height"]
            }],
            "assets": [{
                "id": "asset-1", "name": "Bottle.png", "kind": "imported", "mime": "image/png",
                "width": 1200, "height": 1200, "available": true
            }],
            "requestedOutputs": [{ "id": "square", "name": "Square", "width": 1024, "height": 1024 }],
            "capabilities": [{ "id": "generate", "available": true, "reason": null }]
        }))
        .expect("context")
    }

    #[test]
    fn context_dto_rejects_unrestricted_internal_state() {
        let result = serde_json::from_value::<WorkflowDirectorContext>(serde_json::json!({
            "version": 1,
            "brief": "Brief",
            "registry": [],
            "assets": [],
            "requestedOutputs": [],
            "capabilities": [],
            "projectPath": "/secret/project",
            "workflowGraph": { "runRecords": [] }
        }));
        assert!(result.is_err());
    }

    #[test]
    fn prompt_contains_only_the_context_contract_and_forbids_execution() {
        let json = validate_context(&context()).expect("valid context");
        let prompt = workflow_director_prompt(&json);
        assert!(prompt.contains("Do not call image-generation"));
        assert!(prompt.contains("Return only the JSON object"));
        assert!(prompt.contains(WORKFLOW_DIRECTOR_DRAFT_FILE));
        assert!(!prompt.contains("/secret/project"));
        assert!(!prompt.contains("runRecords\":"));
    }

    #[test]
    fn draft_reader_accepts_json_and_rejects_missing_output() {
        let job = TempJobDir::new("paintnode-workflow-director-read-test").expect("job");
        assert!(read_workflow_draft(&job)
            .unwrap_err()
            .contains("did not return"));
        fs::write(
            job.path().join(WORKFLOW_DIRECTOR_DRAFT_FILE),
            br#"{"version":1,"name":"Draft","summary":"Safe","nodes":[{}],"edges":[]}"#,
        )
        .expect("write");
        assert_eq!(read_workflow_draft(&job).expect("draft")["version"], 1);
    }

    #[test]
    fn draft_reader_rejects_malformed_oversized_and_wrong_semantic_envelopes() {
        let job = TempJobDir::new("paintnode-workflow-director-invalid-test").expect("job");
        let path = job.path().join(WORKFLOW_DIRECTOR_DRAFT_FILE);
        fs::write(&path, b"{not json").expect("malformed");
        assert!(read_workflow_draft(&job).unwrap_err().contains("malformed"));
        fs::write(
            &path,
            br#"{"version":2,"name":"Draft","summary":"Safe","nodes":[{}],"edges":[]}"#,
        )
        .expect("semantic");
        assert!(read_workflow_draft(&job)
            .unwrap_err()
            .contains("semantic envelope"));
        let file = fs::File::create(&path).expect("oversized file");
        file.set_len(MAX_DRAFT_JSON_BYTES + 1).expect("set length");
        assert!(read_workflow_draft(&job).unwrap_err().contains("oversized"));
    }

    #[test]
    fn timeout_is_bounded_and_cancels_a_hung_runner() {
        assert_eq!(workflow_director_timeout(Some(1)), Duration::from_secs(1));
        assert_eq!(
            workflow_director_timeout(Some(u64::MAX)),
            Duration::from_secs(600)
        );
        let result = run_with_timeout("director-timeout-test", Duration::from_millis(10), || {
            while !crate::ai::ai_run_cancelled("director-timeout-test") {
                thread::sleep(Duration::from_millis(1));
            }
            Err::<(), _>("provider stopped".into())
        });
        assert!(result.unwrap_err().contains("timed out"));
        assert!(!crate::ai::ai_run_cancelled("director-timeout-test"));
    }

    #[test]
    fn cancellation_requested_before_runner_start_is_not_erased() {
        let run_id = "director-cancel-before-start-test";
        crate::ai::request_ai_run_cancel(run_id).expect("request cancellation");
        let ran = std::cell::Cell::new(false);

        let result = run_with_timeout(run_id, Duration::from_secs(1), || {
            ran.set(true);
            Ok(())
        });

        assert_eq!(result.unwrap_err(), crate::ai::AI_RUN_STOPPED_MESSAGE);
        assert!(!ran.get());
        assert!(!crate::ai::ai_run_cancelled(run_id));
    }
}
