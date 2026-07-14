import { createCreatorNode } from './registry';
import type { WorkflowEdgeV2, WorkflowGraphV2, WorkflowNodeV2 } from './schema';

const REVIEW_DECISION_PORT = {
  id: 'selected',
  label: 'Promoted concept',
  dataType: 'review-decision' as const,
};

function uniqueId(existing: Set<string>, preferred: string): string {
  if (!existing.has(preferred)) {
    existing.add(preferred);
    return preferred;
  }
  let index = 2;
  while (existing.has(`${preferred}-${index}`)) index += 1;
  const id = `${preferred}-${index}`;
  existing.add(id);
  return id;
}

function outputDimensions(node: WorkflowNodeV2 | undefined): { width: number; height: number } {
  const width = typeof node?.config.finalWidth === 'number' && node.config.finalWidth > 0
    ? Math.round(node.config.finalWidth)
    : 1024;
  const height = typeof node?.config.finalHeight === 'number' && node.config.finalHeight > 0
    ? Math.round(node.config.finalHeight)
    : 1024;
  return { width, height };
}

function aspectRatio(width: number, height: number): string {
  if (width === height) return '1:1';
  if (Math.abs(width / height - 4 / 5) < 0.01) return '4:5';
  if (Math.abs(width / height - 16 / 9) < 0.01) return '16:9';
  return 'custom';
}

/**
 * Upgrades the v2 campaign contract without changing the file version:
 * Review emits a typed decision, direct Review -> Output links gain a format
 * adapter, and the concept generator owns a review-preview shape.
 */
export function withReviewDecisionContracts(graph: WorkflowGraphV2): {
  graph: WorkflowGraphV2;
  normalized: boolean;
} {
  let normalized = false;
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  let nodes = graph.nodes.map((node): WorkflowNodeV2 => {
    if (node.type !== 'review') return node;
    const remaining = node.ports.outputs.filter((port) => port.id !== 'selected');
    const outputs = [{ ...REVIEW_DECISION_PORT }, ...remaining];
    if (JSON.stringify(outputs) === JSON.stringify(node.ports.outputs)) return node;
    normalized = true;
    return { ...node, ports: { ...node.ports, outputs } };
  });

  let edges = graph.edges.map((edge): WorkflowEdgeV2 => {
    const source = nodes.find((node) => node.id === edge.source.nodeId);
    const target = nodes.find((node) => node.id === edge.target.nodeId);
    if (source?.type !== 'review' || edge.source.portId !== 'selected'
      || target?.type !== 'transform' || edge.target.portId !== 'source') return edge;
    normalized = true;
    return { ...edge, target: { ...edge.target, portId: 'decision' } };
  });

  const directReviewOutputs = edges.filter((edge) => {
    const source = nodes.find((node) => node.id === edge.source.nodeId);
    const target = nodes.find((node) => node.id === edge.target.nodeId);
    return source?.type === 'review' && edge.source.portId === 'selected'
      && target?.type === 'output' && edge.target.portId === 'source';
  });
  for (const edge of directReviewOutputs) {
    const review = nodes.find((node) => node.id === edge.source.nodeId)!;
    const output = nodes.find((node) => node.id === edge.target.nodeId)!;
    const adapterId = uniqueId(nodeIds, `transform-format-${output.id}`);
    const adapter = createCreatorNode('transform', {
      id: adapterId,
      title: `Adapt for ${output.title}`,
      position: {
        x: Math.round((review.position.x + review.size.width + output.position.x - 240) / 2),
        y: output.position.y,
      },
      config: {
        workflowRole: 'format-adapter',
        capability: 'generate',
        instructions: `Adapt the promoted concept for ${output.title} while preserving the original assets and creative direction.`,
      },
    });
    nodes = [...nodes, adapter];
    edges = edges.filter((candidate) => candidate.id !== edge.id);
    edges.push(
      {
        ...edge,
        source: { ...edge.source },
        target: { nodeId: adapterId, portId: 'decision' },
      },
      {
        id: uniqueId(edgeIds, `edge-${adapterId}-${output.id}`),
        source: { nodeId: adapterId, portId: 'result' },
        target: { nodeId: output.id, portId: 'source' },
      },
    );
    normalized = true;
  }

  nodes = nodes.map((node): WorkflowNodeV2 => {
    if (node.type !== 'transform') return node;
    const feedsReview = edges.some((edge) => edge.source.nodeId === node.id
      && edge.source.portId === 'result'
      && nodes.some((target) => target.id === edge.target.nodeId && target.type === 'review'));
    const receivesReview = edges.some((edge) => edge.target.nodeId === node.id
      && edge.target.portId === 'decision'
      && nodes.some((source) => source.id === edge.source.nodeId && source.type === 'review'));
    if (!feedsReview && !receivesReview) return node;
    if (feedsReview) {
      const reviewEdge = edges.find((edge) => edge.source.nodeId === node.id && edge.target.portId === 'candidates');
      const formerPrimary = directReviewOutputs
        .find((edge) => edge.source.nodeId === reviewEdge?.target.nodeId);
      const output = nodes.find((candidate) => candidate.id === formerPrimary?.target.nodeId);
      const dimensions = outputDimensions(output);
      const config = {
        ...node.config,
        workflowRole: 'concept-generator',
        conceptPreviewAspectRatio: typeof node.config.conceptPreviewAspectRatio === 'string'
          ? node.config.conceptPreviewAspectRatio
          : aspectRatio(dimensions.width, dimensions.height),
        conceptPreviewWidth: typeof node.config.conceptPreviewWidth === 'number'
          ? node.config.conceptPreviewWidth
          : dimensions.width,
        conceptPreviewHeight: typeof node.config.conceptPreviewHeight === 'number'
          ? node.config.conceptPreviewHeight
          : dimensions.height,
      };
      if (JSON.stringify(config) === JSON.stringify(node.config)) return node;
      normalized = true;
      return { ...node, config };
    }
    if (node.config.workflowRole === 'format-adapter') return node;
    normalized = true;
    return { ...node, config: { ...node.config, workflowRole: 'format-adapter' } };
  });

  return normalized ? { graph: { ...graph, nodes, edges }, normalized } : { graph, normalized };
}
