const SAFE_PROVIDER_OPTION_KEYS = new Set([
  'reasoningEffort',
  'serviceTier',
  'imageQuality',
  'imageModeration',
  'autonomyLevel',
  'editChecksLevel',
  'approvalMode',
  'agentModel',
  'imageSize',
  'personGeneration',
  'prominentPeople',
  'compressionQuality',
  'safetyFiltering',
  'safetyHarassment',
  'safetyHateSpeech',
  'safetySexuallyExplicit',
  'safetyDangerousContent',
  'fixture',
]);

function safeOptionValue(value: unknown): boolean {
  return value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

export function safeWorkflowProviderOptions(value: unknown): Record<string, string | number | boolean | null> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Effective provider options must be a safe provider option object.');
  }
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SAFE_PROVIDER_OPTION_KEYS.has(key) || !safeOptionValue(item)) {
      throw new Error(`Effective provider option "${key}" is not a safe provider option.`);
    }
    result[key] = item as string | number | boolean | null;
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

export function sanitizeWorkflowFailure(failure: { code: string; message: string }): { code: string; message: string } {
  const code = failure.code.trim().slice(0, 80).replace(/[^A-Za-z0-9_.-]/g, '_') || 'EXECUTION_FAILED';
  const message = failure.message
    .replace(/\b(authorization)\s*:\s*(?:bearer\s+)?\S+/gi, '$1: [redacted]')
    .replace(/\b(token|api[_-]?key|auth|cookie)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/(?:\/(?:Users|private|tmp|var|home)\/[^\s,;]+)/g, '[path]')
    .replace(/\b[A-Za-z]:\\[^\s,;]+/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512) || 'Execution failed.';
  return { code, message };
}

export function safeWorkflowIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new Error(`${label} must be a safe identifier.`);
  }
  return value;
}

export function safeWorkflowModel(value: string | null, label: string): string | null {
  if (value === null) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value) || value.startsWith('/') || value.includes('..')) {
    throw new Error(`${label} must be a safe model identifier.`);
  }
  return value;
}
