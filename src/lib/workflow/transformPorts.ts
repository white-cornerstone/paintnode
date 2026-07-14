import type { WorkflowGraphV2, WorkflowNodePort, WorkflowNodeV2 } from './schema';

const DIRECTED_COMPOSITION_PORT: WorkflowNodePort = {
  id: 'source',
  label: 'Directed composition',
  dataType: 'layout',
};

const VISUAL_REFERENCES_PORT: WorkflowNodePort = {
  id: 'assets',
  label: 'Visual references',
  dataType: 'asset-reference',
  multiple: true,
};

const ADDITIONAL_GUIDANCE_PORT: WorkflowNodePort = {
  id: 'prompt',
  label: 'Additional guidance',
  dataType: 'prompt',
};

function normalizeTransformInputs(node: WorkflowNodeV2): { node: WorkflowNodeV2; changed: boolean } {
  if (node.type !== 'transform') return { node, changed: false };
  const source = node.ports.inputs.find((port) => port.id === 'source');
  const assets = node.ports.inputs.find((port) => port.id === 'assets');
  const prompt = node.ports.inputs.find((port) => port.id === 'prompt');
  const remaining = node.ports.inputs.filter((port) => !['source', 'assets', 'prompt'].includes(port.id));
  const inputs: WorkflowNodePort[] = [
    { ...DIRECTED_COMPOSITION_PORT, ...(source ? { label: source.label } : {}) },
    { ...VISUAL_REFERENCES_PORT, ...(assets ? { label: assets.label } : {}) },
    { ...ADDITIONAL_GUIDANCE_PORT, ...(prompt ? { label: prompt.label } : {}) },
    ...remaining,
  ];
  const changed = JSON.stringify(inputs) !== JSON.stringify(node.ports.inputs);
  return changed
    ? { node: { ...node, ports: { ...node.ports, inputs } }, changed: true }
    : { node, changed: false };
}

export function withTransformVisualReferencePorts(graph: WorkflowGraphV2): {
  graph: WorkflowGraphV2;
  normalized: boolean;
} {
  let normalized = false;
  const nodes = graph.nodes.map((node) => {
    const result = normalizeTransformInputs(node);
    normalized ||= result.changed;
    return result.node;
  });
  return normalized ? { graph: { ...graph, nodes }, normalized } : { graph, normalized };
}
