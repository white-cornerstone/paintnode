import {
  composeAntigravityWorkflow,
  composeCodexWorkflow,
  type AntigravityGeneratorConfig,
  type CodexGeneratorConfig,
  type GeneratedImageResult,
} from './desktop';
import {
  createWorkflowCompositionExecutor,
  WorkflowTransformExecutionError,
  type WorkflowNodeExecutor,
} from '../workflow/transformExecutor';

function resultAsset(result: GeneratedImageResult) {
  const asset = result.asset;
  if (!asset) {
    throw new WorkflowTransformExecutionError(
      'INVALID_EXECUTOR_RESULT',
      'The image provider did not save a generated project asset.',
      'Retry Generate',
    );
  }
  return { kind: 'project-asset' as const, asset };
}

export function createCodexWorkflowTransformExecutor(config: CodexGeneratorConfig): WorkflowNodeExecutor {
  return createWorkflowCompositionExecutor('codex', async (request) => resultAsset(
    await composeCodexWorkflow(
      { ...config, directorMode: 'skip' },
      request.prompt,
      request.sources.map((source) => ({ name: source.name, bytes: source.bytes })),
      request.output,
    ),
  ));
}

export function createAntigravityWorkflowTransformExecutor(config: AntigravityGeneratorConfig): WorkflowNodeExecutor {
  return createWorkflowCompositionExecutor('antigravity', async (request) => resultAsset(
    await composeAntigravityWorkflow(
      { ...config, directorMode: 'skip' },
      request.prompt,
      request.sources.map((source) => ({ name: source.name, bytes: source.bytes })),
      request.output,
    ),
  ));
}
