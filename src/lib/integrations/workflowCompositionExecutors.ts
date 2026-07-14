import {
  composeAntigravityWorkflow,
  composeCodexWorkflow,
  composeGrokWorkflow,
  generateAntigravityRetouchImage,
  generateCodexRetouchImage,
  generateGrokRetouchImage,
  upscaleAntigravityImage,
  upscaleCodexImage,
  upscaleGrokImage,
  type AntigravityGeneratorConfig,
  type CodexGeneratorConfig,
  type GeneratedImageResult,
  type GrokGeneratorConfig,
} from './desktop';
import { bytesToBitmap, canvasToPngBytes } from '../io';
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
  const director = request.transform.ai?.director;
  const image = request.transform.ai?.image;
  const options = record(advanced.options);
  return {
    ...config,
    model: stringOverride(director?.provider === 'codex' ? director.model : advanced.model, config.model),
    reasoningEffort: stringOverride(options.reasoningEffort, config.reasoningEffort),
    serviceTier: stringOverride(options.serviceTier, config.serviceTier),
    autonomyLevel: stringOverride(options.autonomyLevel, config.autonomyLevel),
    editChecksLevel: numberOverride(options.editChecksLevel, config.editChecksLevel),
    directorMode: director?.mode ?? config.directorMode,
    directorProvider: director?.provider ?? config.directorProvider,
    directorInvolvement: director?.involvement ?? config.directorInvolvement,
    imageQuality: stringOverride(image?.options.imageQuality, stringOverride(options.imageQuality, config.imageQuality)),
    imageModeration: stringOverride(image?.options.imageModeration, stringOverride(options.imageModeration, config.imageModeration)),
  };
}

function antigravityConfigForRequest(
  config: AntigravityGeneratorConfig,
  request: Readonly<WorkflowTransformExecutionRequest>,
): AntigravityGeneratorConfig {
  const advanced = request.transform.advanced;
  const director = request.transform.ai?.director;
  const image = request.transform.ai?.image;
  const options = record(advanced.options);
  return {
    ...config,
    model: stringOverride(director?.provider === 'antigravity' ? director.model : options.agentModel, config.model),
    approvalMode: stringOverride(director?.options.approvalMode, stringOverride(options.approvalMode, config.approvalMode)),
    imageModel: stringOverride(image?.model ?? advanced.model, config.imageModel),
    imageSize: stringOverride(image?.options.imageSize, stringOverride(options.imageSize, config.imageSize)),
    personGeneration: stringOverride(image?.options.personGeneration, stringOverride(options.personGeneration, config.personGeneration)),
    prominentPeople: stringOverride(image?.options.prominentPeople, stringOverride(options.prominentPeople, config.prominentPeople)),
    compressionQuality: numberOverride(image?.options.compressionQuality, numberOverride(options.compressionQuality, config.compressionQuality)),
    advancedJson: stringOverride(options.advancedJson, config.advancedJson),
    safetyFiltering: stringOverride(options.safetyFiltering, config.safetyFiltering),
    safetyHarassment: stringOverride(options.safetyHarassment, config.safetyHarassment),
    safetyHateSpeech: stringOverride(options.safetyHateSpeech, config.safetyHateSpeech),
    safetySexuallyExplicit: stringOverride(options.safetySexuallyExplicit, config.safetySexuallyExplicit),
    safetyDangerousContent: stringOverride(options.safetyDangerousContent, config.safetyDangerousContent),
    autonomyLevel: stringOverride(options.autonomyLevel, config.autonomyLevel),
    editChecksLevel: numberOverride(options.editChecksLevel, config.editChecksLevel),
    directorMode: director?.mode ?? config.directorMode,
    directorProvider: director?.provider ?? config.directorProvider,
    directorInvolvement: director?.involvement ?? config.directorInvolvement,
  };
}

function grokConfigForRequest(
  config: GrokGeneratorConfig,
  request: Readonly<WorkflowTransformExecutionRequest>,
): GrokGeneratorConfig {
  const advanced = request.transform.advanced;
  const image = request.transform.ai?.image;
  const options = record(advanced.options);
  return {
    ...config,
    imageModel: stringOverride(image?.model ?? advanced.model, config.imageModel),
    imageResolution: stringOverride(image?.options.imageResolution, stringOverride(options.imageResolution, config.imageResolution)),
    editChecksLevel: numberOverride(image?.options.editChecksLevel, numberOverride(options.editChecksLevel, config.editChecksLevel)),
  };
}

function providerSources(request: Readonly<WorkflowTransformExecutionRequest>) {
  return [
    ...(request.storyboard?.source ? [{
      name: request.storyboard.source.name,
      bytes: request.storyboard.source.bytes,
    }] : []),
    ...request.sources.map((source) => ({
      name: source.name,
      role: source.role,
      bytes: source.bytes,
    })),
  ];
}

async function editableWorkflowFrame(request: Readonly<WorkflowTransformExecutionRequest>): Promise<{
  bytes: Uint8Array;
  mask: Uint8Array;
  scalePercent: number;
}> {
  const bytes = request.storyboard?.source?.bytes ?? request.sources[0]?.bytes;
  if (!bytes?.length) {
    throw new WorkflowTransformExecutionError(
      'MISSING_ASSET',
      `${request.transform.capability} needs a connected source image or storyboard.`,
      'Connect a source image',
    );
  }
  const bitmap = await bytesToBitmap(bytes);
  try {
    const mask = document.createElement('canvas');
    mask.width = bitmap.width;
    mask.height = bitmap.height;
    const context = mask.getContext('2d');
    if (!context) throw new Error('Could not prepare the workflow edit mask.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, mask.width, mask.height);
    const scalePercent = Math.max(100, Math.round(Math.max(
      request.output.width / Math.max(1, bitmap.width),
      request.output.height / Math.max(1, bitmap.height),
    ) * 100));
    return { bytes, mask: await canvasToPngBytes(mask), scalePercent };
  } finally {
    bitmap.close();
  }
}

function editPrompt(request: Readonly<WorkflowTransformExecutionRequest>): string {
  if (request.transform.capability === 'remove-background') {
    return `${request.prompt}\n\nRemove the background cleanly and preserve the complete foreground subject with natural edges and transparency where supported.`;
  }
  if (request.transform.capability === 'relight') {
    return `${request.prompt}\n\nRelight the connected image as instructed while preserving subject identity, composition, and geometry.`;
  }
  return request.prompt;
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
    const effective = codexConfigForRequest({ ...config, runId }, request);
    return resultAsset(await executeObservedProvider(runId, context, async () => {
      if (request.transform.capability === 'generate') {
        return composeCodexWorkflow(effective, request.prompt, providerSources(request), request.output);
      }
      const frame = await editableWorkflowFrame(request);
      if (request.transform.capability === 'upscale') return upscaleCodexImage(effective, frame.bytes, frame.scalePercent);
      return generateCodexRetouchImage(effective, frame.bytes, frame.bytes, frame.mask, null, null, editPrompt(request), providerSources(request));
    }, dependencies));
  }, {
    capabilities: ['generate', 'edit', 'remove-background', 'relight', 'upscale'],
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
    describeRoles: (request) => {
      const effective = codexConfigForRequest(config, request);
      const directorProvider = effective.directorProvider ?? 'codex';
      return {
        director: effective.directorMode === 'skip' ? null : {
          id: directorProvider,
          model: request.transform.ai?.director?.model ?? (directorProvider === 'codex' ? effective.model ?? null : null),
          effectiveOptions: definedOptions([
            ['reasoningEffort', directorProvider === 'codex' ? effective.reasoningEffort : undefined],
            ['serviceTier', directorProvider === 'codex' ? effective.serviceTier : undefined],
          ]),
        },
        image: {
          id: 'codex', model: null,
          effectiveOptions: definedOptions([['imageQuality', effective.imageQuality], ['imageModeration', effective.imageModeration]]),
        },
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
    const effective = antigravityConfigForRequest({ ...config, runId }, request);
    return resultAsset(await executeObservedProvider(runId, context, async () => {
      if (request.transform.capability === 'generate') {
        return composeAntigravityWorkflow(effective, request.prompt, providerSources(request), request.output);
      }
      const frame = await editableWorkflowFrame(request);
      if (request.transform.capability === 'upscale') return upscaleAntigravityImage(effective, frame.bytes, frame.scalePercent);
      return generateAntigravityRetouchImage(effective, frame.bytes, frame.bytes, frame.mask, null, null, editPrompt(request), providerSources(request));
    }, dependencies));
  }, {
    capabilities: ['generate', 'edit', 'remove-background', 'relight', 'upscale'],
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
    describeRoles: (request) => {
      const effective = antigravityConfigForRequest(config, request);
      const directorProvider = effective.directorProvider ?? 'antigravity';
      return {
        director: effective.directorMode === 'skip' ? null : {
          id: directorProvider,
          model: request.transform.ai?.director?.model ?? (directorProvider === 'antigravity' ? effective.model ?? null : null),
          effectiveOptions: definedOptions([['approvalMode', directorProvider === 'antigravity' ? effective.approvalMode : undefined]]),
        },
        image: {
          id: 'antigravity', model: effective.imageModel ?? null,
          effectiveOptions: definedOptions([['imageSize', effective.imageSize], ['editChecksLevel', effective.editChecksLevel]]),
        },
      };
    },
  });
}

export function createGrokWorkflowTransformExecutor(
  config: GrokGeneratorConfig,
  dependencies: WorkflowCompositionAdapterDependencies = {},
): WorkflowNodeExecutor {
  return createWorkflowCompositionExecutor('grok', async (request, context) => {
    const runId = providerRunId(config.runId, context);
    const effective = grokConfigForRequest({ ...config, runId }, request);
    return resultAsset(await executeObservedProvider(runId, context, async () => {
      if (request.transform.capability === 'generate') {
        return composeGrokWorkflow(effective, request.prompt, providerSources(request), request.output);
      }
      const frame = await editableWorkflowFrame(request);
      if (request.transform.capability === 'upscale') return upscaleGrokImage(effective, frame.bytes, frame.scalePercent);
      return generateGrokRetouchImage(effective, frame.bytes, frame.bytes, frame.mask, null, null, editPrompt(request), providerSources(request));
    }, dependencies));
  }, {
    capabilities: ['generate', 'edit', 'remove-background', 'relight', 'upscale'],
    maxInputImages: 3,
    executor: { id: 'paintnode-grok-workflow', version: '1', requestSchemaVersion: '1' },
    describeRun: (request) => {
      const effective = grokConfigForRequest(config, request);
      return {
        id: 'grok',
        model: effective.imageModel ?? null,
        effectiveOptions: definedOptions([
          ['imageResolution', effective.imageResolution],
          ['editChecksLevel', effective.editChecksLevel],
        ]),
      };
    },
    describeRoles: (request) => {
      const effective = grokConfigForRequest(config, request);
      const directorProvider = effective.directorProvider ?? 'codex';
      return {
        director: effective.directorMode === 'skip' ? null : {
          id: directorProvider,
          model: request.transform.ai?.director?.model ?? effective.directorModel ?? null,
          effectiveOptions: definedOptions([['grokReasoningEffort', effective.directorReasoningEffort]]),
        },
        image: {
          id: 'grok', model: effective.imageModel ?? null,
          effectiveOptions: definedOptions([['imageResolution', effective.imageResolution], ['editChecksLevel', effective.editChecksLevel]]),
        },
      };
    },
  });
}
