import type { WorkflowDirectorPatchOperation, WorkflowDirectorPatchV1 } from '../workflow/directorPatch';
import type {
  WorkflowDirectorRevisionRequest,
  WorkflowDirectorRevisionRequester,
} from '../workflow/directorRevisionSession';

function revisedText(current: unknown, instruction: string): string {
  const value = `QA Fake revision: ${instruction}`;
  return current === value ? `${value} (updated)` : value;
}

export function providerFreeWorkflowRevisionPatch(
  request: WorkflowDirectorRevisionRequest,
): WorkflowDirectorPatchV1 {
  const supported = request.graph.nodes.filter((node) => node.type !== 'unsupported');
  const node = ['brief', 'art-direction', 'transform', 'review', 'input', 'output']
    .map((type) => supported.find((item) => item.type === type))
    .find((item) => item !== undefined);
  if (!node) throw new Error('QA Fake could not find a creator node that can be revised.');

  let operation: WorkflowDirectorPatchOperation;
  if (node.type === 'brief') {
    operation = {
      op: 'configure-node', nodeId: node.id,
      changes: { objective: revisedText(node.config.objective, request.instruction) },
    };
  } else if (node.type === 'art-direction') {
    operation = {
      op: 'configure-node', nodeId: node.id,
      changes: { prompt: revisedText(node.config.prompt, request.instruction) },
    };
  } else if (node.type === 'transform') {
    operation = {
      op: 'configure-node', nodeId: node.id,
      changes: { instructions: revisedText(node.config.instructions, request.instruction) },
    };
  } else if (node.type === 'review') {
    operation = {
      op: 'configure-node', nodeId: node.id,
      changes: { instructions: revisedText(node.config.instructions, request.instruction) },
    };
  } else if (node.type === 'input') {
    operation = {
      op: 'configure-node', nodeId: node.id,
      changes: { role: revisedText(node.config.role, request.instruction) },
    };
  } else {
    operation = {
      op: 'move-node', nodeId: node.id,
      position: { x: node.position.x + 24, y: node.position.y + 24 },
    };
  }

  return {
    version: 1,
    sourceGraphRevision: request.sourceGraphRevision,
    summary: `QA Fake revision preview for ${node.title}.`,
    operations: [operation],
  };
}

export function createProviderFreeWorkflowRevisionRequester(): WorkflowDirectorRevisionRequester {
  return Object.freeze({
    label: 'QA Fake · deterministic provider-free revision',
    providerFree: true as const,
    request: async (request: WorkflowDirectorRevisionRequest, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error('The provider-free revision request was cancelled.');
      return providerFreeWorkflowRevisionPatch(request);
    },
  });
}
