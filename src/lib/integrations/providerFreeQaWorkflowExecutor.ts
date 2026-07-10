import { providerFreeQaSquarePng, type ProviderQaMode } from './desktop';
import {
  createWorkflowCompositionExecutor,
  WorkflowTransformExecutionError,
  type WorkflowNodeExecutor,
} from '../workflow/transformExecutor';
import { raceWorkflowCancellation, throwIfWorkflowCancelled } from '../workflow/runControl';

export type ProviderFreeQaPngLoader = () => Promise<Uint8Array>;
export type ProviderFreeQaScenario = 'success' | 'slow-success' | 'failure';

export interface ProviderFreeQaWorkflowExecutorOptions {
  scenario?: ProviderFreeQaScenario;
  progressSteps?: number;
  stepDelayMs?: number;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value!));
}

export function createProviderFreeQaWorkflowExecutor(
  mode: ProviderQaMode,
  loadPng: ProviderFreeQaPngLoader = providerFreeQaSquarePng,
  options: ProviderFreeQaWorkflowExecutorOptions = {},
): WorkflowNodeExecutor {
  if (mode !== 'provider-free') {
    throw new Error('The QA Fake executor is available only in provider-free QA mode.');
  }
  const scenario = options.scenario ?? 'success';
  const progressSteps = boundedInteger(options.progressSteps, 10, 1, 20);
  const stepDelayMs = boundedInteger(options.stepDelayMs, 500, 1, 2_000);
  return createWorkflowCompositionExecutor('qa-fake', async (request, context) => {
    if (request.output.width !== 1024 || request.output.height !== 1024) {
      throw new WorkflowTransformExecutionError(
        'INVALID_EXECUTOR_RESULT',
        'The provider-free QA fixture supports only the 1024 x 1024 Square output.',
        'Run Square Output',
      );
    }
    if (scenario === 'failure') {
      context.reportProgress({ message: 'QA Fake is simulating a safe provider failure.' });
      throw new Error('QA Fake simulated a provider failure. Review the workflow inputs, then retry Generate.');
    }
    if (scenario === 'slow-success') {
      for (let step = 1; step <= progressSteps; step += 1) {
        throwIfWorkflowCancelled(context.signal);
        context.reportProgress({
          message: `Slow provider-free QA ${step} of ${progressSteps}`,
          completed: step - 1,
          total: progressSteps,
        });
        await raceWorkflowCancellation(
          new Promise<void>((resolve) => setTimeout(resolve, stepDelayMs)),
          context.signal,
        );
      }
      throwIfWorkflowCancelled(context.signal);
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
