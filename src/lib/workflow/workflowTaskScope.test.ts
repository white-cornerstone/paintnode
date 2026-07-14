import { describe, expect, it } from 'vitest';
import { instantiateWorkflowTemplate } from './templates';
import { workflowTaskUpstreamNodeIds } from './workflowTaskScope';

describe('workflow background task scope', () => {
  it('includes the target and every transitive upstream input without locking siblings', () => {
    const graph = instantiateWorkflowTemplate('campaign-composer');

    expect(workflowTaskUpstreamNodeIds(graph, ['output-square'])).toEqual([
      'slot-product',
      'slot-subject',
      'slot-style',
      'brief',
      'composition',
      'transform-generate-square',
      'review-campaign-direction',
      'transform-format-square',
      'output-square',
    ]);
    expect(workflowTaskUpstreamNodeIds(graph, ['output-square'])).not.toContain('output-portrait');
  });

  it('ignores missing roots and returns graph-order deterministic ids', () => {
    const graph = instantiateWorkflowTemplate('campaign-composer');
    expect(workflowTaskUpstreamNodeIds(graph, ['missing', 'composition'])).toEqual([
      'slot-product', 'slot-subject', 'slot-style', 'brief', 'composition',
    ]);
  });
});
