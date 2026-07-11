import { describe, expect, it } from 'vitest';
import {
  workflowDirectorGraphDraftSchema,
  workflowDirectorRevisionSchema,
} from '../../../scripts/workflow-director-schema.mjs';
import providerRuntimeWorkflow from '../../../.github/workflows/provider-runtimes.yml?raw';
import {
  MANAGED_RUNTIME_PROTOCOL_VERSION,
  MANAGED_RUNTIME_SHARED_BRIDGE_FILES,
} from '../../../scripts/managed-runtime-package-contract.mjs';

describe('Workflow Director GraphDraft schema', () => {
  it('is strict at the graph, node, edge, and endpoint boundaries', () => {
    expect(workflowDirectorGraphDraftSchema.additionalProperties).toBe(false);
    expect(workflowDirectorGraphDraftSchema.required).toEqual(['version', 'name', 'summary', 'nodes', 'edges']);
    expect(workflowDirectorGraphDraftSchema.properties.version.const).toBe(1);
    const nodeVariants = workflowDirectorGraphDraftSchema.properties.nodes.items.anyOf;
    expect(nodeVariants).toHaveLength(6);
    expect(nodeVariants.every((variant: { additionalProperties: boolean }) => variant.additionalProperties === false)).toBe(true);
    expect(nodeVariants.map((variant: { properties: { type: { const: string } } }) => variant.properties.type.const)).toEqual([
      'input', 'brief', 'art-direction', 'transform', 'review', 'output',
    ]);
    const review = nodeVariants.find((variant: { properties: { type: { const: string } } }) => variant.properties.type.const === 'review') as
      | { properties: { mode: { enum: string[] } } }
      | undefined;
    expect(review).toBeDefined();
    expect(review?.properties.mode.enum).toEqual(['human', 'ai']);
    expect(workflowDirectorGraphDraftSchema.properties.edges.items.additionalProperties).toBe(false);
    expect(workflowDirectorGraphDraftSchema.properties.edges.items.properties.source.additionalProperties).toBe(false);
  });

  it('versions and packages every shared schema dependency required by managed runners', () => {
    expect(MANAGED_RUNTIME_PROTOCOL_VERSION).toBe(4);
    expect(MANAGED_RUNTIME_SHARED_BRIDGE_FILES).toEqual(expect.arrayContaining([
      'director-action-schema.mjs',
      'workflow-director-schema.mjs',
      'provider-executable-trust.mjs',
    ]));
    expect(providerRuntimeWorkflow).toContain('default: "4.0.0"');
  });

  it('defines a strict structured-output schema for current-workflow revisions', () => {
    expect(workflowDirectorRevisionSchema.additionalProperties).toBe(false);
    expect(workflowDirectorRevisionSchema.required).toEqual([
      'version', 'sourceGraphRevision', 'summary', 'operations',
    ]);
    expect(workflowDirectorRevisionSchema.properties.sourceGraphRevision.additionalProperties).toBe(false);
    const variants = workflowDirectorRevisionSchema.properties.operations.items.anyOf;
    expect(variants).toHaveLength(6);
    expect(variants.every((variant: { additionalProperties: boolean }) => variant.additionalProperties === false)).toBe(true);
    expect(variants.map((variant: { properties: { op: { const: string } } }) => variant.properties.op.const)).toEqual([
      'add-node', 'remove-node', 'configure-node', 'move-node', 'add-edge', 'remove-edge',
    ]);
  });
});
