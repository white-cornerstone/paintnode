import type { WorkflowGraphV2 } from './schema';

/**
 * Captures the nodes whose persisted inputs contribute to a background workflow task.
 * The returned order follows graph order so task records and UI are deterministic.
 */
export function workflowTaskUpstreamNodeIds(
  graph: Pick<WorkflowGraphV2, 'nodes' | 'edges'>,
  rootNodeIds: readonly string[],
): string[] {
  const graphNodeIds = new Set(graph.nodes.map((node) => node.id));
  const scoped = new Set(rootNodeIds.filter((nodeId) => graphNodeIds.has(nodeId)));
  const pending = [...scoped];
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const edge of graph.edges) {
      if (edge.target.nodeId !== current || scoped.has(edge.source.nodeId) || !graphNodeIds.has(edge.source.nodeId)) continue;
      scoped.add(edge.source.nodeId);
      pending.push(edge.source.nodeId);
    }
  }
  return graph.nodes.filter((node) => scoped.has(node.id)).map((node) => node.id);
}
