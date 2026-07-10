import {
  composeAntigravityWorkflow,
  composeCodexWorkflow,
  type AntigravityGeneratorConfig,
  type CodexGeneratorConfig,
  type GeneratedImageResult,
} from './desktop';
import { listen } from '@tauri-apps/api/event';
import {
  createWorkflowCompositionExecutor,
  WorkflowTransformExecutionError,
  type WorkflowNodeExecutionContext,
  type WorkflowNodeExecutor,
  type WorkflowTransformExecutionRequest,
} from '../workflow/transformExecutor';
import { runWithAsyncObserver } from '../workflow/runObserver';
import { WorkflowRunCancelledError } from '../workflow/runControl';

type ProviderProgressPayload = {
  runId: string;
  message: string;
  completed?: number;
  total?: number;
};

export interface WorkflowCompositionAdapterDependencies {
  observeProgress?: (
    runId: string,
    report: (payload: Readonly<ProviderProgressPayload>) => void,
  ) => Promise<() => void>;
}

async function observeDesktopProgress(
  runId: string,
  report: (payload: Readonly<ProviderProgressPayload>) => void,
): Promise<() => void> {
  if (!('__TAURI_INTERNALS__' in globalThis)) return () => undefined;
  return listen<ProviderProgressPayload>('codex-generation-progress', (event) => {
    if (event.payload.runId === runId) report(event.payload);
  });
}

async function executeObservedProvider<T>(
  runId: string | undefined,
  context: Readonly<WorkflowNodeExecutionContext>,
  operation: () => Promise<T>,
  dependencies: WorkflowCompositionAdapterDependencies,
): Promise<T> {
  const execute = async (): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if ((error as Error)?.message === 'The task was stopped.') throw new WorkflowRunCancelledError();
      throw error;
    }
  };
  if (!runId) return execute();
  return runWithAsyncObserver({
    register: () => (dependencies.observeProgress ?? observeDesktopProgress)(runId, (payload) => {
      if (payload.runId !== runId) return;
      context.reportProgress({
        message: payload.message,
        ...(payload.completed !== undefined ? { completed: payload.completed } : {}),
        ...(payload.total !== undefined ? { total: payload.total } : {}),
      });
    }),
    run: execute,
  });
}

function providerRunId(
  configuredRunId: string | undefined,
  context: Readonly<WorkflowNodeExecutionContext>,
): string | undefined {
  return context.identity.runId === 'unscoped-run' ? configuredRunId : context.identity.runId;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringOverride<T>(value: unknown, fallback: T): T {
  return typeof value === 'string' && value.trim() ? value as T : fallback;
}

function numberOverride<T>(value: unknown, fallback: T): T {
  return typeof value === 'number' && Number.isFinite(value) ? value as T : fallback;
}

function definedOptions(entries: Array<readonly [string, unknown]>): Record<string, unknown> {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

function codexConfigForRequest(
  config: CodexGeneratorConfig,
  request: Readonly<WorkflowTransformExecutionRequest>,
): CodexGeneratorConfig {
  const advanced = request.transform.advanced;
  const options = record(advanced.options);
  return {
    ...config,
    model: stringOverride(advanced.model, config.model),
    reasoningEffort: stringOverride(options.reasoningEffort, config.reasoningEffort),
    serviceTier: stringOverride(options.serviceTier, config.serviceTier),
    imageQuality: stringOverride(options.imageQuality, config.imageQuality),
    imageModeration: stringOverride(options.imageModeration, config.imageModeration),
    autonomyLevel: stringOverride(options.autonomyLevel, config.autonomyLevel),
    editChecksLevel: numberOverride(options.editChecksLevel, config.editChecksLevel),
    directorMode: 'skip',
  };
}

function antigravityConfigForRequest(
  config: AntigravityGeneratorConfig,
  request: Readonly<WorkflowTransformExecutionRequest>,
): AntigravityGeneratorConfig {
  const advanced = request.transform.advanced;
  const options = record(advanced.options);
  return {
    ...config,
    model: stringOverride(options.agentModel, config.model),
    approvalMode: stringOverride(options.approvalMode, config.approvalMode),
    imageModel: stringOverride(advanced.model, config.imageModel),
    imageSize: stringOverride(options.imageSize, config.imageSize),
    personGeneration: stringOverride(options.personGeneration, config.personGeneration),
    prominentPeople: stringOverride(options.prominentPeople, config.prominentPeople),
    compressionQuality: numberOverride(options.compressionQuality, config.compressionQuality),
    advancedJson: stringOverride(options.advancedJson, config.advancedJson),
    safetyFiltering: stringOverride(options.safetyFiltering, config.safetyFiltering),
    safetyHarassment: stringOverride(options.safetyHarassment, config.safetyHarassment),
    safetyHateSpeech: stringOverride(options.safetyHateSpeech, config.safetyHateSpeech),
    safetySexuallyExplicit: stringOverride(options.safetySexuallyExplicit, config.safetySexuallyExplicit),
    safetyDangerousContent: stringOverride(options.safetyDangerousContent, config.safetyDangerousContent),
    autonomyLevel: stringOverride(options.autonomyLevel, config.autonomyLevel),
    editChecksLevel: numberOverride(options.editChecksLevel, config.editChecksLevel),
    directorMode: 'skip',
  };
}

function providerSources(request: Readonly<WorkflowTransformExecutionRequest>) {
  return [
    ...(request.storyboard?.source ? [{
      name: request.storyboard.source.name,
      bytes: request.storyboard.source.bytes,
    }] : []),
    ...request.sources.map((source) => ({ name: source.name, bytes: source.bytes })),
  ];
}

async function resultAsset(result: GeneratedImageResult) {
  const asset = result.asset;
  if (!asset) {
    throw new WorkflowTransformExecutionError(
      'INVALID_EXECUTOR_RESULT',
      'The image provider did not save a generated project asset.',
      'Retry Generate',
    );
  }
  const bytes = new Uint8Array(await (await fetch(result.dataUrl)).arrayBuffer());
  if (bytes.length === 0) {
    throw new WorkflowTransformExecutionError(
      'INVALID_EXECUTOR_RESULT',
      'The image provider returned an empty generated project asset.',
      'Retry Generate',
    );
  }
  return { kind: 'project-asset' as const, asset, bytes };
}

export function createCodexWorkflowTransformExecutor(
  config: CodexGeneratorConfig,
  dependencies: WorkflowCompositionAdapterDependencies = {},
): WorkflowNodeExecutor {
  return createWorkflowCompositionExecutor('codex', async (request, context) => {
    const runId = providerRunId(config.runId, context);
    return resultAsset(await executeObservedProvider(runId, context, () => composeCodexWorkflow(
      codexConfigForRequest({ ...config, runId }, request),
      request.prompt,
      providerSources(request),
      request.output,
    ), dependencies));
  }, {
    executor: { id: 'paintnode-codex-workflow', version: '1', requestSchemaVersion: '1' },
    describeRun: (request) => {
      const effective = codexConfigForRequest(config, request);
      return {
        id: 'codex',
        model: effective.model ?? null,
        effectiveOptions: definedOptions([
          ['reasoningEffort', effective.reasoningEffort],
          ['serviceTier', effective.serviceTier],
          ['imageQuality', effective.imageQuality],
          ['imageModeration', effective.imageModeration],
          ['autonomyLevel', effective.autonomyLevel],
          ['editChecksLevel', effective.editChecksLevel],
        ]),
      };
    },
  });
}

export function createAntigravityWorkflowTransformExecutor(
  config: AntigravityGeneratorConfig,
  dependencies: WorkflowCompositionAdapterDependencies = {},
): WorkflowNodeExecutor {
  return createWorkflowCompositionExecutor('antigravity', async (request, context) => {
    const runId = providerRunId(config.runId, context);
    return resultAsset(await executeObservedProvider(runId, context, () => composeAntigravityWorkflow(
      antigravityConfigForRequest({ ...config, runId }, request),
      request.prompt,
      providerSources(request),
      request.output,
    ), dependencies));
  }, {
    executor: { id: 'paintnode-antigravity-workflow', version: '1', requestSchemaVersion: '1' },
    describeRun: (request) => {
      const effective = antigravityConfigForRequest(config, request);
      return {
        id: 'antigravity',
        model: effective.imageModel ?? null,
        effectiveOptions: definedOptions([
          ['approvalMode', effective.approvalMode],
          ['agentModel', effective.model],
          ['imageSize', effective.imageSize],
          ['personGeneration', effective.personGeneration],
          ['prominentPeople', effective.prominentPeople],
          ['compressionQuality', effective.compressionQuality],
          ['safetyFiltering', effective.safetyFiltering],
          ['safetyHarassment', effective.safetyHarassment],
          ['safetyHateSpeech', effective.safetyHateSpeech],
          ['safetySexuallyExplicit', effective.safetySexuallyExplicit],
          ['safetyDangerousContent', effective.safetyDangerousContent],
          ['autonomyLevel', effective.autonomyLevel],
          ['editChecksLevel', effective.editChecksLevel],
        ]),
      };
    },
  });
}
