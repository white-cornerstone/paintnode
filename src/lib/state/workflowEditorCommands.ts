import { PaintDocument } from '../engine/Document.svelte';
import { Layer } from '../engine/Layer.svelte';
import { compositeToCanvas } from '../engine/compositor';
import { readProjectFile, resolveProjectAssetMaterial } from '../integrations/desktop';
import { bytesToBitmap, canvasToPngBytes } from '../io';
import { loadOra } from '../ora/load';
import { saveOra } from '../ora/save';
import { workflowResultDocumentSourceKey } from './documentSource';
import { editor, type DocumentSession } from './editor.svelte';
import { project } from './project.svelte';
import { workflow } from './workflow.svelte';
import {
  bindWorkflowRoundTripAuthority,
  workflowRoundTripAuthority,
} from './workflowEditorSession';
import { commitWorkflowEditorReturnTransaction } from './workflowEditorTransaction';
import { resolveWorkflowEditorRecovery } from './workflowEditorRecovery';

export interface OpenWorkflowResultRequest {
  nodeId: string;
  rootRunId: string;
  assetReferenceId: string;
  promotionId?: string;
}

const returningSessions = new WeakSet<object>();

function resultName(relativePath: string): string {
  return relativePath.split('/').pop()?.replace(/\.[^.]+$/, '') || 'Workflow result';
}

async function openPngDocument(bytes: Uint8Array, name: string): Promise<PaintDocument> {
  const bitmap = await bytesToBitmap(bytes, 'image/png');
  try {
    const document = new PaintDocument(bitmap.width, bitmap.height, name);
    const layer = new Layer(bitmap.width, bitmap.height, 'Workflow result');
    layer.ctx.drawImage(bitmap, 0, 0);
    layer.touch();
    document.layers = [layer];
    document.activeLayerId = layer.id;
    return document;
  } finally {
    bitmap.close();
  }
}

export async function openWorkflowResultInEditor(request: OpenWorkflowResultRequest): Promise<DocumentSession> {
  if (!project.path) throw new Error('Open a project folder before editing a workflow result.');
  const graph = workflow.serialize();
  const sourceKey = workflowResultDocumentSourceKey(
    graph.id,
    request.nodeId,
    request.rootRunId,
    request.promotionId,
  );
  const existing = editor.focusDocumentBySource(sourceKey);
  if (existing) return existing;

  const descriptor = workflow.prepareWorkflowEditorRoundTrip(
    request,
    project.current?.assets ?? [],
    project.identity,
  );
  const recovered = await resolveWorkflowEditorRecovery({
    document: descriptor.documentRelativePath && descriptor.documentContentHash
      ? { relativePath: descriptor.documentRelativePath, contentHash: descriptor.documentContentHash }
      : null,
    output: descriptor.output,
    readDocument: (relativePath) => readProjectFile(project.path!, relativePath),
    readOutput: (assetId) => resolveProjectAssetMaterial(project.path!, assetId),
  });
  let document: PaintDocument;
  if (recovered.kind === 'ora') {
    try {
      document = await loadOra(recovered.bytes.slice().buffer as ArrayBuffer);
    } catch {
      throw new Error('The saved workflow edit is corrupt and cannot be recovered automatically.');
    }
    document.name = resultName(descriptor.documentRelativePath!);
  } else {
    document = await openPngDocument(recovered.bytes, resultName(descriptor.output.relativePath));
  }

  const session = editor.openDocument(document, true, sourceKey, true);
  session.sourceExtension = descriptor.documentRelativePath ? 'ora' : 'png';
  session.workflowReturnState = {
    label: 'Return to Workflow',
    pendingReturn: false,
    returnedRevisionId: descriptor.editorRevisionId,
    recoveryStatus: recovered.status,
  };
  bindWorkflowRoundTripAuthority(session, descriptor.authority);
  if (recovered.status === 'flattened-from-png') {
    editor.flash('Layered edit was missing; opened the exact flattened PNG for repair.');
  } else if (recovered.status === 'layered-with-missing-png') {
    editor.flash('Flattened output was missing; opened the exact layered edit for repair.');
  }
  return session;
}

export async function returnActiveDocumentToWorkflow(): Promise<string | null> {
  const session = editor.activeDocument;
  if (!session || !workflowRoundTripAuthority(session)) {
    throw new Error('The active document is not linked to a workflow result.');
  }
  if (!project.path) throw new Error('The workflow project folder is no longer open.');
  if (returningSessions.has(session)) throw new Error('This document is already returning to the workflow.');
  returningSessions.add(session);

  try {
    const returnedDocumentRevision = session.revision;
    const returnedDocument = session.doc.clone();
    const revisionId = `editor-revision-${crypto.randomUUID()}`;
    const bindingId = `round-trip-${crypto.randomUUID()}`;
    const outputAssetReferenceId = `editor-output-${crypto.randomUUID()}`;
    const documentBlob = await saveOra(returnedDocument);
    const documentBytes = new Uint8Array(await documentBlob.arrayBuffer());
    const outputBytes = await canvasToPngBytes(compositeToCanvas(returnedDocument));
    const committed = await commitWorkflowEditorReturnTransaction({
      preflight: () => { workflow.assertWorkflowEditorReturnAuthority(session); },
      writeArtifacts: () => project.commitWorkflowEditorReturn({
        revisionId,
        name: returnedDocument.name || 'Workflow edit',
        documentBytes,
        outputBytes,
        width: returnedDocument.width,
        height: returnedDocument.height,
      }),
      commitGraph: (artifacts) => ({
        revision: workflow.commitWorkflowEditorReturn(session, {
          revisionId,
          bindingId,
          outputAssetReferenceId,
          artifacts,
          width: returnedDocument.width,
          height: returnedDocument.height,
          createdAt: Date.now(),
        }),
        cleanupToken: artifacts.cleanupToken,
      }),
      rollbackArtifacts: (artifacts) => project.rollbackWorkflowEditorReturn(artifacts.cleanupToken),
    });
    const receiptRemoved = await project.finalizeWorkflowEditorReturn(committed.cleanupToken);
    editor.markWorkflowReturned(session.id, committed.revision.id, returnedDocumentRevision);
    return receiptRemoved ? null : 'Return committed safely, but its disabled cleanup receipt could not be removed.';
  } finally {
    returningSessions.delete(session);
  }
}
