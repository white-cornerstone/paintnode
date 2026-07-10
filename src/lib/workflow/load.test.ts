import { describe, expect, it } from 'vitest';
import blank from './fixtures/v1/blank.json';
import { readWorkflowGraph } from './load';
import { migrateWorkflowFileV1 } from './migration';

describe('workflow graph loading', () => {
  it('returns migrated v1 data without mutating or implicitly saving the source', () => {
    const source = structuredClone(blank);
    const result = readWorkflowGraph(source);

    expect(result.ok).toBe(true);
    expect(result.sourceVersion).toBe(1);
    expect(result.requiresExplicitSave).toBe(true);
    expect(result.graph).toEqual(migrateWorkflowFileV1(blank));
    expect(source).toEqual(blank);
  });

  it('returns valid v2 data without marking it for migration save', () => {
    const graph = migrateWorkflowFileV1(blank);
    const result = readWorkflowGraph(graph);

    expect(result.ok).toBe(true);
    expect(result.sourceVersion).toBe(2);
    expect(result.requiresExplicitSave).toBe(false);
    expect(result.graph).toEqual(graph);
  });

  it('returns recoverable path-specific issues for malformed or unsupported data', () => {
    const malformed = readWorkflowGraph({ version: 1, nodes: 'broken' });
    const unsupported = readWorkflowGraph({ version: 7 });

    expect(malformed).toMatchObject({
      ok: false,
      sourceVersion: 1,
      issues: [{ path: 'nodes', severity: 'error' }],
    });
    expect(unsupported).toMatchObject({
      ok: false,
      sourceVersion: 7,
      issues: [{ path: 'version', severity: 'error' }],
    });
  });
});
