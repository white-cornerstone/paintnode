type SafeProviderOption = string | number | boolean | null;
type OptionValidator = (value: unknown) => value is SafeProviderOption;

const enumValue = (...allowed: string[]): OptionValidator => (
  (value: unknown): value is string | null => value === null || (typeof value === 'string' && allowed.includes(value))
);
const integerRange = (minimum: number, maximum: number): OptionValidator => (
  (value: unknown): value is number | null => value === null
    || (typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum)
);

const SAFETY_THRESHOLDS = [
  'HARM_BLOCK_THRESHOLD_UNSPECIFIED', 'OFF', 'BLOCK_NONE', 'BLOCK_ONLY_HIGH',
  'BLOCK_MEDIUM_AND_ABOVE', 'BLOCK_LOW_AND_ABOVE',
];

function hasSecretOrPathBearingText(value: string): boolean {
  return /[\r\n\0]/.test(value)
    || /^\s*(?:\/|~|[A-Za-z]:\\|file:)/i.test(value)
    || /(?:^|[^A-Za-z])(bearer|access[_-]?token|api[_-]?key|authorization|cookie|secret)(?:[^A-Za-z]|$)/i.test(value)
    || value.includes('..');
}

function safeModelOption(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 200
    && !hasSecretOrPathBearingText(value));
}

const PROVIDER_OPTION_VALIDATORS: Record<string, OptionValidator> = {
  reasoningEffort: enumValue('none', 'minimal', 'low', 'medium', 'high', 'xhigh'),
  serviceTier: enumValue('default', 'fast'),
  imageQuality: enumValue('auto', 'low', 'medium', 'high'),
  quality: enumValue('auto', 'low', 'medium', 'high'),
  imageModeration: enumValue('auto', 'low'),
  autonomyLevel: enumValue('low', 'guided', 'open', 'unmanaged'),
  editChecksLevel: integerRange(0, 3),
  approvalMode: enumValue('default', 'skipPermissions'),
  agentModel: safeModelOption,
  imageSize: enumValue('auto', '1K', '2K', '4K'),
  personGeneration: enumValue('auto', 'ALLOW_NONE', 'ALLOW_ADULT', 'ALLOW_ALL'),
  prominentPeople: enumValue('auto', 'BLOCK_PROMINENT_PEOPLE'),
  compressionQuality: integerRange(0, 100),
  safetyFiltering: enumValue('default', 'lessRestrictive', 'moreRestrictive', 'custom'),
  safetyHarassment: enumValue(...SAFETY_THRESHOLDS),
  safetyHateSpeech: enumValue(...SAFETY_THRESHOLDS),
  safetySexuallyExplicit: enumValue(...SAFETY_THRESHOLDS),
  safetyDangerousContent: enumValue(...SAFETY_THRESHOLDS),
  fixture: enumValue('square'),
};

export function safeWorkflowProviderOptions(value: unknown): Record<string, SafeProviderOption> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Effective provider options must be a safe provider option object.');
  }
  const result: Record<string, SafeProviderOption> = {};
  for (const [key, item] of Object.entries(value)) {
    const validator = PROVIDER_OPTION_VALIDATORS[key];
    if (!validator?.(item)) {
      throw new Error(`Effective provider option "${key}" is not a safe provider option.`);
    }
    result[key] = item;
  }
  return result;
}

export function isProjectRelativeWorkflowReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || trimmed.startsWith('/') || trimmed.startsWith('~') || trimmed.includes('\\')) {
    return false;
  }
  const parts = trimmed.split('/');
  return !parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'));
}

export function requireProjectRelativeWorkflowReference(value: string, label: string): string {
  if (!isProjectRelativeWorkflowReference(value)) {
    throw new Error(`${label} must be a project-relative reference.`);
  }
  return value;
}

const CREATOR_SAFE_FAILURES: Record<string, string> = {
  EXECUTOR_ERROR: 'The provider could not complete this attempt.',
  PROVIDER_ERROR: 'The provider could not complete this attempt.',
  INVALID_EXECUTOR_RESULT: 'The generated result did not satisfy the output requirements.',
  ASSET_STORE_ERROR: 'The generated result could not be saved to the project.',
  CANCELLED: 'The attempt was cancelled.',
  INTERRUPTED: 'The attempt was interrupted before it completed.',
  STALE_RESULT: 'The workflow changed before this result could be applied.',
  EXECUTION_FAILED: 'The workflow attempt did not complete.',
};

export function sanitizeWorkflowFailure(failure: { code: string; message: string }): { code: string; message: string } {
  const code = failure.code.trim();
  if (Object.hasOwn(CREATOR_SAFE_FAILURES, code)) return { code, message: CREATOR_SAFE_FAILURES[code] };
  return { code: 'EXECUTION_FAILED', message: CREATOR_SAFE_FAILURES.EXECUTION_FAILED };
}

export function safeWorkflowIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value) || value.includes('..')) {
    throw new Error(`${label} must be a safe identifier.`);
  }
  return value;
}

export function safeWorkflowModel(value: string | null, label: string): string | null {
  if (value === null) return null;
  if (!safeModelOption(value)) throw new Error(`${label} must be a safe model identifier.`);
  return value;
}

interface WorkflowRunRecordSafetyShape {
  id: string;
  nodeId: string;
  status: string;
  attempt: number;
  sourceAssets: Array<{ nodeId: string; assetId: string; relativePath: string; contentHash: string; name: string; role: string }>;
  provider: { id: string; model: string | null; effectiveOptions: Record<string, unknown> };
  executor: { id: string; version: string; requestSchemaVersion: string };
  target: { nodeId: string; title: string; width: number; height: number };
  startedAt: number;
  finishedAt: number | null;
  outputs: Array<{ assetReferenceId: string; assetId: string; relativePath: string; contentHash: string; acceptedAt?: number }>;
  candidate?: { version: 1; branchGroupId: string; candidateId: string; ordinal: number; requestedCount: number; sourceNodeId: string; attempt: number };
  retryOfRunId?: string;
  failure?: { code: string; message: string };
  projectTaskId?: string;
  debugArtifactReference?: string;
}

function nonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateWorkflowRunRecordSafety(record: WorkflowRunRecordSafetyShape): void {
  safeWorkflowIdentifier(record.id, 'Run ID');
  safeWorkflowIdentifier(record.nodeId, 'Run node ID');
  if (!Number.isSafeInteger(record.attempt) || record.attempt < 1) throw new Error('Run attempt must start at least 1.');
  if (!nonnegativeSafeInteger(record.startedAt)) throw new Error('Run startedAt must be a nonnegative safe integer.');
  if (record.finishedAt !== null && (!nonnegativeSafeInteger(record.finishedAt) || record.finishedAt < record.startedAt)) {
    throw new Error('Run finishedAt must be a nonnegative safe integer after startedAt.');
  }
  safeWorkflowIdentifier(record.provider.id, 'Provider ID');
  safeWorkflowModel(record.provider.model, 'Provider model');
  safeWorkflowProviderOptions(record.provider.effectiveOptions);
  safeWorkflowIdentifier(record.executor.id, 'Executor ID');
  safeWorkflowIdentifier(record.executor.version, 'Executor version');
  safeWorkflowIdentifier(record.executor.requestSchemaVersion, 'Request schema version');
  safeWorkflowIdentifier(record.target.nodeId, 'Output target node ID');
  if (!record.target.title.trim()) throw new Error('Output target title must be non-empty.');
  if (!Number.isSafeInteger(record.target.width) || record.target.width < 1
    || !Number.isSafeInteger(record.target.height) || record.target.height < 1) {
    throw new Error('Run output dimensions must be positive safe integers.');
  }
  for (const source of record.sourceAssets) {
    safeWorkflowIdentifier(source.nodeId, 'Source node ID');
    safeWorkflowIdentifier(source.assetId, 'Source asset ID');
    safeWorkflowIdentifier(source.contentHash, 'Source content hash');
    requireProjectRelativeWorkflowReference(source.relativePath, 'Source asset path');
    if (!source.name.trim() || !source.role.trim()) throw new Error('Source name and role must be non-empty.');
  }
  for (const output of record.outputs) {
    safeWorkflowIdentifier(output.assetReferenceId, 'Output asset reference ID');
    safeWorkflowIdentifier(output.assetId, 'Output asset ID');
    safeWorkflowIdentifier(output.contentHash, 'Output content hash');
    requireProjectRelativeWorkflowReference(output.relativePath, 'Output asset path');
    if (output.acceptedAt !== undefined && (
      record.status !== 'succeeded' || !nonnegativeSafeInteger(output.acceptedAt)
      || output.acceptedAt < record.startedAt || record.finishedAt === null || output.acceptedAt > record.finishedAt
    )) throw new Error('Accepted output time must fall within a successful run.');
    if (record.candidate && output.acceptedAt !== undefined) {
      throw new Error('Unpromoted candidate outputs cannot be accepted.');
    }
  }
  if (new Set(record.outputs.map((output) => output.assetReferenceId)).size !== record.outputs.length) {
    throw new Error('Run outputs must have unique asset references.');
  }
  if (record.projectTaskId !== undefined) safeWorkflowIdentifier(record.projectTaskId, 'Project task ID');
  if (record.retryOfRunId !== undefined) safeWorkflowIdentifier(record.retryOfRunId, 'Retry run ID');
  if (record.candidate) {
    safeWorkflowIdentifier(record.candidate.branchGroupId, 'Candidate branch group ID');
    safeWorkflowIdentifier(record.candidate.candidateId, 'Candidate ID');
    safeWorkflowIdentifier(record.candidate.sourceNodeId, 'Candidate source node ID');
    if (record.candidate.sourceNodeId !== record.nodeId) throw new Error('Candidate source node must own the run.');
    if (!Number.isSafeInteger(record.candidate.requestedCount)
      || record.candidate.requestedCount < 2 || record.candidate.requestedCount > 6) {
      throw new Error('Candidate branch count must be between 2 and 6.');
    }
    if (!Number.isSafeInteger(record.candidate.ordinal)
      || record.candidate.ordinal < 1 || record.candidate.ordinal > record.candidate.requestedCount) {
      throw new Error('Candidate ordinal must identify a requested candidate.');
    }
    if (!Number.isSafeInteger(record.candidate.attempt) || record.candidate.attempt < 1) {
      throw new Error('Candidate attempt must start at 1.');
    }
  }
  if (record.debugArtifactReference !== undefined) {
    requireProjectRelativeWorkflowReference(record.debugArtifactReference, 'Debug artifact reference');
  }
  if (record.status === 'running' && (record.finishedAt !== null || record.failure || record.outputs.length > 0)) {
    throw new Error('Running records cannot be finished, failed, or produce outputs.');
  }
  if (record.status === 'succeeded' && (record.finishedAt === null || record.failure || record.outputs.length === 0)) {
    throw new Error('Succeeded records require outputs and no failure.');
  }
  if ((record.status === 'failed' || record.status === 'cancelled')
    && (record.finishedAt === null || !record.failure || record.outputs.length > 0)) {
    throw new Error('Failed and cancelled records require a failure and no outputs.');
  }
  if (!['running', 'succeeded', 'failed', 'cancelled'].includes(record.status)) throw new Error('Run status is not supported.');
  if (record.failure) {
    const safe = sanitizeWorkflowFailure(record.failure);
    if (safe.code !== record.failure.code || safe.message !== record.failure.message) {
      throw new Error('Run failure must use a creator-safe structured error.');
    }
  }
}
