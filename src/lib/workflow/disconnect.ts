import type { WorkflowEdgeV2, WorkflowGraphV2, WorkflowNodePort, WorkflowNodeV2 } from './schema';

export type WorkflowDisconnectDirection = 'input' | 'output';

export interface WorkflowDisconnectLink {
  id: string;
  direction: WorkflowDisconnectDirection;
  peerNodeId: string;
  peerNodeTitle: string;
  localPortId: string;
  localPortLabel: string;
  peerPortId: string;
  peerPortLabel: string;
}

type WorkflowDisconnectGraph = Pick<WorkflowGraphV2, 'nodes' | 'edges'>;

function portLabel(ports: readonly WorkflowNodePort[], portId: string): string {
  return ports.find((port) => port.id === portId)?.label || portId;
}

function inputLink(
  edge: WorkflowEdgeV2,
  node: WorkflowNodeV2,
  peer: WorkflowNodeV2,
): WorkflowDisconnectLink {
  return {
    id: edge.id,
    direction: 'input',
    peerNodeId: peer.id,
    peerNodeTitle: peer.title,
    localPortId: edge.target.portId,
    localPortLabel: portLabel(node.ports.inputs, edge.target.portId),
    peerPortId: edge.source.portId,
    peerPortLabel: portLabel(peer.ports.outputs, edge.source.portId),
  };
}

function outputLink(
  edge: WorkflowEdgeV2,
  node: WorkflowNodeV2,
  peer: WorkflowNodeV2,
): WorkflowDisconnectLink {
  return {
    id: edge.id,
    direction: 'output',
    peerNodeId: peer.id,
    peerNodeTitle: peer.title,
    localPortId: edge.source.portId,
    localPortLabel: portLabel(node.ports.outputs, edge.source.portId),
    peerPortId: edge.target.portId,
    peerPortLabel: portLabel(peer.ports.inputs, edge.target.portId),
  };
}

export function workflowNodeDisconnectLinks(
  graph: WorkflowDisconnectGraph,
  nodeId: string,
): WorkflowDisconnectLink[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const node = nodes.get(nodeId);
  if (!node) return [];

  const inputs: WorkflowDisconnectLink[] = [];
  const outputs: WorkflowDisconnectLink[] = [];
  for (const edge of graph.edges) {
    if (edge.target.nodeId === nodeId) {
      const peer = nodes.get(edge.source.nodeId);
      if (peer) inputs.push(inputLink(edge, node, peer));
    } else if (edge.source.nodeId === nodeId) {
      const peer = nodes.get(edge.target.nodeId);
      if (peer) outputs.push(outputLink(edge, node, peer));
    }
  }
  return [...inputs, ...outputs];
}

export function workflowDisconnectMode(
  links: readonly WorkflowDisconnectLink[],
): 'none' | 'immediate' | 'confirm' {
  if (links.length === 0) return 'none';
  return links.length === 1 ? 'immediate' : 'confirm';
}
