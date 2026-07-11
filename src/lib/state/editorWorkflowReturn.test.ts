import { beforeAll, describe, expect, it } from 'vitest';

class FakeCanvas {
  width = 1;
  height = 1;
  readonly context = new FakeContext();

  getContext(): FakeContext {
    return this.context;
  }
}

class FakeContext {
  fillStyle = '';
  imageSmoothingEnabled = false;
  imageSmoothingQuality: ImageSmoothingQuality = 'low';
  drawImage(): void {}
  fillRect(): void {}
  clearRect(): void {}
  save(): void {}
  restore(): void {}
  translate(): void {}
  rotate(): void {}
  scale(): void {}
}

beforeAll(() => {
  Object.defineProperty(globalThis, '$state', {
    value: <T>(value: T) => value,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'document', {
    value: { createElement: () => new FakeCanvas() },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    configurable: true,
  });
});

describe('EditorStore workflow return baseline', () => {
  it('tracks Return to Workflow independently from ordinary Save', async () => {
    const { EditorStore } = await import('./editor.svelte');
    const store = new EditorStore();
    store.newDocument(64, 64, 'Workflow result', false);
    const session = store.activeDocument!;
    session.workflowReturnState = {
      label: 'Return to Workflow',
      pendingReturn: false,
      returnedRevisionId: null,
      recoveryStatus: 'source-png',
    };

    store.resizeCanvas(80, 64, 'center', { kind: 'transparent' });
    expect(store.hasUnsavedChanges(session)).toBe(true);

    store.markSaved('documents/workflow-result.ora');
    expect(session.workflowReturnState.pendingReturn).toBe(true);
    expect(store.hasUnsavedChanges(session)).toBe(true);

    store.markWorkflowReturned(session.id, 'editor-revision-1', session.revision);
    expect(session.workflowReturnState).toEqual({
      label: 'Return to Workflow',
      pendingReturn: false,
      returnedRevisionId: 'editor-revision-1',
      recoveryStatus: 'source-png',
    });
    expect(store.hasUnsavedChanges(session)).toBe(false);

    const returningRevision = session.revision;
    store.resizeCanvas(96, 64, 'center', { kind: 'transparent' });
    store.markWorkflowReturned(session.id, 'editor-revision-2', returningRevision);
    expect(session.workflowReturnState.pendingReturn).toBe(true);
    expect(session.workflowReturnState.returnedRevisionId).toBe('editor-revision-2');
  });
});
