//! Provider-neutral workflow drafting through a configured AI Director.
//!
//! The provider runs in an isolated temporary directory and receives only the
//! strict context DTO below. PaintNode validates the returned GraphDraft again
//! in the framework-independent TypeScript workflow domain before preview or
//! application. This command never calls an image executor.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::ai::antigravity::run_antigravity_director_request;
use crate::ai::claude::{run_claude_workflow_draft_request, run_claude_workflow_revision_request};
use crate::ai::codex::{run_codex_workflow_draft_request, run_codex_workflow_revision_request};
use crate::ai::{
    ai_run_cancelled, clear_ai_run_cancelled, request_ai_run_cancel, TempJobDir,
    AI_RUN_STOPPED_MESSAGE,
};

const WORKFLOW_DIRECTOR_CONTEXT_VERSION: u8 = 1;
const WORKFLOW_DIRECTOR_DRAFT_FILE: &str = "paintnode-workflow-draft.json";
const WORKFLOW_DIRECTOR_REVISION_FILE: &str = "paintnode-workflow-revision.json";
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkflowDirectorRevisionContext {
    version: u8,
    instruction: String,
    source_graph_revision: WorkflowDirectorRevisionSource,
    graph: WorkflowDirectorRevisionGraph,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowDirectorRevisionSource {
    graph_id: String,
    revision: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowDirectorRevisionGraph {
    id: String,
    nodes: Vec<WorkflowDirectorRevisionNode>,
    edges: Vec<WorkflowDirectorRevisionEdge>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowDirectorRevisionNode {
    id: String,
    #[serde(rename = "type")]
    node_type: String,
    title: String,
    position: WorkflowDirectorRevisionPoint,
    ports: WorkflowDirectorRevisionPorts,
    config: HashMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowDirectorRevisionPoint {
    x: f64,
    y: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowDirectorRevisionPorts {
    inputs: Vec<WorkflowDirectorRevisionPort>,
    outputs: Vec<WorkflowDirectorRevisionPort>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowDirectorRevisionPort {
    id: String,
    label: String,
    data_type: String,
    required: Option<bool>,
    multiple: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowDirectorRevisionEdge {
    id: String,
    source: WorkflowDirectorRevisionEndpoint,
    target: WorkflowDirectorRevisionEndpoint,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowDirectorRevisionEndpoint {
    node_id: String,
    port_id: String,
}

fn validate_revision_context(context: &WorkflowDirectorRevisionContext) -> Result<String, String> {
    if context.version != 1
        || context.instruction.trim().is_empty()
        || context.instruction.len() > 1_000
    {
        return Err("Workflow Director revision context is invalid.".into());
    }
    validate_identifier(
        &context.source_graph_revision.graph_id,
        "Workflow Director revision graph id",
    )?;
    validate_identifier(&context.graph.id, "Workflow Director revision graph id")?;
    if context.source_graph_revision.graph_id != context.graph.id {
        return Err("Workflow Director revision source is invalid.".into());
    }
    if context.graph.nodes.is_empty()
        || context.graph.nodes.len() > 512
        || context.graph.edges.len() > 2_048
    {
        return Err("Workflow Director revision graph is invalid.".into());
    }
    let mut node_ids = HashSet::new();
    for node in &context.graph.nodes {
        validate_identifier(&node.id, "Workflow Director revision node id")?;
        validate_identifier(&node.title, "Workflow Director revision node title")?;
        if !node_ids.insert(node.id.as_str())
            || !node.position.x.is_finite()
            || !node.position.y.is_finite()
        {
            return Err("Workflow Director revision graph is invalid.".into());
        }
        let allowed_config = match node.node_type.as_str() {
            "input" => &["assetId", "role", "required"][..],
            "brief" => &["objective", "guidance"][..],
            "art-direction" => &["prompt"][..],
            "transform" => &["capability", "instructions"][..],
            "review" => &["mode", "instructions"][..],
            "output" => &["finalWidth", "finalHeight"][..],
            _ => return Err("Workflow Director revision graph is invalid.".into()),
        };
        if node.config.iter().any(|(key, value)| {
            !allowed_config.contains(&key.as_str())
                || !matches!(
                    value,
                    Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
                )
        }) {
            return Err("Workflow Director revision graph is invalid.".into());
        }
        for port in node.ports.inputs.iter().chain(&node.ports.outputs) {
            validate_identifier(&port.id, "Workflow Director revision port id")?;
            validate_identifier(&port.label, "Workflow Director revision port label")?;
            validate_identifier(&port.data_type, "Workflow Director revision port type")?;
        }
    }
    let mut edge_ids = HashSet::new();
    for edge in &context.graph.edges {
        validate_identifier(&edge.id, "Workflow Director revision edge id")?;
        validate_identifier(
            &edge.source.node_id,
            "Workflow Director revision source node",
        )?;
        validate_identifier(
            &edge.source.port_id,
            "Workflow Director revision source port",
        )?;
        validate_identifier(
            &edge.target.node_id,
            "Workflow Director revision target node",
        )?;
        validate_identifier(
            &edge.target.port_id,
            "Workflow Director revision target port",
        )?;
        if !edge_ids.insert(edge.id.as_str())
            || !node_ids.contains(edge.source.node_id.as_str())
            || !node_ids.contains(edge.target.node_id.as_str())
        {
            return Err("Workflow Director revision graph is invalid.".into());
        }
    }
    let json = serde_json::to_string(context)
        .map_err(|_| "Workflow Director revision context could not be serialized.".to_string())?;
    if json.len() > MAX_CONTEXT_JSON_BYTES {
        return Err("Workflow Director revision context is too large.".into());
    }
    Ok(json)
}

fn workflow_director_revision_prompt(context_json: &str) -> String {
    format!(
        r#"You are PaintNode's workflow-revision AI Director. Return a constrained patch for the supplied existing creator graph.

Safety boundary:
- Use only node ids, authoring config keys, ports, and edges present in the supplied constrained graph.
- Do not inspect files, environment, credentials, project state, network resources, run history, or accepted assets.
- Do not call image-generation, image-editing, shell, code-execution, discovery, or authentication tools.
- Do not execute the workflow and do not return a fresh GraphDraft.
- Preserve accepted candidates and history; PaintNode applies and validates the patch separately.

Return exactly one Patch v1 JSON object with only: `version` (1), `sourceGraphRevision` (unchanged), `summary` (non-empty), and `operations` (maximum 128). Operations are limited to add-node, remove-node, configure-node, move-node, add-edge, and remove-edge using PaintNode's strict shapes. For structured output, add-node must include the full creator node authoring shape and configure-node `changes` must include the complete allowed authoring config for that target node; unchanged values are permitted. Return only JSON. When file tools are available, write the same UTF-8 object to `{WORKFLOW_DIRECTOR_REVISION_FILE}` and no other file.

PaintNode constrained revision context v1:
{context_json}"#
    )
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

fn read_workflow_revision(job: &TempJobDir) -> Result<Value, String> {
    let path = job.path().join(WORKFLOW_DIRECTOR_REVISION_FILE);
    let metadata = fs::metadata(&path)
        .map_err(|_| "AI Director did not return a workflow revision.".to_string())?;
    if metadata.len() == 0 || metadata.len() > MAX_DRAFT_JSON_BYTES {
        return Err("AI Director returned an empty or oversized workflow revision.".into());
    }
    let bytes = fs::read(&path)
        .map_err(|_| "Failed to read the AI Director workflow revision.".to_string())?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "AI Director returned malformed workflow revision JSON.".to_string())?;
    let object = value
        .as_object()
        .ok_or_else(|| "AI Director workflow revision must be a JSON object.".to_string())?;
    let expected = ["version", "sourceGraphRevision", "summary", "operations"];
    if object.len() != expected.len()
        || expected.iter().any(|key| !object.contains_key(*key))
        || object.get("version").and_then(Value::as_u64) != Some(1)
        || object
            .get("summary")
            .and_then(Value::as_str)
            .map(str::trim)
            .map_or(true, str::is_empty)
        || object
            .get("operations")
            .and_then(Value::as_array)
            .map_or(true, |items| items.len() > 128)
    {
        return Err("AI Director workflow revision does not match the Patch v1 envelope.".into());
    }
    Ok(value)
}

#[allow(clippy::too_many_arguments)]
fn run_workflow_director_revision(
    app: &AppHandle,
    provider: &str,
    context: WorkflowDirectorRevisionContext,
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
    validate_identifier(run_id, "Workflow Director revision run id")?;
    let prompt = workflow_director_revision_prompt(&validate_revision_context(&context)?);
    let job = TempJobDir::new("paintnode-workflow-revision")?;
    run_with_timeout(run_id, timeout, || {
        match provider.trim() {
            "codex" => {
                run_codex_workflow_revision_request(
                    app,
                    run_id,
                    codex_bin,
                    codex_model,
                    codex_reasoning_effort,
                    codex_service_tier,
                    job.path(),
                    &prompt,
                    WORKFLOW_DIRECTOR_REVISION_FILE,
                )?;
            }
            "claude" => {
                run_claude_workflow_revision_request(
                    app,
                    run_id,
                    claude_bin,
                    claude_model,
                    claude_effort,
                    job.path(),
                    &prompt,
                    WORKFLOW_DIRECTOR_REVISION_FILE,
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
                    WORKFLOW_DIRECTOR_REVISION_FILE,
                    None,
                )?;
                if !run.output.status.success() {
                    return Err("Antigravity workflow revision failed.".into());
                }
            }
            _ => return Err("Unsupported workflow Director revision provider.".into()),
        }
        Ok(())
    })?;
    read_workflow_revision(&job)
}

fn sanitize_revision_error(error: String) -> String {
    if error == AI_RUN_STOPPED_MESSAGE {
        return error;
    }
    if error.contains("timed out") {
        return "AI Director revision timed out and was stopped.".into();
    }
    "AI Director could not prepare a safe workflow revision. Review provider progress and try again.".into()
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

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn revise_workflow_with_director(
    app: AppHandle,
    provider: String,
    context: WorkflowDirectorRevisionContext,
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
        run_workflow_director_revision(
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
    .map_err(|_| "Workflow Director revision task failed.".to_string())?
    .map_err(sanitize_revision_error)
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

    fn revision_context() -> WorkflowDirectorRevisionContext {
        serde_json::from_value(serde_json::json!({
            "version": 1,
            "instruction": "Refine the brief.",
            "sourceGraphRevision": { "graphId": "graph-1", "revision": 2 },
            "graph": {
                "id": "graph-1",
                "nodes": [{ "id": "brief", "type": "brief", "title": "Brief", "position": {"x":0,"y":0}, "ports": {"inputs":[],"outputs":[]}, "config": {"objective":"Before"} }],
                "edges": []
            }
        })).expect("revision context")
    }

    #[test]
    fn revision_context_and_prompt_are_constrained_and_forbid_execution() {
        let json = validate_revision_context(&revision_context()).expect("valid revision");
        let prompt = workflow_director_revision_prompt(&json);
        assert!(prompt.contains("do not return a fresh GraphDraft"));
        assert!(prompt.contains("Do not call image-generation"));
        assert!(prompt.contains(WORKFLOW_DIRECTOR_REVISION_FILE));
        assert!(!prompt.contains("runRecords"));
        assert!(serde_json::from_value::<WorkflowDirectorRevisionContext>(serde_json::json!({
            "version":1,"instruction":"x","sourceGraphRevision":{},"graph":{},"projectPath":"/secret"
        })).is_err());
        assert!(
            serde_json::from_value::<WorkflowDirectorRevisionContext>(serde_json::json!({
                "version": 1,
                "instruction": "x",
                "sourceGraphRevision": { "graphId": "graph-1", "revision": 2 },
                "graph": {
                    "id": "graph-1",
                    "nodes": [{
                        "id": "brief", "type": "brief", "title": "Brief",
                        "position": {"x":0,"y":0}, "ports": {"inputs":[],"outputs":[]},
                        "config": {"objective":"Before"}, "runRecords": ["private"]
                    }],
                    "edges": []
                }
            }))
            .is_err()
        );
    }

    #[test]
    fn revision_reader_enforces_patch_envelope_and_sanitizes_errors() {
        let job = TempJobDir::new("paintnode-workflow-revision-read").expect("job");
        fs::write(job.path().join(WORKFLOW_DIRECTOR_REVISION_FILE), br#"{"version":1,"sourceGraphRevision":{"graphId":"g","revision":1},"summary":"Safe","operations":[]}"#).expect("write");
        assert_eq!(
            read_workflow_revision(&job).expect("revision")["version"],
            1
        );
        fs::write(
            job.path().join(WORKFLOW_DIRECTOR_REVISION_FILE),
            br#"{"version":1,"summary":"bad","operations":[]}"#,
        )
        .expect("write invalid");
        assert!(read_workflow_revision(&job)
            .unwrap_err()
            .contains("Patch v1"));
        assert!(!sanitize_revision_error("token /Users/alice/private".into()).contains("alice"));
    }
}
