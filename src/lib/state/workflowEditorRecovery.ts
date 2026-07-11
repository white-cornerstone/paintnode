import { workflowSha256Bytes } from '../workflow/provenance';

export type WorkflowEditorRecoveryStatus =
  | 'source-png'
  | 'layered'
  | 'flattened-from-png'
  | 'layered-with-missing-png';

export async function resolveWorkflowEditorRecovery(options: Readonly<{
  document: null | { relativePath: string; contentHash: string };
  output: { assetReferenceId: string; assetId: string; relativePath: string; contentHash: string };
  readDocument: (relativePath: string) => Promise<Uint8Array>;
  readOutput: (assetId: string) => Promise<{
    assetId: string;
    relativePath: string;
    contentHash: string;
    bytes: Uint8Array;
  }>;
}>): Promise<{ kind: 'ora' | 'png'; bytes: Uint8Array; status: WorkflowEditorRecoveryStatus }> {
  let documentBytes: Uint8Array | null = null;
  let outputBytes: Uint8Array | null = null;
  if (options.document) {
    try {
      documentBytes = await options.readDocument(options.document.relativePath);
    } catch {
      // Missing layered data can recover from the exact flattened output.
    }
    if (documentBytes && workflowSha256Bytes(documentBytes) !== options.document.contentHash) {
      throw new Error('The saved workflow edit has the wrong hash and cannot be recovered automatically.');
    }
  }
  try {
    const material = await options.readOutput(options.output.assetId);
    if (material.assetId !== options.output.assetId
      || material.relativePath !== options.output.relativePath
      || material.contentHash !== options.output.contentHash
      || workflowSha256Bytes(material.bytes) !== options.output.contentHash) {
      throw new Error('The flattened workflow edit has the wrong hash and cannot be recovered automatically.');
    }
    outputBytes = material.bytes;
  } catch (error) {
    if ((error as Error).message.includes('wrong hash')) throw error;
  }
  if (!options.document) {
    if (!outputBytes) throw new Error('The workflow result PNG is missing.');
    return { kind: 'png', bytes: outputBytes, status: 'source-png' };
  }
  if (documentBytes) {
    return {
      kind: 'ora', bytes: documentBytes,
      status: outputBytes ? 'layered' : 'layered-with-missing-png',
    };
  }
  if (outputBytes) return { kind: 'png', bytes: outputBytes, status: 'flattened-from-png' };
  throw new Error('Both the layered workflow edit and its flattened PNG are missing.');
}
