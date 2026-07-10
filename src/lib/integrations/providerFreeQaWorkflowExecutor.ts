import { providerFreeQaSquarePng, type ProviderQaMode } from './desktop';
import {
  createWorkflowCompositionExecutor,
  WorkflowTransformExecutionError,
  type WorkflowNodeExecutor,
} from '../workflow/transformExecutor';

export type ProviderFreeQaPngLoader = () => Promise<Uint8Array>;

export function createProviderFreeQaWorkflowExecutor(
  mode: ProviderQaMode,
  loadPng: ProviderFreeQaPngLoader = providerFreeQaSquarePng,
): WorkflowNodeExecutor {
  if (mode !== 'provider-free') {
    throw new Error('The QA Fake executor is available only in provider-free QA mode.');
  }
  return createWorkflowCompositionExecutor('qa-fake', async (request) => {
    if (request.output.width !== 1024 || request.output.height !== 1024) {
      throw new WorkflowTransformExecutionError(
        'INVALID_EXECUTOR_RESULT',
        'The provider-free QA fixture supports only the 1024 x 1024 Square output.',
        'Run Square Output',
      );
    }
    const bytes = await loadPng();
    return {
      kind: 'bytes',
      name: 'paintnode-provider-free-qa-square.png',
      bytes: new Uint8Array(bytes),
      mime: 'image/png',
      width: 1024,
      height: 1024,
    };
  }, {
    materialization: 'metadata-only',
    executor: { id: 'paintnode-qa-fake-square', version: '1', requestSchemaVersion: '1' },
    describeRun: () => ({ id: 'qa-fake', model: null, effectiveOptions: { fixture: 'square' } }),
  });
}
