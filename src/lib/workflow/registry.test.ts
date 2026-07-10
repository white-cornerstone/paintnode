import { describe, expect, it } from 'vitest';
import { WorkflowGraphDomain } from './domain';
import {
  CREATOR_NODE_DEFINITIONS,
  createCreatorNode,
  createCreatorNodeRegistry,
  creatorNodeDefinition,
  validateCreatorNodeConfig,
  type CreatorNodeType,
} from './registry';
import { WORKFLOW_GRAPH_VERSION, type WorkflowGraphV2 } from './schema';

const types: CreatorNodeType[] = ['input', 'brief', 'art-direction', 'transform', 'review', 'output'];

describe('creator node registry', () => {
  it('defines each creator-facing node exactly once with valid metadata, geometry, ports, and defaults', () => {
    expect(CREATOR_NODE_DEFINITIONS.map((definition) => definition.type)).toEqual(types);
    expect(new Set(CREATOR_NODE_DEFINITIONS.map((definition) => definition.type)).size).toBe(types.length);

    for (const definition of CREATOR_NODE_DEFINITIONS) {
      expect(definition.label.trim()).not.toBe('');
      expect(definition.description.trim()).not.toBe('');
      expect(definition.iconKey.trim()).not.toBe('');
      expect(definition.keywords.length).toBeGreaterThan(0);
      expect(definition.defaultSize.width).toBeGreaterThan(0);
      expect(definition.defaultSize.height).toBeGreaterThan(0);
      expect(validateCreatorNodeConfig(definition.type, definition.defaultConfig)).toEqual([]);
      const ports = [...definition.ports.inputs, ...definition.ports.outputs];
      expect(new Set(ports.map((port) => port.id)).size).toBe(ports.length);
      expect(ports.every((port) => port.id.trim() && port.label.trim() && port.dataType !== 'unknown')).toBe(true);
    }
  });

  it('rejects duplicate definitions instead of silently accepting Map last-write-wins behavior', () => {
    const input = creatorNodeDefinition('input');
    expect(() => createCreatorNodeRegistry([input, { ...input, label: 'Duplicate Input' }])).toThrow(
      /duplicate creator node definition: input/i,
    );
  });

  it('creates a framework-independent valid graph from registry defaults without provider palette types', () => {
    const nodes = types.map((type, index) => createCreatorNode(type, {
      id: `node-${type}`,
      position: { x: index * 260, y: 40 },
    }));
    const graph: WorkflowGraphV2 = {
      version: WORKFLOW_GRAPH_VERSION,
      id: 'registry-defaults',
      metadata: { name: 'Registry defaults', sourceVersion: null, migrations: [] },
      viewport: { panX: 0, panY: 0, zoom: 1 },
      nodes,
      edges: [],
      assetReferences: [],
      runRecords: [],
    };

    expect(() => new WorkflowGraphDomain(graph)).not.toThrow();
    expect(JSON.stringify(CREATOR_NODE_DEFINITIONS)).not.toMatch(/codex|antigravity|claude/i);
    expect(creatorNodeDefinition('transform').defaultConfig).toMatchObject({
      capability: 'generate',
      advanced: { provider: null, model: null },
    });
    expect(creatorNodeDefinition('transform').executor).toMatchObject({
      status: 'draft-only',
      capability: 'configured-transform',
      reason: expect.stringMatching(/not available yet/i),
    });
    expect(creatorNodeDefinition('review').executor.status).toBe('draft-only');
  });

  it('validates creator configuration without rejecting deliberately empty readiness fields', () => {
    expect(validateCreatorNodeConfig('brief', { objective: '', guidance: '' })).toEqual([]);
    expect(validateCreatorNodeConfig('transform', { capability: 'generate', instructions: '', advanced: {} })).toEqual([]);
    expect(validateCreatorNodeConfig('transform', { capability: '', advanced: 'codex' })).toEqual([
      expect.objectContaining({ path: 'config.capability' }),
      expect.objectContaining({ path: 'config.advanced' }),
    ]);
    expect(validateCreatorNodeConfig('output', { finalWidth: 0, finalHeight: -1 })).toHaveLength(2);
  });
});
