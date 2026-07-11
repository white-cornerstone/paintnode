import {
  parseWorkflowGraphV2,
  type WorkflowEditorRevisionV1,
  type WorkflowGraphV2,
  type WorkflowRoundTripBindingV1,
} from './schema';
export {
  latestWorkflowEditorRevision,
  resolveWorkflowEffectiveResult,
  type WorkflowEditableResultIdentity,
  type WorkflowEffectiveResult,
} from './effectiveResult';

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
