import type { WorkflowEdgeV2, WorkflowGraphV2, WorkflowNodeV2 } from './schema';

export interface WorkflowTransformVisualConnection {
  edge: WorkflowEdgeV2;
  node: WorkflowNodeV2;
  origin: 'inherited' | 'direct';
}

export interface WorkflowTransformContext {
  transform: WorkflowNodeV2 | null;
  sourceEdge: WorkflowEdgeV2 | null;
  sourceReview: WorkflowNodeV2 | null;
  artDirection: WorkflowNodeV2 | null;
  brief: WorkflowNodeV2 | null;
  inheritedVisuals: readonly WorkflowTransformVisualConnection[];
  directVisuals: readonly WorkflowTransformVisualConnection[];
  visualInputs: readonly WorkflowTransformVisualConnection[];
}

function nodeForEdgeSource(
  graph: WorkflowGraphV2,
  edge: WorkflowEdgeV2 | undefined,
  type: WorkflowNodeV2['type'],
): WorkflowNodeV2 | null {
  return graph.nodes.find((node) => node.id === edge?.source.nodeId && node.type === type) ?? null;
}

function inputConnections(
  graph: WorkflowGraphV2,
  targetNodeId: string | undefined,
  targetPortId: string,
  origin: WorkflowTransformVisualConnection['origin'],
): WorkflowTransformVisualConnection[] {
  if (!targetNodeId) return [];
  return graph.edges.flatMap((edge) => {
    if (edge.target.nodeId !== targetNodeId || edge.target.portId !== targetPortId) return [];
    const node = nodeForEdgeSource(graph, edge, 'input');
    return node ? [{ edge, node, origin }] : [];
  });
}

export function workflowTransformContext(
  graph: WorkflowGraphV2,
  transformNodeId: string,
): WorkflowTransformContext {
  const transform = graph.nodes.find((node) => node.id === transformNodeId && node.type === 'transform') ?? null;
  if (!transform) {
    return {
      transform: null,
      sourceEdge: null,
      sourceReview: null,
      artDirection: null,
      brief: null,
      inheritedVisuals: [],
      directVisuals: [],
      visualInputs: [],
    };
  }

  const decisionEdge = graph.edges.find((edge) => (
    edge.target.nodeId === transform.id && edge.target.portId === 'decision'
  )) ?? null;
  const sourceEdge = decisionEdge ?? graph.edges.find((edge) => (
    edge.target.nodeId === transform.id && edge.target.portId === 'source'
  )) ?? null;
  const directArtDirection = nodeForEdgeSource(graph, sourceEdge ?? undefined, 'art-direction');
  const sourceReview = nodeForEdgeSource(graph, decisionEdge ?? undefined, 'review');
  const conceptEdge = sourceReview
    ? graph.edges.find((edge) => edge.target.nodeId === sourceReview.id && edge.target.portId === 'candidates')
    : undefined;
  const conceptTransform = nodeForEdgeSource(graph, conceptEdge, 'transform');
  const conceptSourceEdge = conceptTransform
    ? graph.edges.find((edge) => edge.target.nodeId === conceptTransform.id && edge.target.portId === 'source')
    : undefined;
  const tracedArtDirection = nodeForEdgeSource(graph, conceptSourceEdge, 'art-direction');
  const artDirection = directArtDirection ?? tracedArtDirection;
  const briefEdge = artDirection
    ? graph.edges.find((edge) => edge.target.nodeId === artDirection.id && edge.target.portId === 'brief')
    : undefined;
  const brief = nodeForEdgeSource(graph, briefEdge, 'brief');
  const inheritedVisuals = inputConnections(graph, artDirection?.id, 'assets', 'inherited');
  const directVisuals = inputConnections(graph, transform.id, 'assets', 'direct');
  const inheritedNodeIds = new Set(inheritedVisuals.map((connection) => connection.node.id));
  const additionalDirectVisuals = directVisuals.filter((connection) => !inheritedNodeIds.has(connection.node.id));

  return {
    transform,
    sourceEdge,
    sourceReview,
    artDirection,
    brief,
    inheritedVisuals,
    directVisuals,
    visualInputs: [...inheritedVisuals, ...additionalDirectVisuals],
  };
}
