import type { WorkflowGraphV2, WorkflowNodeV2 } from './schema';

export type WorkflowTransformRole = 'concept-generator' | 'format-adapter' | 'standard';

export function workflowTransformRole(graph: WorkflowGraphV2, transformNodeId: string): WorkflowTransformRole {
  const transform = graph.nodes.find((node) => node.id === transformNodeId && node.type === 'transform');
  if (!transform) return 'standard';
  const feedsReview = graph.edges.some((edge) => edge.source.nodeId === transform.id
    && edge.source.portId === 'result'
    && edge.target.portId === 'candidates'
    && graph.nodes.some((node) => node.id === edge.target.nodeId && node.type === 'review'));
  if (feedsReview) return 'concept-generator';
  const receivesReview = graph.edges.some((edge) => edge.target.nodeId === transform.id
    && (edge.target.portId === 'decision' || edge.target.portId === 'source')
    && edge.source.portId === 'selected'
    && graph.nodes.some((node) => node.id === edge.source.nodeId && node.type === 'review'));
  return receivesReview ? 'format-adapter' : 'standard';
}

export function workflowConceptReviewNode(
  graph: WorkflowGraphV2,
  transformNodeId: string,
): WorkflowNodeV2 | null {
  const edge = graph.edges.find((candidate) => candidate.source.nodeId === transformNodeId
    && candidate.source.portId === 'result'
    && candidate.target.portId === 'candidates');
  return graph.nodes.find((node) => node.id === edge?.target.nodeId && node.type === 'review') ?? null;
}

export function workflowConceptPreviewTarget(
  graph: WorkflowGraphV2,
  transformNodeId: string,
): { nodeId: string; title: string; width: number; height: number; aspectRatio: string } | null {
  const transform = graph.nodes.find((node) => node.id === transformNodeId && node.type === 'transform');
  if (!transform || workflowTransformRole(graph, transformNodeId) !== 'concept-generator') return null;
  const width = typeof transform.config.conceptPreviewWidth === 'number'
    && Number.isSafeInteger(transform.config.conceptPreviewWidth)
    && transform.config.conceptPreviewWidth >= 64
    ? transform.config.conceptPreviewWidth
    : 1024;
  const height = typeof transform.config.conceptPreviewHeight === 'number'
    && Number.isSafeInteger(transform.config.conceptPreviewHeight)
    && transform.config.conceptPreviewHeight >= 64
    ? transform.config.conceptPreviewHeight
    : 1024;
  const aspectRatio = typeof transform.config.conceptPreviewAspectRatio === 'string'
    ? transform.config.conceptPreviewAspectRatio
    : '1:1';
  return {
    nodeId: `concept-preview-${transform.id}`,
    title: `${transform.title} concept preview`,
    width,
    height,
    aspectRatio,
  };
}
