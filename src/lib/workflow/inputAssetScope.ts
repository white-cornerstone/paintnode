import type { WorkflowGraphV2, WorkflowNodeV2 } from './schema';

export interface WorkflowExtractedAssetLink {
  id: string;
  name: string;
  relativePath: string;
}

export interface WorkflowInputAssetScope {
  nodeId: string;
  nodeName: string;
  assets: WorkflowExtractedAssetLink[];
}

export function workflowExtractedAssetLinks(
  config: Readonly<Record<string, unknown>>,
): WorkflowExtractedAssetLink[] {
  const value = config.resultAssets;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    return typeof record.id === 'string'
      && typeof record.name === 'string'
      && typeof record.relativePath === 'string'
      ? [{ id: record.id, name: record.name, relativePath: record.relativePath }]
      : [];
  });
}

export function workflowExtractionQuickLinks(
  graph: Pick<WorkflowGraphV2, 'nodes'>,
): Array<WorkflowExtractedAssetLink & { nodeId: string; nodeName: string }> {
  return graph.nodes.flatMap((node) => node.type === 'extract-assets'
    ? workflowExtractedAssetLinks(node.config).map((asset) => ({
        ...asset,
        nodeId: node.id,
        nodeName: node.title,
      }))
    : []);
}

export function workflowInputAssetScope(
  graph: Pick<WorkflowGraphV2, 'nodes' | 'edges'>,
  inputNodeId: string,
): WorkflowInputAssetScope | null {
  const connection = graph.edges.find((edge) => (
    edge.target.nodeId === inputNodeId
    && edge.target.portId === 'scope'
    && edge.source.portId === 'assets'
  ));
  if (!connection) return null;
  const source = graph.nodes.find((node) => node.id === connection.source.nodeId);
  if (!source || source.type !== 'extract-assets') return null;
  return {
    nodeId: source.id,
    nodeName: source.title,
    assets: workflowExtractedAssetLinks(source.config),
  };
}

export function withInputAssetScopePorts(graph: WorkflowGraphV2): WorkflowGraphV2 {
  let changed = false;
  const nodes = graph.nodes.map((node): WorkflowNodeV2 => {
    if (node.type !== 'input' || node.ports.inputs.some((port) => port.id === 'scope')) return node;
    changed = true;
    return {
      ...node,
      ports: {
        ...node.ports,
        inputs: [
          ...node.ports.inputs,
          { id: 'scope', label: 'Extracted asset scope', dataType: 'asset-reference' },
        ],
      },
    };
  });
  return changed ? { ...graph, nodes } : graph;
}
