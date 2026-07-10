//! Provider-neutral workflow drafting through a configured AI Director.
//!
//! The provider runs in an isolated temporary directory and receives only the
//! strict context DTO below. PaintNode validates the returned GraphDraft again
//! in the framework-independent TypeScript workflow domain before preview or
//! application. This command never calls an image executor.

use std::fs;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::ai::antigravity::run_antigravity_director_request;
use crate::ai::claude::run_claude_workflow_draft_request;
use crate::ai::codex::run_codex_workflow_draft_request;
use crate::ai::TempJobDir;

const WORKFLOW_DIRECTOR_CONTEXT_VERSION: u8 = 1;
const WORKFLOW_DIRECTOR_DRAFT_FILE: &str = "paintnode-workflow-draft.json";
const MAX_CONTEXT_JSON_BYTES: usize = 512 * 1024;
const MAX_DRAFT_JSON_BYTES: u64 = 2 * 1024 * 1024;

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
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("AI Director returned malformed workflow draft JSON: {error}"))
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
) -> Result<Value, String> {
    validate_identifier(run_id, "Workflow Director run id")?;
    let context_json = validate_context(&context)?;
    let prompt = workflow_director_prompt(&context_json);
    let job = TempJobDir::new("paintnode-workflow-director")?;
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
) -> Result<Value, String> {
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
            br#"{"version":1,"name":"Draft","summary":"Safe","nodes":[],"edges":[]}"#,
        )
        .expect("write");
        assert_eq!(read_workflow_draft(&job).expect("draft")["version"], 1);
    }
}
