const shortText = { type: 'string', minLength: 1, maxLength: 160 };
const longText = { type: 'string', minLength: 1, maxLength: 2000 };
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
