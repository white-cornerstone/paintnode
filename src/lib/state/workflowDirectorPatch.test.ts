import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowStore } from './workflow.svelte';
import { project } from './project.svelte';
import {
  createWorkflowCompositionExecutor,
  deriveWorkflowNodeRunState,
  WorkflowGraphDomain,
  workflowSha256Bytes,
  type WorkflowDirectorPatchV1,
  type WorkflowGraphV2,
  type WorkflowRunRecordV1,
} from '../workflow';
import type { ProjectAsset, ProjectState } from '../integrations/desktop';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const virtualProject: ProjectState = {
  path: '/virtual/project',
  name: 'Virtual project',
  documentPath: '/virtual/project/Documents',
  assets: [],
  files: [],
};

let previousProject: ProjectState | null;

beforeEach(() => {
  previousProject = project.current;
  project.current = virtualProject;
});

afterEach(() => {
  project.current = previousProject;
  vi.restoreAllMocks();
});

const productAsset = {
  id: 'product-asset',
  kind: 'imported',
  name: 'Product.png',
  relativePath: 'assets/product.png',
  createdAt: 1,
  exists: true,
  width: 1200,
  height: 1200,
  mime: 'image/png',
} satisfies ProjectAsset;

function fullOutputRun(graph: WorkflowGraphV2): WorkflowRunRecordV1 {
  const output = graph.nodes.find((node) => node.id === 'output-square')!;
  return {
    recordVersion: 1,
    id: 'run-output-square',
    nodeId: output.id,
    status: 'succeeded',
    attempt: 1,
    workflowRevision: 'sha256:workflow-before-patch',
    nodeRevision: 'sha256:output-before-patch',
    materialKey: 'workflow-cache-v1:output-before-patch',
    sourceAssets: [],
    prompt: {
      brief: 'Launch the product.',
      artDirection: 'Premium studio lighting.',
      instructions: 'Generate the square output.',
      constraints: ['Keep the product identity.'],
      effectivePromptHash: 'sha256:prompt-before-patch',
    },
    provider: { id: 'qa-fake', model: null, effectiveOptions: {} },
    executor: { id: 'qa-fake', version: '1', requestSchemaVersion: '1' },
    target: { nodeId: output.id, title: output.title, width: 1024, height: 1024 },
    startedAt: 1,
    finishedAt: 2,
    outputs: [{
      assetReferenceId: 'accepted-square-reference',
      assetId: 'accepted-square-asset',
      relativePath: 'assets/generated/accepted-square.png',
      contentHash: 'sha256:accepted-square',
      acceptedAt: 2,
    }],
  };
}

function storeWithAcceptedHistory(): WorkflowStore {
  const seed = new WorkflowStore();
  seed.newFromTemplate('campaign-composer', 'Campaign with history');
  const graph = structuredClone(seed.serialize());
  const output = graph.nodes.find((node) => node.id === 'output-square')!;
  const run = fullOutputRun(graph);
  output.runRecordIds = [run.id];
  output.config = {
    ...output.config,
    assetReferenceId: 'accepted-square-reference',
    outputAssetId: 'accepted-square-asset',
    outputRelativePath: 'assets/generated/accepted-square.png',
  };
  graph.assetReferences = [{
    id: 'accepted-square-reference',
    role: 'output',
    assetId: 'accepted-square-asset',
    relativePath: 'assets/generated/accepted-square.png',
  }];
  graph.runRecords = [run];

  const store = new WorkflowStore();
  store.openFromBytes(
    new TextEncoder().encode(JSON.stringify(graph)),
    'workflows/campaign-with-history.cxflow.json',
    graph.metadata.name,
  );
  return store;
}

function configureTransformPatch(store: WorkflowStore): WorkflowDirectorPatchV1 {
  return {
    version: 1,
    sourceGraphRevision: {
      graphId: store.graphSnapshot().id,
      revision: store.graphRevision,
    },
    summary: 'Warm the generated square while preserving accepted history.',
    operations: [{
      op: 'configure-node',
      nodeId: 'transform-generate-square',
      changes: { instructions: 'Use warmer amber light.' },
    }],
  };
}

function bytes(store: WorkflowStore): string {
  return new TextDecoder().decode(store.toBytes());
}

describe('WorkflowStore Director patch review lifecycle', () => {
  it('creates a review-only pending preview without graph, history, revision, dirty, or execution mutation', () => {
    const store = storeWithAcceptedHistory();
    const beforeGraph = store.graphSnapshot();
    const beforeBytes = bytes(store);
    const beforeRevision = store.graphRevision;
    const beforeRev = store.rev;
    const beforeDirty = store.dirty;
    const beforeExecution = store.transformExecution('transform-generate-square');

    const result = store.createDirectorPatchProposal(configureTransformPatch(store));

    expect(result.issues).toEqual([]);
    expect(store.pendingDirectorPatchProposal).toBe(result.proposal);
    expect(store.graphSnapshot()).toBe(beforeGraph);
    expect(bytes(store)).toBe(beforeBytes);
    expect(store.graphRevision).toBe(beforeRevision);
    expect(store.rev).toBe(beforeRev);
    expect(store.dirty).toBe(beforeDirty);
    expect(store.transformExecution('transform-generate-square')).toEqual(beforeExecution);
  });

  it('rejects a stale source revision during preview creation without installing pending state', () => {
    const store = storeWithAcceptedHistory();
    const response = configureTransformPatch(store);
    response.sourceGraphRevision = {
      ...response.sourceGraphRevision,
      revision: response.sourceGraphRevision.revision + 1,
    };
    const beforeBytes = bytes(store);

    const result = store.createDirectorPatchProposal(response);

    expect(result.proposal).toBeNull();
    expect(result.issues).toEqual([expect.objectContaining({ code: 'STALE_GRAPH_REVISION' })]);
    expect(store.pendingDirectorPatchProposal).toBeNull();
    expect(bytes(store)).toBe(beforeBytes);
    expect(store.dirty).toBe(false);
  });

  it('rejects a pending proposal with zero graph, history, dirty, or undo mutation', () => {
    const store = storeWithAcceptedHistory();
    const beforeGraph = store.graphSnapshot();
    const beforeBytes = bytes(store);
    const beforeRevision = store.graphRevision;
    const beforeRev = store.rev;
    const beforeDirty = store.dirty;
    store.createDirectorPatchProposal(configureTransformPatch(store));

    store.rejectDirectorPatchProposal();

    expect(store.pendingDirectorPatchProposal).toBeNull();
    expect(store.graphSnapshot()).toBe(beforeGraph);
    expect(bytes(store)).toBe(beforeBytes);
    expect(store.graphRevision).toBe(beforeRevision);
    expect(store.rev).toBe(beforeRev);
    expect(store.dirty).toBe(beforeDirty);
    expect(store.undoDirectorPatch()).toBe(false);
    expect(store.redoDirectorPatch()).toBe(false);
  });

  it('accepts once as one dirty transaction and preserves immutable provenance bytes', () => {
    const store = storeWithAcceptedHistory();
    const beforeRevision = store.graphRevision;
    const beforeRev = store.rev;
    const provenance = JSON.stringify({
      assetReferences: store.graphSnapshot().assetReferences,
      runRecords: store.graphSnapshot().runRecords,
      runRecordIds: store.graphSnapshot().nodes.map((node) => [node.id, node.runRecordIds]),
    });
    const result = store.createDirectorPatchProposal(configureTransformPatch(store));

    const accepted = store.acceptDirectorPatchProposal();

    expect(accepted).toBe(result.proposal);
    expect(store.pendingDirectorPatchProposal).toBeNull();
    expect(store.graphSnapshot()).toEqual(result.proposal?.graph);
    expect(store.graphRevision).toBe(beforeRevision + 1);
    expect(store.rev).toBe(beforeRev + 1);
    expect(store.dirty).toBe(true);
    expect(JSON.stringify({
      assetReferences: store.graphSnapshot().assetReferences,
      runRecords: store.graphSnapshot().runRecords,
      runRecordIds: store.graphSnapshot().nodes.map((node) => [node.id, node.runRecordIds]),
    })).toBe(provenance);
    expect(deriveWorkflowNodeRunState(
      store.graphSnapshot(),
      'output-square',
      'workflow-cache-v1:output-after-upstream-change',
    ).state).toBe('stale');
  });

  it('accepts adding an unlinked creator node without treating empty run links as history', () => {
    const store = storeWithAcceptedHistory();
    const provenance = JSON.stringify(store.graphSnapshot().runRecords);
    const response: WorkflowDirectorPatchV1 = {
      version: 1,
      sourceGraphRevision: {
        graphId: store.graphSnapshot().id,
        revision: store.graphRevision,
      },
      summary: 'Add a story output for later connection.',
      operations: [{
        op: 'add-node',
        node: {
          id: 'output-story',
          type: 'output',
          title: 'Story 9:16',
          position: { x: 1600, y: 800 },
          config: { finalWidth: 1080, finalHeight: 1920 },
        },
      }],
    };
    const result = store.createDirectorPatchProposal(response);

    expect(result.issues).toEqual([]);
    expect(() => store.acceptDirectorPatchProposal()).not.toThrow();
    expect(store.graphSnapshot().nodes.some((node) => node.id === 'output-story')).toBe(true);
    expect(JSON.stringify(store.graphSnapshot().runRecords)).toBe(provenance);
  });

  it('undoes and redoes exact graph, content revision, dirty, and provenance bytes', () => {
    const store = storeWithAcceptedHistory();
    const before = {
      bytes: bytes(store),
      graphRevision: store.graphRevision,
      rev: store.rev,
      savedRev: store.savedRev,
      provenance: JSON.stringify(store.graphSnapshot().runRecords),
    };
    store.createDirectorPatchProposal(configureTransformPatch(store));
    store.acceptDirectorPatchProposal();
    const after = {
      bytes: bytes(store),
      graphRevision: store.graphRevision,
      rev: store.rev,
      savedRev: store.savedRev,
      provenance: JSON.stringify(store.graphSnapshot().runRecords),
    };

    expect(store.undoDirectorPatch()).toBe(true);
    expect(bytes(store)).toBe(before.bytes);
    expect(store.graphRevision).toBe(before.graphRevision);
    expect(store.rev).toBe(before.rev);
    expect(store.savedRev).toBe(before.savedRev);
    expect(store.dirty).toBe(false);
    expect(JSON.stringify(store.graphSnapshot().runRecords)).toBe(before.provenance);
    expect(store.undoDirectorPatch()).toBe(false);

    expect(store.redoDirectorPatch()).toBe(true);
    expect(bytes(store)).toBe(after.bytes);
    expect(store.graphRevision).toBe(after.graphRevision);
    expect(store.rev).toBe(after.rev);
    expect(store.savedRev).toBe(after.savedRev);
    expect(store.dirty).toBe(true);
    expect(JSON.stringify(store.graphSnapshot().runRecords)).toBe(after.provenance);
    expect(store.redoDirectorPatch()).toBe(false);
  });

  it('keeps a later accepted patch dirty when a pre-accept save completes', async () => {
    const store = storeWithAcceptedHistory();
    store.createDirectorPatchProposal(configureTransformPatch(store));
    const beforeBytes = bytes(store);
    const write = deferred<string>();
    let submittedBytes = '';
    vi.spyOn(project, 'saveDocumentToPath').mockImplementation(async (_path, value) => {
      submittedBytes = new TextDecoder().decode(value);
      return write.promise;
    });

    const saving = store.save();
    store.acceptDirectorPatchProposal();
    const acceptedBytes = bytes(store);
    expect(store.dirty).toBe(true);

    write.resolve('workflows/campaign-with-history.cxflow.json');
    await expect(saving).resolves.toBe('workflows/campaign-with-history.cxflow.json');

    expect(submittedBytes).toBe(beforeBytes);
    expect(bytes(store)).toBe(acceptedBytes);
    expect(store.dirty).toBe(true);
    expect(store.undoDirectorPatch()).toBe(true);
    expect(bytes(store)).toBe(beforeBytes);
    expect(store.dirty).toBe(false);
    expect(store.redoDirectorPatch()).toBe(true);
    expect(bytes(store)).toBe(acceptedBytes);
    expect(store.dirty).toBe(true);
  });

  it('marks only the submitted accepted snapshot clean when save resolves after undo', async () => {
    const store = storeWithAcceptedHistory();
    store.createDirectorPatchProposal(configureTransformPatch(store));
    store.acceptDirectorPatchProposal();
    const acceptedBytes = bytes(store);
    const acceptedRevision = store.rev;
    const write = deferred<string>();
    let submittedBytes = '';
    vi.spyOn(project, 'saveDocumentToPath').mockImplementation(async (_path, value) => {
      submittedBytes = new TextDecoder().decode(value);
      return write.promise;
    });

    const saving = store.save();
    expect(store.undoDirectorPatch()).toBe(true);
    const undoneBytes = bytes(store);
    expect(store.dirty).toBe(false);

    write.resolve('workflows/campaign-with-history.cxflow.json');
    await saving;

    expect(submittedBytes).toBe(acceptedBytes);
    expect(bytes(store)).toBe(undoneBytes);
    expect(store.savedRev).toBe(acceptedRevision);
    expect(store.dirty).toBe(true);
    expect(store.redoDirectorPatch()).toBe(true);
    expect(bytes(store)).toBe(acceptedBytes);
    expect(store.dirty).toBe(false);
  });

  it('reconciles overlapping saves in completion order using each submitted snapshot', async () => {
    const store = storeWithAcceptedHistory();
    store.createDirectorPatchProposal(configureTransformPatch(store));
    const beforeBytes = bytes(store);
    const writes: Array<Deferred<string> & { bytes: string }> = [];
    vi.spyOn(project, 'saveDocumentToPath').mockImplementation(async (_path, value) => {
      const write = { ...deferred<string>(), bytes: new TextDecoder().decode(value) };
      writes.push(write);
      return write.promise;
    });

    const beforeSave = store.save();
    store.acceptDirectorPatchProposal();
    const acceptedBytes = bytes(store);
    const acceptedSave = store.save();
    expect(writes.map((write) => write.bytes)).toEqual([beforeBytes, acceptedBytes]);

    writes[1].resolve('workflows/campaign-with-history.cxflow.json');
    await acceptedSave;
    expect(store.dirty).toBe(false);

    writes[0].resolve('workflows/campaign-with-history.cxflow.json');
    await beforeSave;
    expect(store.dirty).toBe(true);
    expect(store.undoDirectorPatch()).toBe(true);
    expect(store.dirty).toBe(false);
    expect(store.redoDirectorPatch()).toBe(true);
    expect(store.dirty).toBe(true);
  });

  it.each(['original-first', 'save-as-first'] as const)(
    'keeps Save As path ownership when overlapping original and new-path writes finish %s',
    async (completionOrder) => {
      const store = storeWithAcceptedHistory();
      store.setBriefObjective('brief', 'Edited before the original-path Save.');
      const baselineRevision = store.savedRev;
      const originalWrite = deferred<string>();
      const saveAsWrite = deferred<string | null>();
      vi.spyOn(project, 'saveDocumentToPath').mockReturnValue(originalWrite.promise);
      vi.spyOn(project, 'saveDocument').mockReturnValue(saveAsWrite.promise);

      const originalSave = store.save();
      const saveAs = store.saveAs('Renamed Campaign');
      expect(store.savedPath).toBe('workflows/campaign-with-history.cxflow.json');
      expect(store.dirty).toBe(true);

      if (completionOrder === 'original-first') {
        originalWrite.resolve('workflows/campaign-with-history.cxflow.json');
        await originalSave;
        expect(store.savedPath).toBe('workflows/campaign-with-history.cxflow.json');
        expect(store.savedRev).toBe(baselineRevision);
        expect(store.dirty).toBe(true);
        saveAsWrite.resolve('workflows/renamed-campaign.cxflow.json');
        await saveAs;
      } else {
        saveAsWrite.resolve('workflows/renamed-campaign.cxflow.json');
        await saveAs;
        originalWrite.resolve('workflows/campaign-with-history.cxflow.json');
        await originalSave;
      }

      expect(store.name).toBe('Renamed Campaign');
      expect(store.savedPath).toBe('workflows/renamed-campaign.cxflow.json');
      expect(store.dirty).toBe(false);
    },
  );

  it.each(['first-first', 'second-first'] as const)(
    'keeps the second Save As path when two new-path writes finish %s',
    async (completionOrder) => {
      const store = storeWithAcceptedHistory();
      const writes = [deferred<string | null>(), deferred<string | null>()];
      vi.spyOn(project, 'saveDocument')
        .mockReturnValueOnce(writes[0].promise)
        .mockReturnValueOnce(writes[1].promise);

      const firstSaveAs = store.saveAs('First Campaign');
      const secondSaveAs = store.saveAs('Second Campaign');

      if (completionOrder === 'first-first') {
        writes[0].resolve('workflows/first-campaign.cxflow.json');
        await firstSaveAs;
        expect(store.savedPath).toBe('workflows/campaign-with-history.cxflow.json');
        expect(store.dirty).toBe(true);
        writes[1].resolve('workflows/second-campaign.cxflow.json');
        await secondSaveAs;
      } else {
        writes[1].resolve('workflows/second-campaign.cxflow.json');
        await secondSaveAs;
        writes[0].resolve('workflows/first-campaign.cxflow.json');
        await firstSaveAs;
      }

      expect(store.name).toBe('Second Campaign');
      expect(store.savedPath).toBe('workflows/second-campaign.cxflow.json');
      expect(store.dirty).toBe(false);
    },
  );

  it.each(['rejects', 'is cancelled'] as const)(
    'does not resurrect an older path baseline when the newer Save As intent %s',
    async (failureMode) => {
      const store = storeWithAcceptedHistory();
      store.setBriefObjective('brief', 'An edit submitted to the original path.');
      const baselineRevision = store.savedRev;
      const originalWrite = deferred<string>();
      const saveAsWrite = deferred<string | null>();
      vi.spyOn(project, 'saveDocumentToPath').mockReturnValue(originalWrite.promise);
      vi.spyOn(project, 'saveDocument').mockReturnValue(saveAsWrite.promise);

      const originalSave = store.save();
      const saveAs = store.saveAs('Failed New Path');
      if (failureMode === 'rejects') {
        saveAsWrite.reject(new Error('Save As failed'));
        await expect(saveAs).rejects.toThrow('Save As failed');
      } else {
        saveAsWrite.resolve(null);
        await expect(saveAs).resolves.toBeNull();
      }
      originalWrite.resolve('workflows/campaign-with-history.cxflow.json');
      await originalSave;

      expect(store.name).toBe('Failed New Path');
      expect(store.savedPath).toBe('workflows/campaign-with-history.cxflow.json');
      expect(store.savedRev).toBe(baselineRevision);
      expect(store.dirty).toBe(true);
    },
  );

  it.each(['older-first', 'newer-first'] as const)(
    'reconciles concurrent same-target Saves by disk completion order when they finish %s',
    async (completionOrder) => {
      const store = storeWithAcceptedHistory();
      const writes = [deferred<string>(), deferred<string>()];
      vi.spyOn(project, 'saveDocumentToPath')
        .mockReturnValueOnce(writes[0].promise)
        .mockReturnValueOnce(writes[1].promise);
      store.setBriefObjective('brief', 'Older same-path snapshot.');
      const olderBytes = bytes(store);
      const olderSave = store.save();
      store.setBriefObjective('brief', 'Newer same-path snapshot.');
      const newerBytes = bytes(store);
      const newerSave = store.save();

      if (completionOrder === 'older-first') {
        writes[0].resolve('workflows/campaign-with-history.cxflow.json');
        await olderSave;
        expect(store.dirty).toBe(true);
        writes[1].resolve('workflows/campaign-with-history.cxflow.json');
        await newerSave;
        expect(store.dirty).toBe(false);
      } else {
        writes[1].resolve('workflows/campaign-with-history.cxflow.json');
        await newerSave;
        expect(store.dirty).toBe(false);
        writes[0].resolve('workflows/campaign-with-history.cxflow.json');
        await olderSave;
        expect(store.dirty).toBe(true);
      }

      expect(bytes(store)).toBe(newerBytes);
      store.setBriefObjective('brief', 'Older same-path snapshot.');
      expect(bytes(store)).toBe(olderBytes);
      expect(store.dirty).toBe(completionOrder === 'older-first');
    },
  );

  it('reconciles a stale path intent when its resolved target matches the active file', async () => {
    const store = storeWithAcceptedHistory();
    const originalWrite = deferred<string>();
    const saveAsWrite = deferred<string | null>();
    vi.spyOn(project, 'saveDocumentToPath').mockReturnValue(originalWrite.promise);
    vi.spyOn(project, 'saveDocument').mockReturnValue(saveAsWrite.promise);
    store.setBriefObjective('brief', 'Snapshot that will finish writing last.');
    const originalBytes = bytes(store);

    const originalSave = store.save();
    const saveAs = store.saveAs('Same Path Rename');
    saveAsWrite.resolve('workflows/campaign-with-history.cxflow.json');
    await saveAs;
    expect(store.dirty).toBe(false);

    originalWrite.resolve('workflows/campaign-with-history.cxflow.json');
    await originalSave;

    expect(store.savedPath).toBe('workflows/campaign-with-history.cxflow.json');
    expect(store.name).toBe('Same Path Rename');
    expect(store.dirty).toBe(true);
    const originalContent = JSON.parse(originalBytes) as WorkflowGraphV2;
    originalContent.viewport = { panX: 0, panY: 0, zoom: 1 };
    expect((store as unknown as { savedWorkflowContentBytes: string }).savedWorkflowContentBytes)
      .toBe(new WorkflowGraphDomain(originalContent).serialize());
  });

  it.each(['older-first', 'newer-first'] as const)(
    'lets only the later unsaved Save establish a path when writes finish %s',
    async (completionOrder) => {
      const store = new WorkflowStore();
      store.newFromTemplate('campaign-composer', 'Unsaved Campaign');
      const writes = [
        deferred<{ relativePath: string; name: string }>(),
        deferred<{ relativePath: string; name: string }>(),
      ];
      vi.spyOn(project, 'pickDocumentSavePath')
        .mockResolvedValueOnce('/virtual/project/documents/unsaved-campaign-first')
        .mockResolvedValueOnce('/virtual/project/documents/unsaved-campaign-second');
      vi.spyOn(project, 'saveDocumentAtPathAs')
        .mockReturnValueOnce(writes[0].promise)
        .mockReturnValueOnce(writes[1].promise);

      const olderSave = store.save();
      const newerSave = store.save();
      if (completionOrder === 'older-first') {
        writes[0].resolve({
          relativePath: 'documents/unsaved-campaign-first.cxflow.json',
          name: 'unsaved-campaign-first.cxflow.json',
        });
        await olderSave;
        expect(store.savedPath).toBeNull();
        writes[1].resolve({
          relativePath: 'documents/unsaved-campaign-second.cxflow.json',
          name: 'unsaved-campaign-second.cxflow.json',
        });
        await newerSave;
      } else {
        writes[1].resolve({
          relativePath: 'documents/unsaved-campaign-second.cxflow.json',
          name: 'unsaved-campaign-second.cxflow.json',
        });
        await newerSave;
        writes[0].resolve({
          relativePath: 'documents/unsaved-campaign-first.cxflow.json',
          name: 'unsaved-campaign-first.cxflow.json',
        });
        await olderSave;
      }

      expect(store.savedPath).toBe('documents/unsaved-campaign-second.cxflow.json');
      expect(store.dirty).toBe(false);
    },
  );

  it('opens Save Workflow Board for a new workflow and uses the selected filename', async () => {
    const store = new WorkflowStore();
    store.newBoard();
    const pickPath = vi.spyOn(project, 'pickDocumentSavePath')
      .mockResolvedValue('/virtual/project/documents/Named Campaign.cxflow');
    const saveAtPath = vi.spyOn(project, 'saveDocumentAtPathAs')
      .mockResolvedValue({
        relativePath: 'documents/Named Campaign.cxflow.json',
        name: 'Named Campaign.cxflow.json',
      });

    await expect(store.save()).resolves.toBe('documents/Named Campaign.cxflow.json');

    expect(pickPath).toHaveBeenCalledWith('Untitled Workflow.cxflow.json', 'Save Workflow Board');
    expect(saveAtPath).toHaveBeenCalledWith(expect.objectContaining({
      targetPath: '/virtual/project/documents/Named Campaign.cxflow',
      name: 'Named Campaign.cxflow.json',
    }));
    expect(store.name).toBe('Named Campaign');
    expect(store.savedPath).toBe('documents/Named Campaign.cxflow.json');
    expect(store.dirty).toBe(false);
  });

  it('overwrites an opened workflow after load normalization without opening Save As', async () => {
    const source = new WorkflowStore();
    source.newFromTemplate('campaign-composer', 'Existing Campaign');
    const graph = structuredClone(source.serialize());
    const transform = graph.nodes.find((node) => node.type === 'transform')!;
    transform.ports.inputs = transform.ports.inputs.filter((port) => port.id !== 'assets');

    const store = new WorkflowStore();
    store.openFromBytes(
      new TextEncoder().encode(JSON.stringify(graph)),
      'documents/existing-campaign.cxflow.json',
      'existing-campaign',
    );
    const pickPath = vi.spyOn(project, 'pickDocumentSavePath');
    const saveToPath = vi.spyOn(project, 'saveDocumentToPath')
      .mockResolvedValue('documents/existing-campaign.cxflow.json');

    expect(store.requiresExplicitSave).toBe(true);
    expect(store.savedPath).toBe('documents/existing-campaign.cxflow.json');

    await expect(store.save()).resolves.toBe('documents/existing-campaign.cxflow.json');

    expect(pickPath).not.toHaveBeenCalled();
    expect(saveToPath).toHaveBeenCalledWith(
      'documents/existing-campaign.cxflow.json',
      expect.any(Uint8Array),
    );
    expect(store.requiresExplicitSave).toBe(false);
    expect(store.savedPath).toBe('documents/existing-campaign.cxflow.json');
    expect(store.dirty).toBe(false);
  });

  it('ignores save completion after another workflow is opened in the same store', async () => {
    const store = storeWithAcceptedHistory();
    const write = deferred<string>();
    vi.spyOn(project, 'saveDocumentToPath').mockReturnValue(write.promise);
    const saving = store.save();
    const other = new WorkflowStore();
    other.newFromTemplate('campaign-composer', 'Other campaign');

    store.openFromBytes(
      other.toBytes(),
      'workflows/other-campaign.cxflow.json',
      'Other campaign',
    );
    const opened = {
      bytes: bytes(store),
      savedPath: store.savedPath,
      savedRev: store.savedRev,
      dirty: store.dirty,
    };
    write.resolve('workflows/campaign-with-history.cxflow.json');
    await saving;

    expect({
      bytes: bytes(store),
      savedPath: store.savedPath,
      savedRev: store.savedRev,
      dirty: store.dirty,
    }).toEqual(opened);
  });

  it('ignores save completion after the active project changes', async () => {
    const store = storeWithAcceptedHistory();
    store.setBriefObjective('brief', 'Unsaved before project switch.');
    const before = {
      savedPath: store.savedPath,
      savedRev: store.savedRev,
      dirty: store.dirty,
    };
    const write = deferred<string>();
    vi.spyOn(project, 'saveDocumentToPath').mockReturnValue(write.promise);
    const saving = store.save();

    project.current = { ...virtualProject, path: '/virtual/other-project' };
    write.resolve('workflows/campaign-with-history.cxflow.json');
    await saving;

    expect({
      savedPath: store.savedPath,
      savedRev: store.savedRev,
      dirty: store.dirty,
    }).toEqual(before);
  });

  it('captures Save As rename bytes without marking a later edit clean', async () => {
    const store = storeWithAcceptedHistory();
    const write = deferred<string | null>();
    let submittedName = '';
    let submittedBytes = '';
    vi.spyOn(project, 'saveDocument').mockImplementation(async (name, value) => {
      submittedName = name;
      submittedBytes = new TextDecoder().decode(value);
      return write.promise;
    });

    const saving = store.saveAs('Renamed Campaign');
    const submittedRevision = store.rev;
    store.setBriefObjective('brief', 'Edited after Save As submission.');
    const editedBytes = bytes(store);
    write.resolve('workflows/renamed-campaign.cxflow.json');
    await saving;

    expect(submittedName).toBe('Renamed Campaign.cxflow.json');
    expect(JSON.parse(submittedBytes).metadata.name).toBe('Renamed Campaign');
    expect(store.name).toBe('Renamed Campaign');
    expect(store.savedPath).toBe('workflows/renamed-campaign.cxflow.json');
    expect(store.savedRev).toBe(submittedRevision);
    expect(bytes(store)).toBe(editedBytes);
    expect(store.dirty).toBe(true);
  });

  it('leaves the saved marker and valid Director history unchanged on save failure', async () => {
    const store = storeWithAcceptedHistory();
    store.createDirectorPatchProposal(configureTransformPatch(store));
    store.acceptDirectorPatchProposal();
    const savedPath = store.savedPath;
    const savedRevision = store.savedRev;
    const write = deferred<string>();
    vi.spyOn(project, 'saveDocumentToPath').mockReturnValue(write.promise);

    const saving = store.save();
    write.reject(new Error('disk unavailable'));
    await expect(saving).rejects.toThrow('disk unavailable');

    expect(store.savedPath).toBe(savedPath);
    expect(store.savedRev).toBe(savedRevision);
    expect(store.dirty).toBe(true);
    expect(store.undoDirectorPatch()).toBe(true);
  });

  it('stays dirty when an edit after undo collides with the saved store revision', async () => {
    const store = storeWithAcceptedHistory();
    store.createDirectorPatchProposal(configureTransformPatch(store));
    store.acceptDirectorPatchProposal();
    vi.spyOn(project, 'saveDocumentToPath')
      .mockResolvedValue('workflows/campaign-with-history.cxflow.json');

    await store.save();
    expect(store.dirty).toBe(false);
    expect(store.undoDirectorPatch()).toBe(true);
    expect(store.dirty).toBe(true);

    store.setBriefObjective('brief', 'Different bytes at the same numeric revision.');

    expect(store.rev).toBe(store.savedRev);
    expect(store.dirty).toBe(true);
  });

  it('rejects stale pending acceptance after a graph race without rolling back the newer change', () => {
    const store = storeWithAcceptedHistory();
    store.createDirectorPatchProposal(configureTransformPatch(store));
    store.setBriefObjective('brief', 'A newer objective written during review.');
    const racedBytes = bytes(store);
    const racedRevision = store.graphRevision;
    const racedRev = store.rev;

    expect(() => store.acceptDirectorPatchProposal()).toThrow(/changed while.*reviewed|stale/i);
    expect(bytes(store)).toBe(racedBytes);
    expect(store.graphRevision).toBe(racedRevision);
    expect(store.rev).toBe(racedRev);
    expect(store.pendingDirectorPatchProposal).toBeNull();
  });

  it('rejects a store-only race even when the graph content revision did not change', () => {
    const store = storeWithAcceptedHistory();
    store.createDirectorPatchProposal(configureTransformPatch(store));
    const graphRevision = store.graphRevision;
    store.setName('Renamed during review');
    const racedBytes = bytes(store);

    expect(store.graphRevision).toBe(graphRevision);
    expect(() => store.acceptDirectorPatchProposal()).toThrow(/changed while.*reviewed/i);
    expect(bytes(store)).toBe(racedBytes);
    expect(store.name).toBe('Renamed during review');
    expect(store.pendingDirectorPatchProposal).toBeNull();
  });

  it('rolls back an invalid pending target before any graph or transaction mutation', () => {
    const store = storeWithAcceptedHistory();
    store.createDirectorPatchProposal(configureTransformPatch(store));
    const internal = store as unknown as {
      pendingDirectorPatchReview: { proposal: { graph: WorkflowGraphV2 } };
    };
    const invalid = structuredClone(internal.pendingDirectorPatchReview);
    invalid.proposal.graph.edges[0].target.nodeId = 'missing-target';
    internal.pendingDirectorPatchReview = invalid;
    const beforeBytes = bytes(store);
    const beforeRevision = store.graphRevision;
    const beforeRev = store.rev;

    expect(() => store.acceptDirectorPatchProposal()).toThrow();
    expect(bytes(store)).toBe(beforeBytes);
    expect(store.graphRevision).toBe(beforeRevision);
    expect(store.rev).toBe(beforeRev);
    expect(store.undoDirectorPatch()).toBe(false);
  });

  it('invalidates Director undo rather than overwriting a later unrelated mutation', () => {
    const store = storeWithAcceptedHistory();
    store.createDirectorPatchProposal(configureTransformPatch(store));
    store.acceptDirectorPatchProposal();
    store.setBriefObjective('brief', 'A later manual edit.');
    const laterBytes = bytes(store);

    expect(store.undoDirectorPatch()).toBe(false);
    expect(bytes(store)).toBe(laterBytes);
  });

  it('applies an in-flight Generate after accept then undo restores its generation settings', async () => {
    const store = new WorkflowStore();
    store.newFromTemplate('campaign-composer');
    store.removeNode('review-campaign-direction');
    store.removeNode('transform-format-square');
    store.removeNode('transform-generate-portrait');
    store.removeNode('transform-generate-landscape');
    store.connectPorts('transform-generate-square', 'result', 'output-square', 'source');
    store.connectPorts('composition', 'layout', 'output-portrait', 'source');
    store.connectPorts('composition', 'layout', 'output-landscape', 'source');
    store.assignAsset('slot-product', productAsset);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const run = store.runCampaignGenerate('output-square', {
      projectPath: '/virtual/project',
      provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', async () => {
        await gate;
        return {
          kind: 'project-asset',
          asset: {
            id: 'late-result',
            name: 'Late.png',
            relativePath: 'generated/Late.png',
            width: 1024,
            height: 1024,
            mime: 'image/png',
          },
          bytes: new Uint8Array([1, 2, 3]),
        };
      })],
      allowUnpromotedReview: true,
      assets: [productAsset],
      resolveAsset: async () => ({
        assetId: productAsset.id,
        relativePath: productAsset.relativePath,
        bytes: new Uint8Array([137, 80, 78, 71]),
        contentHash: workflowSha256Bytes(new Uint8Array([137, 80, 78, 71])),
      }),
      storeAsset: async () => { throw new Error('unused'); },
    });
    store.createDirectorPatchProposal(configureTransformPatch(store));
    store.acceptDirectorPatchProposal();
    expect(store.undoDirectorPatch()).toBe(true);
    const restoredInstructions = store.graphSnapshot().nodes
      .find((node) => node.id === 'transform-generate-square')?.config.instructions;

    finish();
    const outcome = await run;

    expect(outcome).toMatchObject({ committed: true, commitMessage: 'Generated result applied.' });
    expect(outcome.warning).toBeUndefined();
    expect(store.graphSnapshot().nodes.find((node) => node.id === 'transform-generate-square')?.config.instructions)
      .toBe(restoredInstructions);
    expect(store.outputNode('output-square')?.outputAssetId).toBe('late-result');
  });
});
