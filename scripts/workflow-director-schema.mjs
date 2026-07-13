const shortText = { type: 'string', minLength: 1, maxLength: 160 };
const longText = { type: 'string', minLength: 1, maxLength: 2000 };
const editableText = { type: 'string', maxLength: 2000 };
const id = { type: 'string', minLength: 1, maxLength: 64 };

/**
 * @param {string} type
 * @param {Record<string, unknown>} properties
 * @param {string[]} required
 */
function strictNode(type, properties, required) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id,
      type: { type: 'string', const: type },
      title: shortText,
      ...properties,
    },
    required: ['id', 'type', 'title', ...required],
  };
}

const endpoint = {
  type: 'object',
  additionalProperties: false,
  properties: { nodeId: id, portId: id },
  required: ['nodeId', 'portId'],
};

export const workflowDirectorGraphDraftSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'integer', const: 1 },
    name: shortText,
    summary: longText,
    nodes: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      items: {
        anyOf: [
          strictNode('input', {
            assetId: { anyOf: [id, { type: 'null' }] },
            role: { type: 'string', minLength: 1, maxLength: 500 },
            required: { type: 'boolean' },
          }, ['assetId', 'role', 'required']),
          strictNode('brief', { objective: longText, guidance: longText }, ['objective', 'guidance']),
          strictNode('art-direction', { prompt: longText }, ['prompt']),
          strictNode('transform', {
            capability: { type: 'string', minLength: 1, maxLength: 80 },
            instructions: longText,
          }, ['capability', 'instructions']),
          strictNode('review', {
            mode: { type: 'string', enum: ['human', 'ai'] },
            instructions: longText,
          }, ['mode', 'instructions']),
          strictNode('output', {
            width: { type: 'integer', minimum: 64, maximum: 16384 },
            height: { type: 'integer', minimum: 64, maximum: 16384 },
          }, ['width', 'height']),
        ],
      },
    },
    edges: {
      type: 'array',
      maxItems: 128,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { id, source: endpoint, target: endpoint },
        required: ['id', 'source', 'target'],
      },
    },
  },
  required: ['version', 'name', 'summary', 'nodes', 'edges'],
};

const point = {
  type: 'object',
  additionalProperties: false,
  properties: {
    x: { type: 'number' },
    y: { type: 'number' },
  },
  required: ['x', 'y'],
};

/** @param {Record<string, unknown>} properties */
function strictConfig(properties) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  };
}

const inputConfig = strictConfig({
  assetId: { anyOf: [id, { type: 'null' }] },
  role: { type: 'string', maxLength: 500 },
  required: { type: 'boolean' },
});
const briefConfig = strictConfig({ objective: editableText, guidance: editableText });
const artDirectionConfig = strictConfig({ prompt: editableText });
const transformConfig = strictConfig({
  capability: { type: 'string', minLength: 1, maxLength: 80 },
  instructions: editableText,
});
const reviewConfig = strictConfig({
  mode: { type: 'string', enum: ['human', 'ai'] },
  instructions: editableText,
});
const outputConfig = strictConfig({
  finalWidth: { type: 'integer', minimum: 64, maximum: 16384 },
  finalHeight: { type: 'integer', minimum: 64, maximum: 16384 },
});
const authoringConfig = {
  anyOf: [inputConfig, briefConfig, artDirectionConfig, transformConfig, reviewConfig, outputConfig],
};

/**
 * @param {string} type
 * @param {Record<string, unknown>} config
 */
function strictPatchNode(type, config) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: { id, type: { type: 'string', const: type }, title: shortText, position: point, config },
    required: ['id', 'type', 'title', 'position', 'config'],
  };
}

const patchNode = {
  anyOf: [
    strictPatchNode('input', inputConfig),
    strictPatchNode('brief', briefConfig),
    strictPatchNode('art-direction', artDirectionConfig),
    strictPatchNode('transform', transformConfig),
    strictPatchNode('review', reviewConfig),
    strictPatchNode('output', outputConfig),
  ],
};

const revisionOperation = {
  anyOf: [
    {
      type: 'object', additionalProperties: false,
      properties: { op: { type: 'string', const: 'add-node' }, node: patchNode },
      required: ['op', 'node'],
    },
    {
      type: 'object', additionalProperties: false,
      properties: { op: { type: 'string', const: 'remove-node' }, nodeId: id },
      required: ['op', 'nodeId'],
    },
    {
      type: 'object', additionalProperties: false,
      properties: { op: { type: 'string', const: 'configure-node' }, nodeId: id, changes: authoringConfig },
      required: ['op', 'nodeId', 'changes'],
    },
    {
      type: 'object', additionalProperties: false,
      properties: { op: { type: 'string', const: 'move-node' }, nodeId: id, position: point },
      required: ['op', 'nodeId', 'position'],
    },
    {
      type: 'object', additionalProperties: false,
      properties: {
        op: { type: 'string', const: 'add-edge' },
        edge: {
          type: 'object', additionalProperties: false,
          properties: { id, source: endpoint, target: endpoint },
          required: ['id', 'source', 'target'],
        },
      },
      required: ['op', 'edge'],
    },
    {
      type: 'object', additionalProperties: false,
      properties: { op: { type: 'string', const: 'remove-edge' }, edgeId: id },
      required: ['op', 'edgeId'],
    },
  ],
};

export const workflowDirectorRevisionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'integer', const: 1 },
    sourceGraphRevision: {
      type: 'object',
      additionalProperties: false,
      properties: { graphId: id, revision: { type: 'integer', minimum: 0 } },
      required: ['graphId', 'revision'],
    },
    summary: longText,
    operations: { type: 'array', maxItems: 128, items: revisionOperation },
  },
  required: ['version', 'sourceGraphRevision', 'summary', 'operations'],
};

export const workflowDirectorExtractionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    version: { type: 'integer', const: 1 },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 160 },
          name: shortText,
          instruction: longText,
        },
        required: ['id', 'name', 'instruction'],
      },
    },
    notes: { type: 'string', maxLength: 4000 },
  },
  required: ['version', 'items', 'notes'],
};
