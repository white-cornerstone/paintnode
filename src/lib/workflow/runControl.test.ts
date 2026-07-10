import { describe, expect, it, vi } from 'vitest';
import {
  resolveWorkflowCancellation,
  sanitizeWorkflowProgressMessage,
  WorkflowRunProgressRouter,
  type WorkflowRunIdentity,
  type WorkflowRunProgressEvent,
} from './runControl';

const identity = (overrides: Partial<WorkflowRunIdentity> = {}): WorkflowRunIdentity => ({
  workflowSessionId: 'session-1',
  workflowId: 'workflow-1',
  runId: 'run-1',
  nodeId: 'transform-1',
  ...overrides,
});

const event = (
  runIdentity: WorkflowRunIdentity,
  message: string,
  sequence = 1,
): WorkflowRunProgressEvent => ({
  ...runIdentity,
  stage: 'running',
  message,
  sequence,
});

const asciiPunctuation = Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 33))
  .filter((character) => !/[A-Za-z0-9]/.test(character));
const traversalBoundaryPunctuation = asciiPunctuation
  .filter((character) => character !== '.' && character !== '_');

describe('workflow run control', () => {
  it('routes concurrent progress only to the exact workflow session, workflow, run, and node', () => {
    const router = new WorkflowRunProgressRouter();
    const first = identity();
    const otherSession = identity({ workflowSessionId: 'session-2' });
    const otherWorkflow = identity({ workflowId: 'workflow-2' });
    const otherRun = identity({ runId: 'run-2' });
    const otherNode = identity({ nodeId: 'transform-2' });
    const received: string[] = [];
    router.subscribe(first, (progress) => received.push(progress.message));

    expect(router.publish(event(otherSession, 'other session'))).toBe(false);
    expect(router.publish(event(otherWorkflow, 'other workflow'))).toBe(false);
    expect(router.publish(event(otherRun, 'other run'))).toBe(false);
    expect(router.publish(event(otherNode, 'other node'))).toBe(false);
    expect(router.publish(event(first, 'exact run'))).toBe(true);
    expect(received).toEqual(['exact run']);
  });

  it('closes an identity synchronously so late progress is ignored', () => {
    const router = new WorkflowRunProgressRouter();
    const runIdentity = identity();
    const listener = vi.fn();
    router.subscribe(runIdentity, listener);
    router.close(runIdentity);

    expect(router.publish(event(runIdentity, 'late completion'))).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects duplicate or out-of-order progress and isolates throwing listeners', () => {
    const router = new WorkflowRunProgressRouter();
    const runIdentity = identity();
    const received: string[] = [];
    router.subscribe(runIdentity, () => { throw new Error('observer failed'); });
    router.subscribe(runIdentity, (progress) => received.push(progress.message));

    expect(router.publish(event(runIdentity, 'first', 2))).toBe(true);
    expect(router.publish(event(runIdentity, 'duplicate', 2))).toBe(false);
    expect(router.publish(event(runIdentity, 'older', 1))).toBe(false);
    expect(router.publish(event(runIdentity, 'Authorization: Bearer secret at /tmp/raw.jsonl', 3))).toBe(true);
    expect(received).toEqual(['first', 'Provider reported progress.']);
  });

  it('hard-bounds a stuck or failed provider cancellation as a safe detach', async () => {
    await expect(resolveWorkflowCancellation(
      () => new Promise(() => undefined),
      5,
    )).resolves.toEqual({
      disposition: 'detached',
      message: 'Provider termination was not confirmed; late results will be ignored.',
    });
    await expect(resolveWorkflowCancellation(
      async () => { throw new Error('private provider failure'); },
      50,
    )).resolves.toEqual({
      disposition: 'detached',
      message: 'Provider termination was not confirmed; late results will be ignored.',
    });
    await expect(resolveWorkflowCancellation(async () => undefined, 50)).resolves.toMatchObject({
      disposition: 'detached',
    });
    await expect(resolveWorkflowCancellation(async () => ({ disposition: 'unexpected' } as never), 50))
      .resolves.toMatchObject({ disposition: 'detached' });
    await expect(resolveWorkflowCancellation(async () => ({ disposition: 'terminated' }), 50))
      .resolves.toMatchObject({ disposition: 'terminated' });
  });

  it.each([
    '/home/person/private.png',
    '/var/folders/job/output.png',
    'file:///Users/person/result.png',
    String.raw`\\server\share\secret.png`,
    '../private/result.png',
    '%2e%2e%2fprivate%2fresult.png',
    '%252e%252e%252fprivate%252fresult.png',
    '%25252e%25252e%25252fprivate%25252fresult.png',
    '%252525252e%252525252e%252525252fprivate%252525252fresult.png',
    'path=/tmp/private/result.png',
    'result:(/home/person/private.png)',
    'path=../workspace/result.png',
    'result:(../workspace/result.png)',
    'path=%2e%2e%2fworkspace%2fresult.png',
    'path=%252e%252e%252fworkspace%252fresult.png',
    String.raw`path=..\workspace\result.png`,
    'Authorization%3A%20Bearer%20private-token',
    '%41%75%74%68%6f%72%69%7a%61%74%69%6f%6e%253A%2520Bearer%2520private-token',
  ])('redacts unsafe provider progress paths: %s', (message) => {
    expect(sanitizeWorkflowProgressMessage(`Writing ${message}`)).toBe('Provider reported progress.');
  });

  it.each(traversalBoundaryPunctuation.map((character) => [JSON.stringify(character), character]))(
    'redacts traversal after ASCII punctuation %s',
    (_label, character) => {
      expect(sanitizeWorkflowProgressMessage(`Writing ${character}../workspace/result.png`))
        .toBe('Provider reported progress.');
    },
  );

  it.each([
    'Writing !\u0301../workspace/result.png',
    '\u0301../workspace/result.png',
    'Writing !%CC%81%2e%2e%2fworkspace%2fresult.png',
    '%CC%81%2e%2e%2fworkspace%2fresult.png',
    'Writing !%25CC%2581%252e%252e%252fworkspace%252fresult.png',
    '%25CC%2581%252e%252e%252fworkspace%252fresult.png',
  ])('redacts traversal when combining marks lack an identifier base: %s', (message) => {
    expect(sanitizeWorkflowProgressMessage(message)).toBe('Provider reported progress.');
  });

  it('preserves ordinary percentage progress without treating it as malformed encoding', () => {
    expect(sanitizeWorkflowProgressMessage('Rendered 50% complete')).toBe('Rendered 50% complete');
  });

  it.each([
    'Planning... 3 variants',
    'Result: (draft preview)',
    'Progress path=workspace/result.png',
    'Rendered 75% complete; checking details...',
    'Keeping a../workspace token unchanged',
    'Keeping é../workspace token unchanged',
    'Keeping e\u0301../workspace token unchanged',
    'Keeping 1\u0301../workspace token unchanged',
    'Keeping _\u0301../workspace token unchanged',
    'Keeping .\u0301../workspace token unchanged',
    'Keeping 你../workspace token unchanged',
    'Keeping ٣../workspace token unchanged',
    'Keeping e%CC%81%2e%2e%2fworkspace token unchanged',
    'Keeping 1%CC%81%2e%2e%2fworkspace token unchanged',
    'Keeping e%25CC%2581%252e%252e%252fworkspace token unchanged',
    'Keeping 1%25CC%2581%252e%252e%252fworkspace token unchanged',
    'Ellipsis .../workspace is descriptive',
    'Dot boundary ....\\workspace is descriptive',
    'Underscore _../workspace is an identifier',
  ])('preserves benign punctuation progress: %s', (message) => {
    expect(sanitizeWorkflowProgressMessage(message)).toBe(message);
  });
});
