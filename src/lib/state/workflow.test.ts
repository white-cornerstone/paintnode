import { describe, expect, it } from 'vitest';
import { WorkflowStore } from './workflow.svelte';
import assetsStoryboard from '../workflow/fixtures/v1/assets-storyboard.json';
import annotations from '../workflow/fixtures/v1/annotations.json';
import multipleOutputs from '../workflow/fixtures/v1/multiple-outputs.json';
import { WORKFLOW_GRAPH_VERSION, type WorkflowGraphV2, type WorkflowIdGenerator } from '../workflow';
import { WORKFLOW_TEMPLATES } from '../workflow/templates';
import { workflowReadiness } from '../workflow/readiness';
import { createCreatorNode, type CreatorNodeType } from '../workflow/registry';
import type { ProjectAsset } from '../integrations/desktop';

function ids(): WorkflowIdGenerator {
  let sequence = 0;
  return (kind) => `${kind}-test-${++sequence}`;
}

describe('WorkflowStore graph adapter', () => {
  it('adds every creator registry node and preserves exact config and port identity on reopen', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard('Palette additions');
    const types: CreatorNodeType[] = ['input', 'brief', 'art-direction', 'transform', 'review', 'output'];
    const added = types.map((type, index) => store.addCreatorNode(type, { x: 50 + index * 250, y: 500 }));
    const graph = store.graphSnapshot();

    for (const [index, nodeId] of added.entries()) {
      const expected = createCreatorNode(types[index], {
        id: nodeId,
        position: { x: 50 + index * 250, y: 500 },
      });
      expect(graph.nodes.find((node) => node.id === nodeId)).toEqual(expected);
    }
    expect([
      store.nodes.find((node) => node.id === added[0])?.id,
      store.briefNodes.find((node) => node.id === added[1])?.id,
      store.creatorNodes.find((node) => node.id === added[2])?.id,
      store.creatorNodes.find((node) => node.id === added[3])?.id,
      store.creatorNodes.find((node) => node.id === added[4])?.id,
      store.outputNodes.find((node) => node.id === added[5])?.id,
    ]).toEqual(added);
    expect(store.creatorNodes.map((node) => node.type)).toEqual(['art-direction', 'transform', 'review']);
    expect(store.selection).toEqual({ kind: 'output', id: added.at(-1) });

    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(store.toBytes(), null, 'Palette additions');
    expect(reopened.serialize()).toEqual(store.serialize());
    expect(reopened.creatorNodes.map((node) => node.type)).toEqual(['art-direction', 'transform', 'review']);
  });

  it('rejects invalid creator additions atomically before the graph domain mutates', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard('Atomic palette add');
    const before = store.graphSnapshot();

    expect(() => store.addCreatorNode('transform', { x: 100, y: 200 }, {
      capability: '',
      instructions: '',
      advanced: 'codex',
    })).toThrow(/invalid transform configuration/i);
    expect(store.graphSnapshot()).toBe(before);
    expect(store.rev).toBe(0);
  });

  it('updates meaningful creator configuration fields and generic input asset bindings', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard('Creator controls');
    const inputId = store.addCreatorNode('input');
    const artId = store.addCreatorNode('art-direction');
    const transformId = store.addCreatorNode('transform');
    const reviewId = store.addCreatorNode('review');
    const asset = { id: 'asset-1', name: 'Reference.png', relativePath: 'assets/Reference.png' } as ProjectAsset;

    store.assignAsset(inputId, asset);
    store.configureCreatorNode(inputId, { role: 'Hero product reference' });
    store.configureCreatorNode(artId, { prompt: 'Top-lit editorial layout' });
    store.configureCreatorNode(transformId, { capability: 'relight', instructions: 'Warm key light' });
    store.configureCreatorNode(reviewId, { mode: 'human', instructions: 'Prefer legibility' });

    expect(store.graphSnapshot().nodes.find((node) => node.id === inputId)?.config).toMatchObject({
      assetId: 'asset-1', relativePath: 'assets/Reference.png', role: 'Hero product reference',
    });
    expect(store.creatorNodes.find((node) => node.id === artId)?.config.prompt).toBe('Top-lit editorial layout');
    expect(store.creatorNodes.find((node) => node.id === transformId)?.config).toMatchObject({ capability: 'relight', instructions: 'Warm key light' });
    expect(store.creatorNodes.find((node) => node.id === reviewId)?.config).toMatchObject({ mode: 'human', instructions: 'Prefer legibility' });
  });

  it('connects the exact named typed ports requested by the board', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard('Exact ports');
    const inputId = store.addCreatorNode('input');
    const briefId = store.addCreatorNode('brief');
    const artId = store.addCreatorNode('art-direction');

    expect(store.connectPorts(inputId, 'asset', artId, 'assets')).toBe(true);
    expect(store.connectPorts(briefId, 'prompt', artId, 'brief')).toBe(true);
    expect(store.graphSnapshot().edges.slice(-2).map((edge) => ({ source: edge.source, target: edge.target }))).toEqual([
      { source: { nodeId: inputId, portId: 'asset' }, target: { nodeId: artId, portId: 'assets' } },
      { source: { nodeId: briefId, portId: 'prompt' }, target: { nodeId: artId, portId: 'brief' } },
    ]);
  });

  it.each(WORKFLOW_TEMPLATES)('installs and round-trips the $name template through the graph adapter', (template) => {
    const store = new WorkflowStore({
      idGenerator: ids(),
      workflowGraphIdGenerator: () => `workflow-${template.id}-test`,
    });
    store.newFromTemplate(template.id, `My ${template.name}`);

    expect(store.active).toBe(true);
    expect(store.name).toBe(`My ${template.name}`);
    expect(store.graphSnapshot().id).toBe(`workflow-${template.id}-test`);
    expect(store.savedPath).toBeNull();
    expect(store.rev).toBe(0);
    expect(store.savedRev).toBe(0);
    expect(store.dirty).toBe(false);
    expect(store.briefNodes).toHaveLength(1);
    expect(store.nodes.map((node) => node.name)).toEqual(template.slots.map((slot) => slot.name));
    expect(store.outputNodes.map((node) => [node.name, node.finalWidth, node.finalHeight])).toEqual(
      template.outputs.map((output) => [output.name, output.width, output.height]),
    );

    const graph = store.serialize();
    expect(graph.metadata).toEqual({ name: `My ${template.name}`, sourceVersion: null, migrations: [] });
    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(store.toBytes(), null, 'Fallback');
    expect(reopened.serialize()).toEqual(graph);
    expect(reopened.briefNodes).toEqual(store.briefNodes);
    expect(reopened.rev).toBe(0);
  });

  it('persists guided slot assignments and brief edits as graph configuration', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer');
    store.assignAsset('slot-product', {
      id: 'product-asset',
      kind: 'imported',
      name: 'Product.png',
      relativePath: 'assets/product.png',
      createdAt: 1,
      exists: true,
    });
    store.setBriefObjective('brief', 'Launch the winter range for design-conscious travellers.');

    expect(store.nodes.find((node) => node.id === 'slot-product')).toMatchObject({
      assetId: 'product-asset',
      relativePath: 'assets/product.png',
      required: true,
    });
    expect(store.briefNodes[0].objective).toBe('Launch the winter range for design-conscious travellers.');
    expect(store.rev).toBe(2);

    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(store.toBytes(), null, 'Campaign');
    expect(reopened.nodes.find((node) => node.id === 'slot-product')).toMatchObject({
      assetId: 'product-asset',
      relativePath: 'assets/product.png',
    });
    expect(reopened.briefNodes[0].objective).toBe('Launch the winter range for design-conscious travellers.');
  });

  it('reconnects Brief through the compatible named prompt port and restores readiness', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer');
    store.assignAsset('slot-product', {
      id: 'product-asset', kind: 'imported', name: 'Product.png', relativePath: 'assets/product.png', createdAt: 1, exists: true,
    });
    store.disconnectConnection('edge-brief-composition');
    const options = {
      desktop: true,
      projectPath: '/tmp/project',
      assets: [{ id: 'product-asset', relativePath: 'assets/product.png', exists: true }],
    };
    expect(workflowReadiness(store.graphSnapshot(), options).ready).toBe(false);
    expect(store.planExecution('output-square', { maxConcurrency: 2 }).blocked).not.toEqual([]);

    expect(store.connect('brief', 'composition')).toBe(true);
    expect(store.graphSnapshot().edges.find((edge) => edge.source.nodeId === 'brief')).toMatchObject({
      source: { portId: 'prompt' },
      target: { portId: 'brief' },
    });
    expect(workflowReadiness(store.graphSnapshot(), options).ready).toBe(true);
    expect(store.planExecution('output-square', { maxConcurrency: 2 }).blocked).toEqual([]);
  });

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
    const initial = { outputWidth: store.outputWidth, outputHeight: store.outputHeight, outputX: store.outputX, outputY: store.outputY };
    store.setPrompt('Geometry must not change');

    expect(store.outputWidth).toBe(initial.outputWidth);
    expect(store.outputHeight).toBe(initial.outputHeight);
    expect(store.outputX).toBe(initial.outputX);
    expect(store.outputY).toBe(initial.outputY);

    const secondary = store.addOutputNode();
    expect(secondary).toMatchObject({ width: 210, height: 190 });
  });

  it('normalizes near-origin UI mutations while preserving exact v2 viewport values on reopen', () => {
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

    const persisted = structuredClone(store.serialize());
    persisted.viewport.panX = -0.1;
    persisted.viewport.panY = -0.1;
    persisted.nodes.find((node) => node.id === assetId)!.position.x = -0.1;
    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(
      new TextEncoder().encode(JSON.stringify(persisted)),
      'workflows/near-origin.cxflow.json',
      'Near origin',
    );

    expect(reopened.panX).toBe(-0.1);
    expect(reopened.panY).toBe(-0.1);
    expect(reopened.nodes[0].x).toBe(-0.1);
  });

  it('reopens a WorkflowGraph v2 save through the same domain adapter', () => {
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

  it.each([
    ['assets and storyboard', assetsStoryboard],
    ['annotations', annotations],
    ['multiple outputs', multipleOutputs],
  ])('migrates the %s v1 fixture into reactive behavior and explicitly saves/reopens v2', (_name, fixture) => {
    const store = new WorkflowStore({ idGenerator: ids() });
    const originalBytes = new TextEncoder().encode(JSON.stringify(fixture));
    store.openFromBytes(originalBytes, `workflows/${fixture.name}.cxflow.json`, fixture.name);

    expect(store.requiresExplicitSave).toBe(true);
    expect(store.savedPath).toBeNull();
    expect(store.migrationSourcePath).toContain('.cxflow.json');
    expect(store.serialize().version).toBe(WORKFLOW_GRAPH_VERSION);
    expect(JSON.parse(new TextDecoder().decode(originalBytes))).toEqual(fixture);

    const v2 = store.serialize();
    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(store.toBytes(), 'workflows/converted.cxflow.json', 'Converted');
    expect(reopened.serialize()).toEqual(v2);
    expect(reopened.requiresExplicitSave).toBe(false);
    expect(reopened.rev).toBe(0);
  });

  it('preserves storyboard, annotations, multiple outputs, generated placement, references, and graph metadata', () => {
    const assets = new WorkflowStore({ idGenerator: ids() });
    assets.openFromBytes(
      new TextEncoder().encode(JSON.stringify(assetsStoryboard)),
      'workflows/assets.cxflow.json',
      'Assets',
    );
    expect(assets.nodes).toHaveLength(2);
    expect(assets.nodes[0]).toMatchObject({
      assetId: 'project-product',
      relativePath: 'assets/product.png',
      included: true,
      note: 'Hero product; preserve label and proportions',
    });
    expect(assets.storyboardDataUrl).toBe(assetsStoryboard.storyboardDataUrl);

    const store = new WorkflowStore({ idGenerator: ids() });
    store.openFromBytes(
      new TextEncoder().encode(JSON.stringify(multipleOutputs)),
      'workflows/outputs.cxflow.json',
      'Outputs',
    );
    expect(store.outputNodes).toHaveLength(2);
    expect(store.outputNodes[1]).toMatchObject({ finalWidth: 768, finalHeight: 1376, outputAssetId: 'story-asset' });
    store.setOutput({
      id: 'replacement-story',
      kind: 'generated',
      name: 'replacement.png',
      relativePath: 'generated/replacement-story.png',
      createdAt: 2,
      exists: true,
    }, 'output-story');
    const placementReopen = new WorkflowStore({ idGenerator: ids() });
    placementReopen.openFromBytes(store.toBytes(), 'workflows/placement.cxflow.json', 'Placement');
    expect(placementReopen.outputNode('output-story')).toMatchObject({
      outputAssetId: 'replacement-story',
      outputRelativePath: 'generated/replacement-story.png',
    });
    placementReopen.setOutput(null, 'output-story');
    expect(placementReopen.outputNode('output-story')).toMatchObject({
      outputAssetId: null,
      outputRelativePath: null,
    });
    const clearedReopen = new WorkflowStore({ idGenerator: ids() });
    clearedReopen.openFromBytes(placementReopen.toBytes(), 'workflows/cleared.cxflow.json', 'Cleared');
    expect(clearedReopen.outputNode('output-story')).toMatchObject({
      outputAssetId: null,
      outputRelativePath: null,
    });

    const storyboard = new WorkflowStore({ idGenerator: ids() });
    storyboard.openFromBytes(
      new TextEncoder().encode(JSON.stringify(annotations)),
      'workflows/annotations.cxflow.json',
      'Annotations',
    );
    expect(storyboard.storyboardAnnotationItems).toEqual(annotations.storyboardAnnotationItems);
    expect(storyboard.storyboardAnnotationsVisible).toBe(false);
    const before = storyboard.serialize();
    storyboard.setPrompt('Updated prompt');
    const after = storyboard.serialize();
    expect(after.id).toBe(before.id);
    expect(after.metadata.sourceVersion).toBe(1);
    expect(after.metadata.migrations).toEqual([{ from: 1, to: 2 }]);
    expect(after.assetReferences).toEqual(before.assetReferences);
  });

  it('keeps presentation state outside graph revisions while persisting viewport dirty state', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard();
    const graphRevision = store.graphRevision;
    store.select({ kind: 'output', id: 'output' });
    store.setTool('zoom');
    expect(store.rev).toBe(0);
    expect(store.graphRevision).toBe(graphRevision);
    store.zoomBy(1, 300, 200);
    expect(store.rev).toBe(0);

    store.panBy(20, 10);
    store.setZoom(1.25);
    expect(store.rev).toBe(2);
    expect(store.graphRevision).toBe(graphRevision);
    expect(store.serialize().viewport).toEqual({ panX: 20, panY: 10, zoom: 1.25 });
  });

  it('round-trips unusual valid v2 metadata names exactly until the user renames', () => {
    const source = new WorkflowStore({ idGenerator: ids() });
    source.newBoard();
    const graph = structuredClone(source.serialize());
    graph.metadata.name = '  Campaign.CXFLOW.JSON  ';
    const store = new WorkflowStore({ idGenerator: ids() });
    store.openFromBytes(new TextEncoder().encode(JSON.stringify(graph)), 'workflows/unusual.cxflow.json', 'Fallback');

    expect(store.name).toBe('  Campaign.CXFLOW.JSON  ');
    expect(store.serialize().metadata.name).toBe('  Campaign.CXFLOW.JSON  ');
    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(store.toBytes(), 'workflows/unusual.cxflow.json', 'Fallback');
    expect(reopened.serialize()).toEqual(store.serialize());

    store.setName('  Renamed.cxflow.json  ');
    expect(store.serialize().metadata.name).toBe('Renamed');
  });

  it('preserves fractional v2 pan for identity and saturated zoom no-ops', () => {
    const source = new WorkflowStore({ idGenerator: ids() });
    source.newBoard();
    const graph = structuredClone(source.serialize());
    graph.viewport = { panX: 0.5, panY: -0.5, zoom: 1 };
    const store = new WorkflowStore({ idGenerator: ids() });
    store.openFromBytes(new TextEncoder().encode(JSON.stringify(graph)), 'workflows/fractional.cxflow.json', 'Fractional');

    store.zoomBy(1, 200, 100);
    expect(store.rev).toBe(0);
    expect(store.serialize().viewport).toEqual({ panX: 0.5, panY: -0.5, zoom: 1 });

    const saturatedGraph = structuredClone(graph);
    saturatedGraph.viewport = { panX: 0.5, panY: -0.5, zoom: 4 };
    const saturated = new WorkflowStore({ idGenerator: ids() });
    saturated.openFromBytes(new TextEncoder().encode(JSON.stringify(saturatedGraph)), 'workflows/saturated.cxflow.json', 'Saturated');
    saturated.zoomAt(200, 100, 'in');
    expect(saturated.rev).toBe(0);
    expect(saturated.serialize().viewport).toEqual(saturatedGraph.viewport);
  });

  it('surfaces strict connection explanations without dirtying or partially mutating the graph', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard();
    const before = store.graphSnapshot();

    expect(store.connect('composition', 'composition')).toBe(false);
    expect(store.connectionError).toMatch(/cannot connect to itself/i);
    expect(store.graphSnapshot()).toBe(before);
    expect(store.rev).toBe(0);
  });

  it('delegates output execution planning and preserves unsupported dormant nodes across UI mutations', () => {
    const source = new WorkflowStore({ idGenerator: ids() });
    source.newBoard();
    const graph = structuredClone(source.serialize()) as WorkflowGraphV2;
    graph.nodes.push({
      id: 'future',
      type: 'unsupported',
      title: 'Future node',
      position: { x: 100, y: 500 },
      size: { width: 200, height: 160 },
      color: '#333333',
      ports: { inputs: [], outputs: [] },
      config: { unsupportedType: 'future', rawConfig: { strength: 1 }, rawPorts: {}, rawNode: {} },
      runRecordIds: [],
    });
    graph.nodes.find((node) => node.id === 'composition')!.runRecordIds = ['run-composition'];
    graph.runRecords = [{ id: 'run-composition', nodeId: 'composition', status: 'succeeded' }];
    const store = new WorkflowStore({ idGenerator: ids() });
    store.openFromBytes(new TextEncoder().encode(JSON.stringify(graph)), 'workflows/future.cxflow.json', 'Future');
    expect(store.unsupportedNodes).toEqual([
      expect.objectContaining({
        id: 'future',
        unsupportedType: 'future',
        runnable: false,
        config: graph.nodes.at(-1)?.config,
      }),
    ]);
    store.setPrompt('Still preserved');
    store.addCreatorNode('review', { x: 360, y: 500 });

    expect(store.serialize().nodes.find((node) => node.id === 'future')).toEqual(graph.nodes.at(-1));
    expect(store.serialize().runRecords).toEqual(graph.runRecords);
    expect(store.planExecution('output', { maxConcurrency: 2 })).toMatchObject({
      targetNodeId: 'output',
      executionOrder: ['composition', 'output'],
    });
  });
});
