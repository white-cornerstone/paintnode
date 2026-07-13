import { describe, expect, it } from 'vitest';
import { WorkflowGraphDomain } from './domain';
import { parseWorkflowGraphV2, serializeWorkflowGraphV2 } from './schema';
import {
  WORKFLOW_TEMPLATES,
  instantiateWorkflowTemplate,
  type WorkflowTemplateId,
} from './templates';
import { creatorNodeDefinition } from './registry';

const cases: Array<[WorkflowTemplateId, string, number]> = [
  ['blank', 'Blank Workflow', 0],
  ['asset-composition', 'Asset Composition', 1],
  ['campaign-composer', 'Campaign Composer', 3],
];

function goldenHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

describe('workflow templates', () => {
  it.each([
    ['blank', '8b988e92a66fe9ed'],
    ['asset-composition', '4a04c03797d31def'],
    ['campaign-composer', '1e61bfd8a7ad66b9'],
  ] as const)('keeps the exact persisted v2 golden for %s', (id, expectedHash) => {
    const graph = instantiateWorkflowTemplate(id, { graphId: `golden-${id}`, name: `Golden ${id}` });
    expect(goldenHash(JSON.stringify(graph))).toBe(expectedHash);
  });

  it.each(cases)('instantiates a fresh valid %s WorkflowGraph v2', (id, defaultName, outputCount) => {
    const first = instantiateWorkflowTemplate(id);
    const second = instantiateWorkflowTemplate(id);

    expect(() => new WorkflowGraphDomain(first)).not.toThrow();
    expect(first.id).not.toBe(second.id);
    expect(first.nodes).toEqual(second.nodes);
    expect(first.edges).toEqual(second.edges);
    expect(first).not.toBe(second);
    expect(first.version).toBe(2);
    expect(first.metadata).toEqual({ name: defaultName, sourceVersion: null, migrations: [] });
    expect(first.nodes.filter((node) => node.type === 'brief')).toHaveLength(id === 'blank' ? 0 : 1);
    expect(first.nodes.filter((node) => node.type === 'art-direction')).toHaveLength(id === 'blank' ? 0 : 1);
    expect(first.nodes.filter((node) => node.type === 'output')).toHaveLength(outputCount);
    expect(first.nodes.filter((node) => node.type === 'transform')).toHaveLength(id === 'campaign-composer' ? 3 : 0);
    expect(first.nodes.filter((node) => node.type === 'review')).toHaveLength(id === 'campaign-composer' ? 1 : 0);

    const serialized = serializeWorkflowGraphV2(first);
    const parsed = parseWorkflowGraphV2(JSON.parse(serialized));
    expect(parsed.ok).toBe(true);
    expect(parsed.value).toEqual(first);
    const secondParsed = parseWorkflowGraphV2(JSON.parse(serializeWorkflowGraphV2(second)));
    expect(secondParsed.value).toEqual(second);
  });

  it.each(WORKFLOW_TEMPLATES)('keeps $name nodes non-overlapping and fitted in the initial viewport', (template) => {
    const graph = instantiateWorkflowTemplate(template.id);
    for (const [index, left] of graph.nodes.entries()) {
      for (const right of graph.nodes.slice(index + 1)) {
        const overlaps = left.position.x < right.position.x + right.size.width
          && left.position.x + left.size.width > right.position.x
          && left.position.y < right.position.y + right.size.height
          && left.position.y + left.size.height > right.position.y;
        expect(overlaps, `${left.id} overlaps ${right.id}`).toBe(false);
      }
    }
    for (const node of graph.nodes) {
      const left = graph.viewport.panX + node.position.x * graph.viewport.zoom;
      const top = graph.viewport.panY + node.position.y * graph.viewport.zoom;
      const right = left + node.size.width * graph.viewport.zoom;
      const bottom = top + node.size.height * graph.viewport.zoom;
      expect(left, `${node.id} left`).toBeGreaterThanOrEqual(0);
      expect(top, `${node.id} top`).toBeGreaterThanOrEqual(0);
      expect(right, `${node.id} right`).toBeLessThanOrEqual(900);
      expect(bottom, `${node.id} bottom`).toBeLessThanOrEqual(650);
    }
  });

  it('describes named required and optional slots without binding project assets', () => {
    const blank = instantiateWorkflowTemplate('blank');
    const composition = instantiateWorkflowTemplate('asset-composition');
    const campaign = instantiateWorkflowTemplate('campaign-composer');

    expect(blank.nodes).toEqual([]);
    expect(blank.edges).toEqual([]);
    expect(composition.nodes.filter((node) => node.type === 'input').map((node) => [node.title, node.config.required])).toEqual([
      ['Subject', true],
      ['Background', false],
      ['Style Reference', false],
    ]);
    expect(campaign.nodes.filter((node) => node.type === 'input').map((node) => [node.title, node.config.required])).toEqual([
      ['Product', true],
      ['Subject', false],
      ['Style', false],
    ]);
    expect(campaign.nodes.filter((node) => node.type === 'output').map((node) => [
      node.title,
      node.config.finalWidth,
      node.config.finalHeight,
    ])).toEqual([
      ['Square 1:1', 1024, 1024],
      ['Portrait 4:5', 1024, 1280],
      ['Landscape 16:9', 1280, 720],
    ]);
    for (const graph of [blank, composition, campaign]) {
      expect(graph.assetReferences).toEqual([]);
      expect(graph.nodes.filter((node) => node.type === 'input').every((node) => (
        node.config.assetId === null && node.config.relativePath === null
      ))).toBe(true);
    }
  });

  it('uses typed named ports for every template edge', () => {
    for (const definition of WORKFLOW_TEMPLATES) {
      const graph = instantiateWorkflowTemplate(definition.id, { name: `Test ${definition.name}` });
      const domain = new WorkflowGraphDomain(graph);
      expect(graph.metadata.name).toBe(`Test ${definition.name}`);
      expect(domain.graph.edges).toHaveLength(
        definition.id === 'blank'
          ? 0
          : graph.nodes.filter((node) => node.type === 'input').length
            + 1
            + definition.outputs.length
            + (definition.id === 'campaign-composer' ? 4 : 0),
      );
      if (definition.id !== 'blank') {
        expect(domain.graph.nodes.find((node) => node.type === 'brief')?.ports.outputs).toEqual([
          { id: 'prompt', label: 'Brief', dataType: 'prompt' },
        ]);
        expect(domain.graph.nodes.find((node) => node.type === 'art-direction')?.ports.inputs).toEqual([
          { id: 'assets', label: 'Visual inputs', dataType: 'asset-reference', multiple: true },
          { id: 'brief', label: 'Brief', dataType: 'prompt', required: true },
        ]);
      }
      for (const node of graph.nodes) {
        const definition = creatorNodeDefinition(node.type as Exclude<typeof node.type, 'unsupported'>);
        expect(node.ports.inputs.map(({ id, dataType }) => ({ id, dataType }))).toEqual(
          definition.ports.inputs.map(({ id, dataType }) => ({ id, dataType })),
        );
        expect(node.ports.outputs.map(({ id, dataType }) => ({ id, dataType }))).toEqual(
          definition.ports.outputs.map(({ id, dataType }) => ({ id, dataType })),
        );
      }
    }
  });

  it('routes Campaign Composer through concept review and three accepted-direction outputs', () => {
    const graph = instantiateWorkflowTemplate('campaign-composer');
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: { nodeId: 'composition', portId: 'layout' },
        target: { nodeId: 'transform-generate-square', portId: 'source' },
      }),
      expect.objectContaining({
        source: { nodeId: 'transform-generate-square', portId: 'result' },
        target: { nodeId: 'review-campaign-direction', portId: 'candidates' },
      }),
      expect.objectContaining({
        source: { nodeId: 'review-campaign-direction', portId: 'selected' },
        target: { nodeId: 'output-square', portId: 'source' },
      }),
      expect.objectContaining({
        source: { nodeId: 'review-campaign-direction', portId: 'selected' },
        target: { nodeId: 'transform-generate-portrait', portId: 'source' },
      }),
      expect.objectContaining({
        source: { nodeId: 'transform-generate-portrait', portId: 'result' },
        target: { nodeId: 'output-portrait', portId: 'source' },
      }),
      expect.objectContaining({
        source: { nodeId: 'review-campaign-direction', portId: 'selected' },
        target: { nodeId: 'transform-generate-landscape', portId: 'source' },
      }),
      expect.objectContaining({
        source: { nodeId: 'transform-generate-landscape', portId: 'result' },
        target: { nodeId: 'output-landscape', portId: 'source' },
      }),
    ]));
    expect(graph.edges).not.toContainEqual(expect.objectContaining({
      source: { nodeId: 'composition', portId: 'layout' },
      target: { nodeId: 'output-square', portId: 'source' },
    }));
  });

  it('continues to parse and round-trip a pre-Generate v2 Campaign Composer graph', () => {
    const graph = structuredClone(instantiateWorkflowTemplate('campaign-composer'));
    graph.nodes = graph.nodes.filter((node) => node.type !== 'transform' && node.type !== 'review');
    graph.edges = graph.edges.filter((edge) => (
      graph.nodes.some((node) => node.id === edge.source.nodeId)
      && graph.nodes.some((node) => node.id === edge.target.nodeId)
    ));
    for (const outputId of ['output-square', 'output-portrait', 'output-landscape']) {
      graph.edges.push({
        id: `edge-composition-${outputId}`,
        source: { nodeId: 'composition', portId: 'layout' },
        target: { nodeId: outputId, portId: 'source' },
      });
    }
    const parsed = parseWorkflowGraphV2(JSON.parse(serializeWorkflowGraphV2(graph)));
    expect(parsed).toMatchObject({ ok: true, value: graph });
  });
});
