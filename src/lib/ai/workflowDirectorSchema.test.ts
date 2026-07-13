import { describe, expect, it } from 'vitest';
import {
  workflowDirectorExtractionSchema,
  workflowDirectorGraphDraftSchema,
  workflowDirectorReviewSchema,
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
    expect(nodeVariants).toHaveLength(7);
    expect(nodeVariants.every((variant: { additionalProperties: boolean }) => variant.additionalProperties === false)).toBe(true);
    expect(nodeVariants.map((variant: { properties: { type: { const: string } } }) => variant.properties.type.const)).toEqual([
      'input', 'brief', 'art-direction', 'extract-assets', 'transform', 'review', 'output',
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
    expect(MANAGED_RUNTIME_PROTOCOL_VERSION).toBe(5);
    expect(MANAGED_RUNTIME_SHARED_BRIDGE_FILES).toEqual(expect.arrayContaining([
      'director-action-schema.mjs',
      'workflow-director-schema.mjs',
      'provider-executable-trust.mjs',
    ]));
    expect(providerRuntimeWorkflow).toContain('default: "5.0.0"');
    expect(providerRuntimeWorkflow).toContain('default: "provider-runtimes-creative-blueprint"');
    expect(providerRuntimeWorkflow).toContain('confirm_production_publish');
    expect(providerRuntimeWorkflow).toContain('Production runtime publication requires explicit confirmation');
    expect(providerRuntimeWorkflow).toContain('needs: release-target');
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
    const addNode = variants.find((variant: { properties: { op: { const: string } } }) => variant.properties.op.const === 'add-node') as
      { properties: { node: { anyOf: Array<{ properties: { type: { const: string } } }> } } };
    expect(addNode.properties.node.anyOf.map((node) => node.properties.type.const)).toContain('extract-assets');
    const configureNode = variants.find((variant: { properties: { op: { const: string } } }) => variant.properties.op.const === 'configure-node') as
      { properties: { changes: { anyOf: Array<{ properties: Record<string, unknown> }> } } };
    expect(configureNode.properties.changes.anyOf.some((config) => (
      'prompt' in config.properties && 'mode' in config.properties && 'assetsPerSheet' in config.properties
    ))).toBe(true);
  });

  it('defines a strict structured-output schema for asset extraction plans', () => {
    expect(workflowDirectorExtractionSchema.additionalProperties).toBe(false);
    expect(workflowDirectorExtractionSchema.required).toEqual(['version', 'items', 'notes']);
    expect(workflowDirectorExtractionSchema.properties.version.const).toBe(1);
    expect(workflowDirectorExtractionSchema.properties.items.minItems).toBe(1);
    expect(workflowDirectorExtractionSchema.properties.items.maxItems).toBe(32);
    expect(workflowDirectorExtractionSchema.properties.items.items.additionalProperties).toBe(false);
    expect(workflowDirectorExtractionSchema.properties.items.items.required).toEqual([
      'id', 'name', 'instruction',
    ]);
    expect(workflowDirectorExtractionSchema.properties.notes.maxLength).toBe(4000);
  });

  it('defines a strict structured-output schema for candidate reviews', () => {
    expect(workflowDirectorReviewSchema.additionalProperties).toBe(false);
    expect(workflowDirectorReviewSchema.required).toEqual(['rankings', 'recommendedCandidateId']);
    expect(workflowDirectorReviewSchema.properties.rankings.minItems).toBe(1);
    expect(workflowDirectorReviewSchema.properties.rankings.maxItems).toBe(64);
    expect(workflowDirectorReviewSchema.properties.rankings.items.additionalProperties).toBe(false);
    expect(workflowDirectorReviewSchema.properties.rankings.items.required).toEqual(['candidateId', 'reason']);
    expect(workflowDirectorReviewSchema.properties.rankings.items.properties.reason.maxLength).toBe(1000);
  });
});
