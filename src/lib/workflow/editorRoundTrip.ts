import {
  parseWorkflowGraphV2,
  type WorkflowEditorRevisionV1,
  type WorkflowGraphV2,
  type WorkflowRoundTripBindingV1,
  type WorkflowRunOutput,
} from './schema';
import { isFullWorkflowRunRecord, workflowSha256Text } from './provenance';

export interface WorkflowEditableResultIdentity {
  nodeId: string;
  rootRunId: string;
  candidateId?: string;
  promotionId?: string;
}

export interface WorkflowEffectiveResult {
  identity: WorkflowEditableResultIdentity;
  output: WorkflowRunOutput;
  editorRevision: WorkflowEditorRevisionV1 | null;
  materialKey: string;
}

function matchesIdentity(revision: WorkflowEditorRevisionV1, identity: WorkflowEditableResultIdentity): boolean {
  return revision.nodeId === identity.nodeId
    && revision.rootRunId === identity.rootRunId
    && revision.candidate?.candidateId === identity.candidateId
    && revision.promotion?.promotionId === identity.promotionId;
}

export function latestWorkflowEditorRevision(
  graph: WorkflowGraphV2,
  identity: WorkflowEditableResultIdentity,
): WorkflowEditorRevisionV1 | null {
  const bindings = (graph.workflowRoundTrips ?? []).filter((binding) => (
    binding.target.nodeId === identity.nodeId
    && binding.target.rootRunId === identity.rootRunId
    && binding.target.promotionId === identity.promotionId
  ));
  const superseded = new Set(bindings.map((binding) => binding.supersedesRoundTripId).filter(Boolean));
  const heads = bindings.filter((binding) => !superseded.has(binding.id));
  if (heads.length !== 1) return null;
  const revision = (graph.editorRevisions ?? []).find((candidate) => (
    candidate.id === heads[0].editorRevisionId && matchesIdentity(candidate, identity)
  ));
  return structuredClone(revision ?? null);
}

export function resolveWorkflowEffectiveResult(
  graph: WorkflowGraphV2,
  identity: WorkflowEditableResultIdentity,
): WorkflowEffectiveResult | null {
  const run = graph.runRecords.find((candidate) => candidate.id === identity.rootRunId);
  if (!run || !isFullWorkflowRunRecord(run) || run.status !== 'succeeded' || run.nodeId !== identity.nodeId) return null;
  if (run.candidate?.candidateId !== identity.candidateId) return null;
  if (identity.promotionId) {
    const promotion = (graph.reviewPromotions ?? []).find((candidate) => candidate.id === identity.promotionId);
    if (!promotion || promotion.candidateRunId !== run.id) return null;
  }
  const revision = latestWorkflowEditorRevision(graph, identity);
  const output = revision?.output ?? run.outputs[0];
  if (!output) return null;
  return {
    identity: structuredClone(identity),
    output: structuredClone(output),
    editorRevision: revision,
    materialKey: revision
      ? workflowSha256Text(JSON.stringify({
          kind: 'workflow-editor-revision-v1',
          rootMaterialKey: run.materialKey,
          revisionId: revision.id,
          assetReferenceId: revision.output.assetReferenceId,
          contentHash: revision.output.contentHash,
        }))
      : run.materialKey,
  };
}

export function appendWorkflowEditorRevision(
  graph: WorkflowGraphV2,
  revision: WorkflowEditorRevisionV1,
  binding: WorkflowRoundTripBindingV1,
): WorkflowGraphV2 {
  const next: WorkflowGraphV2 = {
    ...structuredClone(graph),
    assetReferences: [
      ...graph.assetReferences.map((reference) => structuredClone(reference)),
      {
        id: revision.output.assetReferenceId,
        role: 'output',
        assetId: revision.output.assetId,
        relativePath: revision.output.relativePath,
      },
    ],
    editorRevisions: [...(graph.editorRevisions ?? []).map((item) => structuredClone(item)), structuredClone(revision)],
    workflowRoundTrips: [...(graph.workflowRoundTrips ?? []).map((item) => structuredClone(item)), structuredClone(binding)],
  };
  const parsed = parseWorkflowGraphV2(next);
  if (!parsed.ok || !parsed.value) {
    throw new Error(parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
  }
  return parsed.value;
}
