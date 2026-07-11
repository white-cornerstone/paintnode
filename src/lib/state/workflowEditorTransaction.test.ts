import { describe, expect, it } from 'vitest';
import { commitWorkflowEditorReturnTransaction } from './workflowEditorTransaction';

describe('workflow editor return transaction', () => {
  it('rolls back every written artifact when the graph changes during the native promise', async () => {
    let graphRevision = 1;
    const openedRevision = graphRevision;
    const files = new Set<string>();
    const manifest = new Set<string>();

    await expect(commitWorkflowEditorReturnTransaction({
      preflight: () => {
        if (graphRevision !== openedRevision) throw new Error('Workflow changed while artifacts were writing.');
      },
      writeArtifacts: async () => {
        files.add('edit.ora');
        files.add('edit.png');
        manifest.add('asset-edit');
        graphRevision += 1;
        return { files: ['edit.ora', 'edit.png'], assetId: 'asset-edit' };
      },
      commitGraph: () => 'linked',
      rollbackArtifacts: async (artifacts) => {
        artifacts.files.forEach((file) => files.delete(file));
        manifest.delete(artifacts.assetId);
      },
    })).rejects.toThrow(/workflow changed/i);

    expect(files.size).toBe(0);
    expect(manifest.size).toBe(0);
  });
});
