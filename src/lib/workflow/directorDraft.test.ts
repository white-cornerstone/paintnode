import { describe, expect, it, vi } from 'vitest';
import { creatorNodeDefinition } from './registry';
import { instantiateWorkflowTemplate } from './templates';
import {
  buildWorkflowDirectorContext,
  createWorkflowDirectorProposal,
  draftWorkflowWithDirector,
  isCampaignRequirementsEquivalent,
  type WorkflowDirectorContext,
  type WorkflowDirectorGraphDraft,
} from './directorDraft';

const campaignAssets = [
  {
    id: 'asset-product',
    name: 'Bottle.png',
    kind: 'imported',
    mime: 'image/png',
    width: 1600,
    height: 1600,
    exists: true,
    relativePath: 'imports/Bottle.png',
    previewDataUrl: 'data:image/png;base64,secret',
    prompt: 'private prompt that must not cross the boundary',
  },
];

const campaignOutputs = [
  { id: 'square', name: 'Square 1:1', width: 1024, height: 1024 },
  { id: 'portrait', name: 'Portrait 4:5', width: 1024, height: 1280 },
  { id: 'landscape', name: 'Landscape 16:9', width: 1280, height: 720 },
];

function context(): WorkflowDirectorContext {
  return buildWorkflowDirectorContext({
    brief: 'Build a coordinated product campaign for launch week.',
    assets: campaignAssets,
    requestedOutputs: campaignOutputs,
    capabilities: [
      { id: 'generate', available: true, reason: null },
      { id: 'candidate-review', available: false, reason: 'Review execution is not available yet.' },
    ],
  });
}

function campaignDraft(): WorkflowDirectorGraphDraft {
  return {
    version: 1,
    name: 'Launch Campaign',
    summary: 'Product-led square generation with coordinated portrait and landscape delivery.',
    nodes: [
      { id: 'product', type: 'input', title: 'Product', assetId: 'asset-product', role: 'Hero product', required: true },
      { id: 'subject', type: 'input', title: 'Subject', assetId: null, role: 'Optional person', required: false },
      { id: 'style', type: 'input', title: 'Style', assetId: null, role: 'Optional brand style', required: false },
      {
        id: 'brief',
        type: 'brief',
        title: 'Campaign Brief',
        objective: 'Build a cohesive campaign family around the product for multiple publishing formats.',
        guidance: 'Keep the product recognisable.',
      },
      {
        id: 'composition',
        type: 'art-direction',
        title: 'Art Direction',
        prompt: 'Keep product identity and brand cues consistent while adapting composition to each format.',
      },
      {
        id: 'generate-square',
        type: 'transform',
        title: 'Generate Square',
        capability: 'generate',
        instructions: 'Generate the square campaign result.',
      },
      { id: 'square', type: 'output', title: 'Square 1:1', width: 1024, height: 1024 },
      { id: 'portrait', type: 'output', title: 'Portrait 4:5', width: 1024, height: 1280 },
      { id: 'landscape', type: 'output', title: 'Landscape 16:9', width: 1280, height: 720 },
    ],
    edges: [
      { id: 'product-composition', source: { nodeId: 'product', portId: 'asset' }, target: { nodeId: 'composition', portId: 'assets' } },
      { id: 'subject-composition', source: { nodeId: 'subject', portId: 'asset' }, target: { nodeId: 'composition', portId: 'assets' } },
      { id: 'style-composition', source: { nodeId: 'style', portId: 'asset' }, target: { nodeId: 'composition', portId: 'assets' } },
      { id: 'brief-composition', source: { nodeId: 'brief', portId: 'prompt' }, target: { nodeId: 'composition', portId: 'brief' } },
      { id: 'composition-generate', source: { nodeId: 'composition', portId: 'layout' }, target: { nodeId: 'generate-square', portId: 'source' } },
      { id: 'generate-square-output', source: { nodeId: 'generate-square', portId: 'result' }, target: { nodeId: 'square', portId: 'source' } },
      { id: 'composition-portrait', source: { nodeId: 'composition', portId: 'layout' }, target: { nodeId: 'portrait', portId: 'source' } },
      { id: 'composition-landscape', source: { nodeId: 'composition', portId: 'layout' }, target: { nodeId: 'landscape', portId: 'source' } },
    ],
  };
}

describe('Workflow Director context boundary', () => {
  it('sends only detached registry, asset metadata, requested outputs, and capability availability', () => {
    const value = context();
    expect(Object.keys(value).sort()).toEqual([
      'assets',
      'brief',
      'capabilities',
      'registry',
      'requestedOutputs',
      'version',
    ]);
    expect(value.assets).toEqual([{
      id: 'asset-product',
      name: 'Bottle.png',
      kind: 'imported',
      mime: 'image/png',
      width: 1600,
      height: 1600,
      available: true,
    }]);
    expect(JSON.stringify(value)).not.toMatch(/relativePath|previewDataUrl|private prompt|runRecord|viewport|provider/i);
    expect(value.registry.map((item) => item.type)).toEqual([
      'input', 'brief', 'art-direction', 'transform', 'review', 'output',
    ]);
    for (const item of value.registry) {
      const definition = creatorNodeDefinition(item.type);
      expect(item.inputs).toEqual(definition.ports.inputs.map(({ id, label, dataType, required, multiple }) => ({
        id, label, dataType, required: required === true, multiple: multiple === true,
      })));
      expect(item.outputs).toEqual(definition.ports.outputs.map(({ id, label, dataType, required, multiple }) => ({
        id, label, dataType, required: required === true, multiple: multiple === true,
      })));
    }
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.registry[0].outputs)).toBe(true);
    expect(() => {
      (value.assets[0] as { name: string }).name = 'mutated';
    }).toThrow(TypeError);
    expect(campaignAssets[0].name).toBe('Bottle.png');
  });
});

describe('GraphDraft v1 schema and validation', () => {
  it('materializes a fresh ordinary v2 graph with registry-owned ports and no provider/runtime payload', () => {
    const result = createWorkflowDirectorProposal(campaignDraft(), context(), { graphId: 'director-campaign' });
    expect(result.schemaIssues).toEqual([]);
    expect(result.proposal?.canAccept).toBe(true);
    expect(result.proposal?.issues).toEqual([]);
    expect(result.proposal?.unsupportedCapabilities).toEqual([]);
    expect(result.proposal?.graph).toMatchObject({
      version: 2,
      id: 'director-campaign',
      metadata: { name: 'Launch Campaign', sourceVersion: null, migrations: [] },
      assetReferences: [],
      runRecords: [],
    });
    for (const node of result.proposal!.graph.nodes) {
      const definition = creatorNodeDefinition(node.type as Exclude<typeof node.type, 'unsupported'>);
      expect(node.ports).toEqual(definition.ports);
      expect(node.runRecordIds).toEqual([]);
      expect(JSON.stringify(node.config)).not.toMatch(/runRecord|rawConfig/i);
      if (node.type === 'transform') {
        expect(node.config.advanced).toEqual({ provider: null, model: null, options: {} });
      }
    }
  });

  it.each([
    ['top-level geometry', (draft: Record<string, unknown>) => Object.assign(draft, { viewport: { zoom: 9 } })],
    ['node position', (draft: Record<string, unknown>) => Object.assign((draft.nodes as Record<string, unknown>[])[0], { position: { x: 1, y: 2 } })],
    ['node size and color', (draft: Record<string, unknown>) => Object.assign((draft.nodes as Record<string, unknown>[])[0], { size: { width: 1, height: 1 }, color: '#fff' })],
    ['run records', (draft: Record<string, unknown>) => Object.assign(draft, { runRecords: [{ id: 'smuggled' }] })],
    ['raw config', (draft: Record<string, unknown>) => Object.assign((draft.nodes as Record<string, unknown>[])[0], { config: { provider: 'codex' } })],
    ['provider node', (draft: Record<string, unknown>) => Object.assign((draft.nodes as Record<string, unknown>[])[0], { type: 'codex' })],
  ])('rejects %s instead of silently discarding it', (_name, mutate) => {
    const draft = structuredClone(campaignDraft()) as unknown as Record<string, unknown>;
    mutate(draft);
    const result = createWorkflowDirectorProposal(draft, context());
    expect(result.proposal).toBeNull();
    expect(result.schemaIssues.some((issue) => issue.message.match(/not allowed|creator node type/i))).toBe(true);
  });

  it('rejects wrong named ports, cycles, duplicate ids, and missing required connections', () => {
    const wrongPort = structuredClone(campaignDraft());
    wrongPort.edges[0].source.portId = 'image';
    expect(createWorkflowDirectorProposal(wrongPort, context()).proposal?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'connection', code: 'SOURCE_PORT_NOT_FOUND' }),
    ]));

    const cycle = structuredClone(campaignDraft());
    cycle.edges.push({
      id: 'cycle',
      source: { nodeId: 'generate-square', portId: 'result' },
      target: { nodeId: 'composition', portId: 'assets' },
    });
    expect(createWorkflowDirectorProposal(cycle, context()).proposal?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'connection' }),
    ]));

    const duplicate = structuredClone(campaignDraft());
    duplicate.nodes[1].id = 'product';
    expect(createWorkflowDirectorProposal(duplicate, context()).proposal?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'domain', code: 'DUPLICATE_NODE_ID' }),
    ]));

    const missingBrief = structuredClone(campaignDraft());
    missingBrief.edges = missingBrief.edges.filter((edge) => edge.id !== 'brief-composition');
    expect(createWorkflowDirectorProposal(missingBrief, context()).proposal?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: 'readiness', code: 'MISSING_REQUIRED_INPUT' }),
    ]));
  });

  it('previews unsupported capabilities but prevents acceptance', () => {
    const draft = campaignDraft();
    const transform = draft.nodes.find((node) => node.type === 'transform')!;
    if (transform.type === 'transform') transform.capability = 'relight';
    const result = createWorkflowDirectorProposal(draft, context());
    expect(result.proposal).not.toBeNull();
    expect(result.proposal?.canAccept).toBe(false);
    expect(result.proposal?.unsupportedCapabilities).toEqual([{
      capability: 'relight',
      nodeId: 'generate-square',
      reason: 'This capability was not included in PaintNode capability availability.',
    }]);
    expect(result.proposal?.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Hero product', status: 'ready' }),
      expect.objectContaining({ label: 'relight', status: 'unsupported' }),
    ]));
  });
});

describe('Workflow Director orchestration', () => {
  it('uses only the injected Director and never performs discovery or authentication', async () => {
    const director = { draft: vi.fn().mockResolvedValue(campaignDraft()) };
    const result = await draftWorkflowWithDirector(director, context(), { graphId: 'fake-director' });
    expect(director.draft).toHaveBeenCalledOnce();
    expect(director.draft).toHaveBeenCalledWith(context());
    expect(result.proposal?.graph.id).toBe('fake-director');
    expect(result.proposal?.canAccept).toBe(true);
  });

  it('does not partially construct a proposal when the injected response is malformed', async () => {
    const director = { draft: vi.fn().mockResolvedValue({ version: 1, name: 'Bad', nodes: 'not-an-array' }) };
    const result = await draftWorkflowWithDirector(director, context());
    expect(result.proposal).toBeNull();
    expect(result.schemaIssues.length).toBeGreaterThan(0);
  });
});

describe('Campaign requirements equivalence', () => {
  it('compares creator requirements, topology, typed named ports, and supported capability semantics—not geometry', () => {
    const proposal = createWorkflowDirectorProposal(campaignDraft(), context(), { graphId: 'campaign-equivalent' }).proposal!;
    const template = instantiateWorkflowTemplate('campaign-composer', { graphId: 'campaign-template' });
    expect(isCampaignRequirementsEquivalent(proposal.graph, template)).toEqual({ equivalent: true, differences: [] });

    const moved = structuredClone(proposal.graph);
    moved.nodes.forEach((node, index) => {
      node.position = { x: 10_000 + index, y: -500 - index };
      node.size = { width: 999, height: 888 };
      node.color = '#abcdef';
    });
    expect(isCampaignRequirementsEquivalent(moved, template).equivalent).toBe(true);

    const missingProductRequirement = structuredClone(proposal.graph);
    missingProductRequirement.nodes.find((node) => node.title === 'Product')!.config.required = false;
    expect(isCampaignRequirementsEquivalent(missingProductRequirement, template)).toMatchObject({
      equivalent: false,
      differences: expect.arrayContaining([expect.stringMatching(/Product.*required/i)]),
    });
  });
});
