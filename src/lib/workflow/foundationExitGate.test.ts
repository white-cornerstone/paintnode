import { describe, expect, it } from 'vitest';
import { WorkflowGraphDomain } from './domain';
import {
  affectedWorkflowNodes,
  planWorkflowExecution,
  WorkflowExecutionRuntime,
  type WorkflowExecutionPlan,
} from './execution';
import { parseWorkflowGraphV2, serializeWorkflowGraphV2, type WorkflowGraphV2 } from './schema';
import { instantiateWorkflowTemplate } from './templates';

describe('Creative Blueprint Foundation exit gate', () => {
  it('round-trips, plans, completes, and precisely stales the production Campaign Composer graph', () => {
    const instantiated = instantiateWorkflowTemplate('campaign-composer', {
      graphId: 'workflow-foundation-exit-gate',
    });
    const serialized = serializeWorkflowGraphV2(instantiated);
    const parsed = parseWorkflowGraphV2(JSON.parse(serialized));

    expect(parsed).toMatchObject({ ok: true, issues: [] });
    const domain = new WorkflowGraphDomain(parsed.value!);
    const graph = domain.graph;
    expect(domain.serialize()).toBe(serialized);
    expect(serializeWorkflowGraphV2(graph)).toBe(serialized);

    const roots = ['slot-product', 'slot-subject', 'slot-style', 'brief'];
    const outputIds = ['output-square', 'output-portrait', 'output-landscape'];
    const plans = new Map<string, WorkflowExecutionPlan>();
    for (const outputId of outputIds) {
      const first = planWorkflowExecution(graph, outputId, { maxConcurrency: 4 });
      const second = planWorkflowExecution(graph, outputId, { maxConcurrency: 4 });
      expect(first).toEqual(second);
      const squareTransform = outputId === 'output-square' ? ['transform-generate-square'] : [];
      expect(first).toEqual({
        targetNodeId: outputId,
        requiredNodeIds: [...roots, 'composition', ...squareTransform, outputId],
        cachedNodeIds: [],
        executionOrder: [...roots, 'composition', ...squareTransform, outputId],
        batches: [roots, ['composition'], ...squareTransform.map((nodeId) => [nodeId]), [outputId]],
        blocked: [],
      });
      plans.set(outputId, first);
    }

    function completeCampaignRuntime(input: WorkflowGraphV2): WorkflowExecutionRuntime {
      const runtime = new WorkflowExecutionRuntime(input, {
        clock: (() => {
          let tick = 100;
          return () => tick++;
        })(),
        runIdGenerator: (nodeId, attempt) => `run-${nodeId}-${attempt}`,
      });
      const sharedBatches = plans.get('output-square')!.batches.slice(0, -1);
      for (const batch of [...sharedBatches, outputIds]) {
        for (const nodeId of batch) {
          expect(runtime.node(nodeId).state).toBe('ready');
          runtime.start(nodeId);
          runtime.succeed(nodeId, {
            cacheKey: `cache-${nodeId}`,
            outputIds: [`result-${nodeId}`],
          });
        }
      }
      expect(graph.nodes.map((node) => runtime.node(node.id).state)).toEqual(
        graph.nodes.map(() => 'succeeded'),
      );
      return runtime;
    }

    const productRuntime = completeCampaignRuntime(graph);
    const productAffected = [
      'slot-product',
      'composition',
      'transform-generate-square',
      'output-square',
      'output-portrait',
      'output-landscape',
    ];
    expect(affectedWorkflowNodes(graph, ['slot-product'])).toEqual(productAffected);
    expect(productRuntime.invalidateMaterialChange('slot-product')).toEqual(productAffected);
    expect(productAffected.map((nodeId) => productRuntime.node(nodeId).state)).toEqual(
      productAffected.map(() => 'stale'),
    );
    expect(['brief', 'slot-subject', 'slot-style'].map((nodeId) => productRuntime.node(nodeId).state)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);

    const outputRuntime = completeCampaignRuntime(graph);
    expect(affectedWorkflowNodes(graph, ['output-portrait'])).toEqual(['output-portrait']);
    expect(outputRuntime.invalidateMaterialChange('output-portrait')).toEqual(['output-portrait']);
    expect(outputRuntime.node('output-portrait').state).toBe('stale');
    const unaffectedOutputStates = graph.nodes
      .filter((node) => node.id !== 'output-portrait')
      .map((node) => outputRuntime.node(node.id).state);
    expect(unaffectedOutputStates).toEqual(
      graph.nodes.filter((node) => node.id !== 'output-portrait').map(() => 'succeeded'),
    );
  });
});
