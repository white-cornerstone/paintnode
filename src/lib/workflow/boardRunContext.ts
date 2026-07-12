import { workflowSha256Text } from './provenance';
import { safeWorkflowIdentifier } from './provenanceSafety';
import type { WorkflowAssetMaterial, WorkflowProjectAsset } from './transformExecutor';

export type WorkflowBoardRunIdGenerator = (nodeId: string, attempt: number) => string;
export type WorkflowBoardProjectMaterialReader = (
  projectPath: string,
  assetId: string,
) => Promise<WorkflowAssetMaterial>;

export interface WorkflowReviewRefreshIdentityInput {
  workflowId: string;
  workflowRevision: number;
  projectIdentity: string;
  executionOptionsIdentity: string;
  assetIdentity: readonly (readonly [string, string, boolean])[];
}

export function createWorkflowReviewRefreshIdentity(input: WorkflowReviewRefreshIdentityInput): string {
  return workflowSha256Text(JSON.stringify({
    workflowId: input.workflowId,
    workflowRevision: input.workflowRevision,
    projectIdentity: input.projectIdentity,
    executionOptionsIdentity: input.executionOptionsIdentity,
    assetIdentity: input.assetIdentity,
  }));
}

export class WorkflowReviewRefreshGate {
  #identity: string | null = null;

  shouldRefresh(identity: string): boolean {
    if (identity === this.#identity) return false;
    this.#identity = identity;
    return true;
  }

  reset(): void {
    this.#identity = null;
  }
}

export type WorkflowReviewVerificationStatus = 'idle' | 'verifying' | 'ready' | 'failed';

export interface WorkflowReviewVerificationState {
  status: WorkflowReviewVerificationStatus;
  identity: string | null;
  message: string;
  canRetry: boolean;
}

export function shouldRetryReviewVerificationAfterRefresh(
  before: Readonly<WorkflowReviewVerificationState>,
  after: Readonly<WorkflowReviewVerificationState>,
): boolean {
  return (after.status === 'failed' || after.status === 'idle')
    && after.identity === before.identity;
}

type WorkflowReviewVerificationRequest = {
  sequence: number;
  identity: string;
  verify: () => Promise<void>;
};

const DEFAULT_REVIEW_VERIFICATION_TIMEOUT_MS = 15_000;

function verificationFailureMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message.trim() : String(cause).trim();
  return detail
    ? `Review verification failed: ${detail}`
    : 'Review verification failed. Refresh workflow assets and retry.';
}

function verificationWasSuperseded(cause: unknown): boolean {
  return cause instanceof Error && /verification was superseded by newer execution options/i.test(cause.message);
}

export class WorkflowReviewVerificationCoordinator {
  #state: WorkflowReviewVerificationState = Object.freeze({
    status: 'idle', identity: null, message: '', canRetry: false,
  });
  #desired: WorkflowReviewVerificationRequest | null = null;
  #sequence = 0;
  #settledSequence = 0;
  #running = false;
  #settlement: Promise<void> = Promise.resolve();

  constructor(
    private readonly onState: (state: Readonly<WorkflowReviewVerificationState>) => void,
    private readonly timeoutMs = DEFAULT_REVIEW_VERIFICATION_TIMEOUT_MS,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Review verification timeout must be positive.');
    }
  }

  get state(): Readonly<WorkflowReviewVerificationState> {
    return this.#state;
  }

  request(identity: string, verify: () => Promise<void>, force = false): void {
    const normalizedIdentity = identity.trim();
    if (!normalizedIdentity) throw new Error('Review verification identity is required.');
    if (!force
      && this.#desired?.identity === normalizedIdentity
      && (this.#state.status === 'verifying' || this.#state.status === 'ready')) return;
    this.#desired = { sequence: ++this.#sequence, identity: normalizedIdentity, verify };
    this.publish({
      status: 'verifying', identity: normalizedIdentity,
      message: 'Verifying promoted review artifacts…', canRetry: false,
    });
    this.start();
  }

  retry(): void {
    const desired = this.#desired;
    if (!desired) return;
    this.request(desired.identity, desired.verify, true);
  }

  reset(): void {
    this.#desired = null;
    this.#settledSequence = ++this.#sequence;
    this.publish({ status: 'idle', identity: null, message: '', canRetry: false });
  }

  async settled(): Promise<void> {
    while (true) {
      const current = this.#settlement;
      await current;
      if (current === this.#settlement) return;
    }
  }

  private publish(state: WorkflowReviewVerificationState): void {
    this.#state = Object.freeze(state);
    this.onState(this.#state);
  }

  private start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#settlement = this.drain().finally(() => {
      this.#running = false;
      if (this.#desired && this.#desired.sequence !== this.#settledSequence) this.start();
    });
  }

  private async drain(): Promise<void> {
    while (this.#desired) {
      const request = this.#desired;
      try {
        await this.withTimeout(request.verify());
      } catch (cause) {
        if (this.#desired?.sequence !== request.sequence) continue;
        this.#settledSequence = request.sequence;
        if (verificationWasSuperseded(cause)) {
          this.publish({ status: 'idle', identity: request.identity, message: '', canRetry: false });
          return;
        }
        this.publish({
          status: 'failed', identity: request.identity,
          message: verificationFailureMessage(cause), canRetry: true,
        });
        return;
      }
      if (this.#desired?.sequence !== request.sequence) continue;
      this.#settledSequence = request.sequence;
      this.publish({
        status: 'ready', identity: request.identity,
        message: 'Promoted review artifacts are verified.', canRetry: false,
      });
      return;
    }
  }

  private async withTimeout(operation: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(
        'Verification timed out. Refresh workflow assets and retry.',
      )), this.timeoutMs);
    });
    try {
      await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export async function resolveWorkflowBoardProjectAsset(
  projectPath: string | null,
  asset: Readonly<WorkflowProjectAsset>,
  readProjectMaterial: WorkflowBoardProjectMaterialReader,
): Promise<WorkflowAssetMaterial> {
  if (!projectPath) throw new Error('No project is open.');
  return readProjectMaterial(projectPath, asset.id);
}

export function createWorkflowBoardRunIdGenerator(baseRunId: string): WorkflowBoardRunIdGenerator {
  const safeBase = safeWorkflowIdentifier(baseRunId, 'Board run ID').slice(0, 120);
  return (nodeId, attempt) => {
    const safeNodeId = safeWorkflowIdentifier(nodeId, 'Workflow node ID');
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Workflow run attempt must be positive.');
    const nodeDigest = workflowSha256Text(safeNodeId).slice('sha256:'.length, 'sha256:'.length + 20);
    return safeWorkflowIdentifier(`${safeBase}:${nodeDigest}:${attempt}`, 'Workflow run ID');
  };
}
