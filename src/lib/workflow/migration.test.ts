import { describe, expect, it } from 'vitest';
import blank from './fixtures/v1/blank.json';
import assetsStoryboard from './fixtures/v1/assets-storyboard.json';
import annotations from './fixtures/v1/annotations.json';
import multipleOutputs from './fixtures/v1/multiple-outputs.json';
import { migrateWorkflowFileV1 } from './migration';
import { WorkflowGraphDomain } from './domain';
import { parseWorkflowGraphV2, serializeWorkflowGraphV2 } from './schema';

describe('WorkflowFile v1 to WorkflowGraph v2 migration', () => {
  it.each([
    ['blank', blank],
    ['assets and storyboard', assetsStoryboard],
    ['annotations', annotations],
    ['multiple outputs', multipleOutputs],
  ])('produces a strictly valid acyclic graph for the %s v1 fixture', (_name, fixture) => {
    const migrated = migrateWorkflowFileV1(structuredClone(fixture));

    expect(() => new WorkflowGraphDomain(migrated)).not.toThrow();
  });

  it('migrates a blank workflow without mutating the source', () => {
    const source = structuredClone(blank);
    const migrated = migrateWorkflowFileV1(source);

    expect(source).toEqual(blank);
    expect(migrated.version).toBe(2);
    expect(migrated.metadata).toMatchObject({
      name: 'Untitled Workflow',
      sourceVersion: 1,
      migrations: [{ from: 1, to: 2 }],
    });
    expect(migrated.viewport).toEqual({ panX: 0, panY: 0, zoom: 1 });
    expect(migrated.nodes.map((node) => [node.id, node.type])).toEqual([
      ['composition', 'art-direction'],
      ['output', 'output'],
    ]);
    expect(migrated.edges).toEqual([
      {
        id: 'connection-default',
        source: { nodeId: 'composition', portId: 'layout' },
        target: { nodeId: 'output', portId: 'source' },
      },
    ]);
    expect(parseWorkflowGraphV2(migrated).ok).toBe(true);
  });

  it('preserves asset roles, inclusion, references, layout, and storyboard data', () => {
    const migrated = migrateWorkflowFileV1(structuredClone(assetsStoryboard));
    const product = migrated.nodes.find((node) => node.id === 'asset-product');
    const style = migrated.nodes.find((node) => node.id === 'asset-style');
    const direction = migrated.nodes.find((node) => node.id === 'composition');

    expect(product).toMatchObject({
      type: 'input',
      title: 'Product',
      position: { x: 60, y: 100 },
      size: { width: 220, height: 210 },
      color: '#3e6b57',
      config: {
        assetReferenceId: 'asset-ref-asset-product',
        included: true,
        role: 'Hero product; preserve label and proportions',
      },
    });
    expect(style?.config).toMatchObject({ included: false, role: 'Use the lighting and palette only' });
    expect(migrated.assetReferences).toEqual(expect.arrayContaining([
      {
        id: 'asset-ref-asset-product',
        role: 'source',
        assetId: 'project-product',
        relativePath: 'assets/product.png',
      },
      {
        id: 'asset-ref-output',
        role: 'output',
        assetId: 'generated-square',
        relativePath: 'generated/beach-square.png',
      },
    ]));
    expect(direction).toMatchObject({
      type: 'art-direction',
      title: 'Beach art direction',
      position: { x: 460, y: 80 },
      size: { width: 420, height: 520 },
      color: '#3e4f7a',
      config: {
        prompt: 'Create a summer campaign image.',
        storyboard: {
          dataUrl: 'data:image/png;base64,c3Rvcnlib2FyZA==',
          width: 1200,
          height: 896,
          oraPath: 'storyboards/beach.ora',
          annotations: ['Place the product in the lower right'],
          annotationItems: [],
          annotationsVisible: true,
        },
      },
    });
    expect(migrated.viewport).toEqual({ panX: -120, panY: 35, zoom: 0.85 });
    expect(migrated.edges.map((edge) => edge.id)).toEqual(['connection-product', 'connection-output']);
  });

  it('preserves editable annotation items and visibility', () => {
    const migrated = migrateWorkflowFileV1(structuredClone(annotations));
    const direction = migrated.nodes.find((node) => node.id === 'composition');

    expect(direction?.config).toMatchObject({
      storyboard: {
        annotations: annotations.storyboardAnnotations,
        annotationItems: annotations.storyboardAnnotationItems,
        annotationsVisible: false,
      },
    });
  });

  it('preserves every output node, final size, placement, color, and generated asset reference', () => {
    const migrated = migrateWorkflowFileV1(structuredClone(multipleOutputs));
    const outputs = migrated.nodes.filter((node) => node.type === 'output');

    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toMatchObject({
      id: 'output',
      title: 'Square',
      position: { x: 850, y: 90 },
      size: { width: 210, height: 232 },
      color: '#3a3c42',
      config: {
        finalWidth: 1024,
        finalHeight: 1024,
        assetReferenceId: 'asset-ref-output',
      },
    });
    expect(outputs[1]).toMatchObject({
      id: 'output-story',
      title: 'Story',
      position: { x: 1120, y: 90 },
      size: { width: 210, height: 280 },
      color: '#5b4f7a',
      config: {
        finalWidth: 768,
        finalHeight: 1376,
        assetReferenceId: 'asset-ref-output-story',
      },
    });
    expect(migrated.edges.map((edge) => edge.target.nodeId)).toEqual(['output', 'output-story']);
    expect(parseWorkflowGraphV2(JSON.parse(serializeWorkflowGraphV2(migrated))).value).toEqual(migrated);
  });

  it('uses legacy top-level output fields when the first persisted output omits them', () => {
    const source = structuredClone(multipleOutputs) as Record<string, unknown>;
    source.outputAssetId = 'legacy-output-asset';
    source.outputRelativePath = 'generated/legacy-output.png';
    source.outputNodes = [{
      id: 'output',
      name: 'Square',
      finalWidth: 1024,
      finalHeight: 1024,
    }];

    const migrated = migrateWorkflowFileV1(source);

    expect(migrated.nodes.find((node) => node.id === 'output')).toMatchObject({
      position: { x: 850, y: 90 },
      size: { width: 210, height: 232 },
      color: '#3a3c42',
      config: { assetReferenceId: 'asset-ref-output' },
    });
    expect(migrated.assetReferences).toContainEqual({
      id: 'asset-ref-output',
      role: 'output',
      assetId: 'legacy-output-asset',
      relativePath: 'generated/legacy-output.png',
    });
  });

  it('rejects malformed v1 data with path-specific errors', () => {
    expect(() => migrateWorkflowFileV1({ version: 1, name: 'Broken', nodes: 'not-an-array' })).toThrow(
      /nodes must be an array/,
    );
  });

  it('deterministically keeps valid legacy dependencies and drops invalid reverse links', () => {
    const source = structuredClone(assetsStoryboard) as Record<string, unknown>;
    source.connections = [
      { id: 'valid-input', from: 'asset-product', to: 'composition' },
      { id: 'reverse-input', from: 'composition', to: 'asset-product' },
      { id: 'valid-output', from: 'composition', to: 'output' },
      { id: 'reverse-output', from: 'output', to: 'composition' },
      { id: 'missing-node', from: 'missing', to: 'output' },
    ];

    const migrated = migrateWorkflowFileV1(source);

    expect(migrated.edges.map((edge) => edge.id)).toEqual(['valid-input', 'valid-output']);
    expect(() => new WorkflowGraphDomain(migrated)).not.toThrow();
  });

  it('drops legacy links that would duplicate dependencies or form cycles', () => {
    const source = structuredClone(blank) as Record<string, unknown>;
    source.connections = [
      { id: 'forward', from: 'composition', to: 'output' },
      { id: 'duplicate', from: 'composition', to: 'output' },
      { id: 'reverse-cycle', from: 'output', to: 'composition' },
      { id: 'self-cycle', from: 'composition', to: 'composition' },
    ];

    const first = migrateWorkflowFileV1(source);
    const second = migrateWorkflowFileV1(source);

    expect(first.edges.map((edge) => edge.id)).toEqual(['forward']);
    expect(second).toEqual(first);
    expect(() => new WorkflowGraphDomain(first)).not.toThrow();
  });
});
