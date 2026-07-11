import { describe, expect, it } from 'vitest';
import { workflowSha256Bytes } from '../workflow/provenance';
import { resolveWorkflowEditorRecovery } from './workflowEditorRecovery';

const ora = new Uint8Array([1, 2, 3]);
const png = new Uint8Array([137, 80, 78, 71]);
const descriptor = {
  document: { relativePath: 'documents/edit.ora', contentHash: workflowSha256Bytes(ora) },
  output: {
    assetReferenceId: 'ref-edit', assetId: 'asset-edit', relativePath: 'assets/edit.png',
    contentHash: workflowSha256Bytes(png),
  },
};

function readers(options: { ora?: Uint8Array; png?: Uint8Array }) {
  return {
    readDocument: async () => {
      if (!options.ora) throw new Error('missing ORA');
      return options.ora;
    },
    readOutput: async () => {
      if (!options.png) throw new Error('missing PNG');
      return {
        assetId: descriptor.output.assetId,
        relativePath: descriptor.output.relativePath,
        contentHash: descriptor.output.contentHash,
        bytes: options.png,
      };
    },
  };
}

describe('workflow editor recovery', () => {
  it('reconstructs a flattened document when ORA is missing and exact PNG exists', async () => {
    await expect(resolveWorkflowEditorRecovery({ ...descriptor, ...readers({ png }) }))
      .resolves.toEqual({ kind: 'png', bytes: png, status: 'flattened-from-png' });
  });

  it('opens exact ORA for repair when PNG is missing', async () => {
    await expect(resolveWorkflowEditorRecovery({ ...descriptor, ...readers({ ora }) }))
      .resolves.toEqual({ kind: 'ora', bytes: ora, status: 'layered-with-missing-png' });
  });

  it('blocks when both artifacts are missing', async () => {
    await expect(resolveWorkflowEditorRecovery({ ...descriptor, ...readers({}) }))
      .rejects.toThrow(/both.*missing/i);
  });

  it.each([
    [{ ora: new Uint8Array([9]), png }, /wrong hash/i],
    [{ ora, png: new Uint8Array([9]) }, /wrong hash/i],
  ])('blocks hash mismatches instead of silently substituting', async (artifacts, message) => {
    await expect(resolveWorkflowEditorRecovery({ ...descriptor, ...readers(artifacts) }))
      .rejects.toThrow(message);
  });
});
