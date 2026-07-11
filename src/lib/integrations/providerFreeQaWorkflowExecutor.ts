import { providerFreeQaPng, type ProviderQaMode } from './desktop';
import {
  createWorkflowCompositionExecutor,
  WorkflowTransformExecutionError,
  type WorkflowNodeExecutor,
} from '../workflow/transformExecutor';
import { raceWorkflowCancellation, throwIfWorkflowCancelled } from '../workflow/runControl';

export type ProviderFreeQaPngLoader = (
  width: number, height: number, variant: number,
) => Promise<Uint8Array>;
export type ProviderFreeQaScenario =
  | 'success'
  | 'slow-success'
  | 'failure'
  | 'branch-one-failure'
  | 'landscape-first-failure';

export interface ProviderFreeQaWorkflowExecutorOptions {
  scenario?: ProviderFreeQaScenario;
  progressSteps?: number;
  stepDelayMs?: number;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value!));
}

function candidateFixtureVariant(runId: string, fixture: string): number {
  if (fixture !== 'square') return 0;
  const ordinal = /^candidate-(\d+)-[a-f0-9]+-attempt-\d+$/.exec(runId)?.[1];
  if (!ordinal) return 0;
  return boundedInteger(Number(ordinal), 0, 1, 4);
}

function workflowRunAttempt(runId: string): number | null {
  const value = /(?:-attempt-|:)(\d+)$/.exec(runId)?.[1];
  if (!value) return null;
  const attempt = Number(value);
  return Number.isSafeInteger(attempt) && attempt > 0 ? attempt : null;
}

export function createProviderFreeQaWorkflowExecutor(
  mode: ProviderQaMode,
  loadPng: ProviderFreeQaPngLoader = providerFreeQaPng,
  options: ProviderFreeQaWorkflowExecutorOptions = {},
): WorkflowNodeExecutor {
  if (mode !== 'provider-free') {
    throw new Error('The QA Fake executor is available only in provider-free QA mode.');
  }
  const scenario = options.scenario ?? 'success';
  const progressSteps = boundedInteger(options.progressSteps, 10, 1, 20);
  const stepDelayMs = boundedInteger(options.stepDelayMs, 500, 1, 2_000);
  return createWorkflowCompositionExecutor('qa-fake', async (request, context) => {
    const fixture = request.output.width === 1024 && request.output.height === 1024
      ? 'square'
      : request.output.width === 1024 && request.output.height === 1280
        ? 'portrait'
        : request.output.width === 1280 && request.output.height === 720
          ? 'landscape'
          : null;
    if (!fixture) {
      throw new WorkflowTransformExecutionError(
        'INVALID_EXECUTOR_RESULT',
        'The provider-free QA fixture supports only Campaign Composer 1:1, 4:5, and 16:9 outputs.',
        'Run a configured Campaign Composer output',
      );
    }
    if (scenario === 'failure') {
      context.reportProgress({ message: 'QA Fake is simulating a safe provider failure.' });
      throw new Error('QA Fake simulated a provider failure. Review the workflow inputs, then retry Generate.');
    }
    if (scenario === 'branch-one-failure'
      && /candidate-2-[a-f0-9]+-attempt-1$/.test(context.identity.runId)) {
      context.reportProgress({ message: 'QA Fake is failing candidate 2 so its retry can be validated.' });
      throw new Error('QA Fake candidate 2 failed safely. Retry this candidate to preserve its siblings.');
    }
    if (scenario === 'landscape-first-failure'
      && request.nodeId === 'transform-generate-landscape'
      && workflowRunAttempt(context.identity.runId) === 1) {
      context.reportProgress({ message: 'QA Fake is failing the first Landscape attempt so its retry can be validated.' });
      throw new Error('QA Fake Landscape failed safely. Retry Landscape to preserve the completed formats.');
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
    const bytes = await loadPng(
      request.output.width,
      request.output.height,
      candidateFixtureVariant(context.identity.runId, fixture),
    );
    return {
      kind: 'bytes',
      name: `paintnode-provider-free-qa-${fixture}.png`,
      bytes: new Uint8Array(bytes),
      mime: 'image/png',
      width: request.output.width,
      height: request.output.height,
    };
  }, {
    materialization: 'metadata-only',
    executor: { id: 'paintnode-qa-fake-campaign', version: '2', requestSchemaVersion: '1' },
    describeRun: (request) => ({
      id: 'qa-fake', model: null,
      effectiveOptions: {
        fixture: request.output.width === 1024 && request.output.height === 1024
          ? 'square'
          : request.output.width === 1024 ? 'portrait' : 'landscape',
      },
    }),
  });
}
