import { describe, expect, it } from 'vitest';
import { workflowDirectorGraphDraftSchema } from '../../../scripts/workflow-director-schema.mjs';

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
});
