import { describe, expect, it } from 'vitest';
import { WorkflowStore } from './workflow.svelte';
import type { WorkflowIdGenerator } from '../workflow';

function ids(): WorkflowIdGenerator {
  let sequence = 0;
  return (kind) => `${kind}-test-${++sequence}`;
}

describe('WorkflowStore graph adapter', () => {
  it('routes asset node mutations and connections through one domain owner', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard('Adapter test');

    expect(store.graphRevision).toBe(0);
    expect(store.rev).toBe(0);

    store.addBlankAsset(12.4, 24.6, 100, 100);
    const assetId = store.nodes[0].id;
    expect(assetId).toBe('node-test-2');
    expect(store.nodes[0]).toMatchObject({ x: 12, y: 25, width: 160, height: 130, included: true });
    expect(store.isConnected(assetId, 'composition')).toBe(true);
    expect(store.rev).toBe(1);
    expect(store.graphRevision).toBe(2);

    store.moveNode(assetId, 80.6, 91.2);
    store.resizeNode(assetId, 200.2, 149.7);
    store.setNodeNote(assetId, 'Reference only');
    expect(store.nodes[0]).toMatchObject({
      x: 81,
      y: 91,
      width: 200,
      height: 150,
      note: 'Reference only',
    });
    expect(store.rev).toBe(4);
    expect(store.graphRevision).toBe(5);

    const connectionId = store.connections.find((connection) => connection.from === assetId)?.id;
    expect(connectionId).toBe('edge-test-3');
    store.disconnectConnection(connectionId!);
    expect(store.nodes[0].included).toBe(false);
    expect(store.rev).toBe(5);

    store.connect(assetId, 'composition');
    expect(store.nodes[0].included).toBe(true);
    expect(store.rev).toBe(6);

    store.removeNode(assetId);
    expect(store.nodes).toEqual([]);
    expect(store.connections.every((connection) => connection.from !== assetId && connection.to !== assetId)).toBe(true);
    expect(store.rev).toBe(7);
  });

  it('rolls back every compound store add when injected edge generation collides', () => {
    const cases: Array<[string, (store: WorkflowStore) => void]> = [
      ['blank asset', (store) => store.addBlankAsset(20, 30, 200, 180)],
      ['project asset', (store) => store.addAsset({
        id: 'project-asset',
        kind: 'imported',
        name: 'Reference.png',
        relativePath: 'assets/reference.png',
        createdAt: 1,
        exists: true,
      })],
      ['output', (store) => { store.addOutputNode(); }],
    ];

    for (const [name, add] of cases) {
      const generatedIds = ['edge-existing', `transient-${name}`, 'edge-existing'];
      let index = 0;
      const store = new WorkflowStore({
        idGenerator: () => generatedIds[index++] ?? `generated-${index}`,
      });
      store.newBoard();

      expect(() => add(store), name).toThrowError(expect.objectContaining({ code: 'DUPLICATE_EDGE_ID' }));
      expect(store.nodes, name).toEqual([]);
      expect(store.outputNodes, name).toHaveLength(1);
      expect(store.rev, name).toBe(0);
      expect(store.graphRevision, name).toBe(0);

      store.setPrompt('Mutation after rollback');
      expect(store.nodes, name).toEqual([]);
      expect(store.outputNodes, name).toHaveLength(1);
      expect(store.prompt, name).toBe('Mutation after rollback');
    }
  });

  it('preserves output behavior without double-incrementing the store revision', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard();

    store.moveOutput(700.4, 88.8);
    expect(store.outputNodes[0]).toMatchObject({ x: 700, y: 89 });
    expect(store.outputX).toBe(700);
    expect(store.outputY).toBe(89);
    expect(store.rev).toBe(1);

    const added = store.addOutputNode(1000.2, 90.7, 100, 100);
    expect(added).toMatchObject({
      id: 'node-test-2',
      x: 1000,
      y: 91,
      width: 190,
      height: 190,
    });
    expect(store.isConnected('composition', added.id)).toBe(true);
    expect(store.selection).toEqual({ kind: 'output', id: added.id });
    expect(store.rev).toBe(2);

    store.removeOutputNode(added.id);
    expect(store.outputNodes.map((node) => node.id)).toEqual(['output']);
    expect(store.rev).toBe(3);
  });

  it('routes composition configuration while keeping selection and tools reactive-only', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard();
    const selection = store.selection;
    const tool = store.tool;

    store.setPrompt('Launch campaign');
    store.setStoryboardSize(1600, 900);
    store.setStoryboardAnnotations(['  Focus product  ', '', 'Warm light']);

    expect(store.prompt).toBe('Launch campaign');
    expect(store.storyboardWidth).toBe(1600);
    expect(store.storyboardHeight).toBe(900);
    expect(store.storyboardAnnotations).toEqual(['Focus product', 'Warm light']);
    expect(store.selection).toEqual(selection);
    expect(store.tool).toBe(tool);
    expect(store.rev).toBe(3);
    expect(store.graphRevision).toBe(3);
  });

  it('preserves legacy primary and default secondary output geometry after unrelated mutations', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard();
    const initial = store.serialize();

    expect(initial.outputHeight).toBe(190);
    expect(initial.outputNodes?.[0].height).toBe(232);
    store.setPrompt('Geometry must not change');

    const afterPrompt = store.serialize();
    expect(afterPrompt.outputWidth).toBe(initial.outputWidth);
    expect(afterPrompt.outputHeight).toBe(initial.outputHeight);
    expect(afterPrompt.outputX).toBe(initial.outputX);
    expect(afterPrompt.outputY).toBe(initial.outputY);
    expect(afterPrompt.outputNodes?.[0]).toEqual(initial.outputNodes?.[0]);

    const secondary = store.addOutputNode();
    expect(secondary).toMatchObject({ width: 210, height: 190 });
  });

  it('normalizes near-origin UI coordinates and opened viewport values to positive zero', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard();
    store.addBlankAsset(-0.1, -0.1, 200, 180);
    const assetId = store.nodes[0].id;
    store.moveNode(assetId, 10, 10);
    store.moveNode(assetId, -0.1, -0.1);
    store.movePrompt(-0.1, -0.1);
    store.moveOutput(-0.1, -0.1);

    expect(store.nodes[0].x).toBe(0);
    expect(store.nodes[0].y).toBe(0);
    expect(store.promptX).toBe(0);
    expect(store.promptY).toBe(0);
    expect(store.outputX).toBe(0);
    expect(store.outputY).toBe(0);
    expect(Object.is(store.nodes[0].x, -0)).toBe(false);

    const persisted = store.serialize();
    persisted.panX = -0.1;
    persisted.panY = -0.1;
    persisted.nodes[0].x = -0.1;
    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(
      new TextEncoder().encode(JSON.stringify(persisted)),
      'workflows/near-origin.cxflow.json',
      'Near origin',
    );

    expect(reopened.panX).toBe(0);
    expect(reopened.panY).toBe(0);
    expect(reopened.nodes[0].x).toBe(0);
    expect(Object.is(reopened.panX, -0)).toBe(false);
    expect(Object.is(reopened.nodes[0].x, -0)).toBe(false);
  });

  it('rebuilds the domain adapter after opening the unchanged v1 serialization format', () => {
    const source = new WorkflowStore({ idGenerator: ids() });
    source.newBoard('Legacy round trip');
    source.addBlankAsset(20, 30, 200, 180);
    const bytes = source.toBytes();

    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(bytes, 'workflows/legacy.cxflow.json', 'Fallback');
    const assetId = reopened.nodes[0].id;

    expect(reopened.serialize()).toEqual(source.serialize());
    expect(reopened.graphRevision).toBe(0);
    reopened.moveNode(assetId, 45, 55);
    expect(reopened.nodes[0]).toMatchObject({ x: 45, y: 55 });
    expect(reopened.rev).toBe(1);
    expect(reopened.graphRevision).toBe(1);
  });
});
