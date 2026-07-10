import { describe, expect, it } from 'vitest';
// The production runners share this JavaScript schema directly.
import { directorActionSchema } from '../../../scripts/director-action-schema.mjs';

describe('Director action schema', () => {
  it('keeps SDK and app-mediated actions in one closed schema', () => {
    expect(directorActionSchema.additionalProperties).toBe(false);
    expect(directorActionSchema.properties.action.enum).toEqual([
      'generateCandidate',
      'acceptResult',
      'requestUserInput',
      'fail',
    ]);
    expect(directorActionSchema.required).toContain('question');
    expect(directorActionSchema.required).toContain('allowCustom');
  });
});
