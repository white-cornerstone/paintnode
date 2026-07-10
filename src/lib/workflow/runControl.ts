import { safeWorkflowIdentifier } from './provenanceSafety';

export type WorkflowRunProgressStage =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'succeeded';

export interface WorkflowRunIdentity {
  workflowSessionId: string;
  workflowId: string;
  runId: string;
  nodeId: string;
}

export interface WorkflowRunProgressUpdate {
  stage: WorkflowRunProgressStage;
  message: string;
  completed?: number;
  total?: number;
}

export interface WorkflowRunProgressEvent extends WorkflowRunIdentity, WorkflowRunProgressUpdate {
  sequence: number;
}

export type WorkflowRunProgressListener = (event: Readonly<WorkflowRunProgressEvent>) => void;

export interface WorkflowCancellationResult {
  disposition: 'terminated' | 'detached';
  message: string;
}

export type WorkflowCancellationHandler = () => Promise<
  unknown
>;

const DETACHED_CANCELLATION: WorkflowCancellationResult = {
  disposition: 'detached',
  message: 'Provider termination was not confirmed; late results will be ignored.',
};
const PROGRESS_STAGES = new Set<WorkflowRunProgressStage>([
  'queued', 'running', 'cancelling', 'cancelled', 'failed', 'succeeded',
]);
const COMBINING_MARK = /^\p{M}$/u;
const TRAVERSAL_IDENTIFIER_BASE = /^[\p{L}\p{N}_.]$/u;

function containsUnsafeTraversalSegment(value: string): boolean {
  for (const match of value.matchAll(/\.\.(?:[\\/]|$)/gu)) {
    const precedingCharacters = Array.from(value.slice(0, match.index));
    let baseIndex = precedingCharacters.length - 1;
    while (baseIndex >= 0 && COMBINING_MARK.test(precedingCharacters[baseIndex])) {
      baseIndex -= 1;
    }
    if (baseIndex < 0 || !TRAVERSAL_IDENTIFIER_BASE.test(precedingCharacters[baseIndex])) {
      return true;
    }
  }
  return false;
}

export function sanitizeWorkflowProgressMessage(value: unknown): string {
  if (typeof value !== 'string') return 'Provider reported progress.';
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  let decoded = normalized;
  let decodingStable = false;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!/%[0-9a-f]{2}/i.test(decoded)) {
      decodingStable = true;
      break;
    }
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) {
        decodingStable = true;
        break;
      }
      decoded = next;
    } catch {
      break;
    }
  }
  if (!normalized || !decodingStable
    || /(?:bearer|access[_-]?token|api[_-]?key|authorization|cookie|secret)/i.test(decoded)
    || /(?:file:|\/Users\/|\/Volumes\/|\/private\/|\/tmp\/|\/home\/|\/var\/|~\/|[A-Za-z]:\\|\\\\)/i.test(decoded)
    || containsUnsafeTraversalSegment(decoded)) {
    return 'Provider reported progress.';
  }
  return normalized.slice(0, 500);
}

function validatedIdentity(identity: WorkflowRunIdentity): WorkflowRunIdentity {
  return {
    workflowSessionId: safeWorkflowIdentifier(identity.workflowSessionId, 'Workflow session ID'),
    workflowId: safeWorkflowIdentifier(identity.workflowId, 'Workflow ID'),
    runId: safeWorkflowIdentifier(identity.runId, 'Run ID'),
    nodeId: safeWorkflowIdentifier(identity.nodeId, 'Run node ID'),
  };
}

function identityKey(identity: WorkflowRunIdentity): string {
  const value = validatedIdentity(identity);
  return [value.workflowSessionId, value.workflowId, value.runId, value.nodeId].join('\u0000');
}

function validatedEvent(event: WorkflowRunProgressEvent): Readonly<WorkflowRunProgressEvent> {
  const identity = validatedIdentity(event);
  if (!PROGRESS_STAGES.has(event.stage)) throw new Error('Workflow progress stage is invalid.');
  const message = sanitizeWorkflowProgressMessage(event.message);
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    throw new Error('Workflow progress sequence must be a positive safe integer.');
  }
  if (event.completed !== undefined && (!Number.isSafeInteger(event.completed) || event.completed < 0)) {
    throw new Error('Workflow progress completed count must be a nonnegative safe integer.');
  }
  if (event.total !== undefined && (!Number.isSafeInteger(event.total) || event.total < 1)) {
    throw new Error('Workflow progress total must be a positive safe integer.');
  }
  if (event.completed !== undefined && event.total !== undefined && event.completed > event.total) {
    throw new Error('Workflow progress completed count cannot exceed its total.');
  }
  return Object.freeze({ ...event, ...identity, message });
}

export class WorkflowRunProgressRouter {
  readonly #listeners = new Map<string, Set<WorkflowRunProgressListener>>();
  readonly #closed = new Set<string>();
  readonly #lastSequence = new Map<string, number>();

  subscribe(identity: WorkflowRunIdentity, listener: WorkflowRunProgressListener): () => void {
    const key = identityKey(identity);
    if (this.#closed.has(key)) return () => undefined;
    const listeners = this.#listeners.get(key) ?? new Set<WorkflowRunProgressListener>();
    listeners.add(listener);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(key);
    };
  }

  publish(event: WorkflowRunProgressEvent): boolean {
    const safe = validatedEvent(event);
    const key = identityKey(safe);
    const listeners = this.#listeners.get(key);
    if (!listeners?.size) return false;
    if (safe.sequence <= (this.#lastSequence.get(key) ?? 0)) return false;
    this.#lastSequence.set(key, safe.sequence);
    for (const listener of [...listeners]) {
      try {
        listener(safe);
      } catch {
        // One observer cannot break routing or provider execution.
      }
    }
    return true;
  }

  close(identity: WorkflowRunIdentity): void {
    const key = identityKey(identity);
    this.#listeners.delete(key);
    this.#lastSequence.delete(key);
    this.#closed.add(key);
  }

  clear(): void {
    this.#listeners.clear();
    this.#closed.clear();
    this.#lastSequence.clear();
  }
}

export async function resolveWorkflowCancellation(
  cancel: WorkflowCancellationHandler | undefined,
  timeoutMs = 1_500,
): Promise<WorkflowCancellationResult> {
  if (!cancel) return { ...DETACHED_CANCELLATION };
  const boundedTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 10_000
    ? timeoutMs
    : 1_500;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<WorkflowCancellationResult>((resolve) => {
    timer = setTimeout(() => resolve({ ...DETACHED_CANCELLATION }), boundedTimeout);
  });
  const cancellation = Promise.resolve()
    .then(cancel)
    .then((result): WorkflowCancellationResult => (
      typeof result === 'object' && result !== null
      && (result as { disposition?: unknown }).disposition === 'terminated'
        ? { disposition: 'terminated', message: 'Provider termination was acknowledged.' }
        : { ...DETACHED_CANCELLATION }
    ))
    .catch(() => ({ ...DETACHED_CANCELLATION }));
  try {
    return await Promise.race([cancellation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class WorkflowRunCancelledError extends Error {
  constructor() {
    super('The workflow attempt was cancelled.');
    this.name = 'WorkflowRunCancelledError';
  }
}

export function throwIfWorkflowCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkflowRunCancelledError();
}

export function raceWorkflowCancellation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(new WorkflowRunCancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new WorkflowRunCancelledError()));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}
