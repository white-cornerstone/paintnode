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

  it('tracks layer metadata edits as pending workflow returns and autosave work', async () => {
    const { EditorStore } = await import('./editor.svelte');
    const store = new EditorStore();
    store.newDocument(64, 64, 'Workflow result', false);
    const session = store.activeDocument!;
    const layer = session.doc.activeLayer!;
    session.workflowReturnState = {
      label: 'Return to Workflow',
      pendingReturn: false,
      returnedRevisionId: null,
      recoveryStatus: 'source-png',
    };

    store.setLayerName(layer, '  Campaign hero  ');
    expect(layer.name).toBe('Campaign hero');
    expect(session.revision).toBe(1);
    expect(session.workflowReturnState.pendingReturn).toBe(true);
    expect(store.hasUnsavedChanges(session)).toBe(true);
    expect(store.needsAutosave(session)).toBe(true);

    store.markAutosaved(session.id, 'autosave/workflow-result.ora');
    expect(store.needsAutosave(session)).toBe(false);
    expect(store.hasUnsavedChanges(session)).toBe(true);

    store.markWorkflowReturned(session.id, 'editor-revision-name', session.revision);
    expect(session.workflowReturnState.pendingReturn).toBe(false);
    const returnedRevision = session.revision;

    store.setLayerOpacity(layer, 0.96);
    store.setLayerBlendMode(layer, 'multiply');
    expect(layer.opacity).toBe(0.96);
    expect(layer.blendMode).toBe('multiply');
    expect(session.revision).toBe(returnedRevision + 2);
    expect(session.workflowReturnState.pendingReturn).toBe(true);
    expect(store.needsAutosave(session)).toBe(true);
    expect(session.doc.clone().activeLayer).toMatchObject({
      name: 'Campaign hero', opacity: 0.96, blendMode: 'multiply',
    });

    store.markWorkflowReturned(session.id, 'editor-revision-stale', returnedRevision);
    expect(session.workflowReturnState.pendingReturn).toBe(true);
  });

  it('keeps no-op metadata assignments clean while ordinary documents become dirty', async () => {
    const { EditorStore } = await import('./editor.svelte');
    const store = new EditorStore();
    store.newDocument(64, 64, 'Ordinary document', false);
    const session = store.activeDocument!;
    const layer = session.doc.activeLayer!;
    store.markSaved('documents/ordinary.ora');
    const baselineRevision = session.revision;

    store.setLayerName(layer, `  ${layer.name}  `);
    store.setLayerName(layer, '   ');
    store.setLayerOpacity(layer, layer.opacity);
    store.setLayerBlendMode(layer, layer.blendMode);
    expect(session.revision).toBe(baselineRevision);
    expect(store.hasUnsavedChanges(session)).toBe(false);
    expect(store.needsAutosave(session)).toBe(false);

    store.setLayerName(layer, 'Retitled layer');
    expect(session.revision).toBe(baselineRevision + 1);
    expect(store.hasUnsavedChanges(session)).toBe(true);
    expect(store.needsAutosave(session)).toBe(true);

    store.markAutosaved(session.id, 'autosave/ordinary.ora');
    expect(store.needsAutosave(session)).toBe(false);
    expect(store.hasUnsavedChanges(session)).toBe(true);

    store.markSaved('documents/ordinary.ora');
    expect(store.hasUnsavedChanges(session)).toBe(false);
  });
});
