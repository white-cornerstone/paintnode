import { PaintDocument } from '../engine/Document.svelte';
import { Layer } from '../engine/Layer.svelte';
import { compositeToCanvas } from '../engine/compositor';
import { readProjectFile, resolveProjectAssetMaterial } from '../integrations/desktop';
import { bytesToBitmap, canvasToPngBytes } from '../io';
import { loadOra } from '../ora/load';
import { saveOra } from '../ora/save';
import { workflowSha256Bytes } from '../workflow/provenance';
import { workflowResultDocumentSourceKey } from './documentSource';
import { editor, type DocumentSession } from './editor.svelte';
import { project } from './project.svelte';
import { workflow } from './workflow.svelte';
import {
  bindWorkflowRoundTripAuthority,
  workflowRoundTripAuthority,
} from './workflowEditorSession';

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
  let document: PaintDocument;
  if (descriptor.documentRelativePath) {
    const bytes = await readProjectFile(project.path, descriptor.documentRelativePath);
    if (!descriptor.documentContentHash || workflowSha256Bytes(bytes) !== descriptor.documentContentHash) {
      throw new Error('The saved workflow edit no longer matches its recorded document.');
    }
    document = await loadOra(bytes.slice().buffer as ArrayBuffer);
    document.name = resultName(descriptor.documentRelativePath);
  } else {
    const material = await resolveProjectAssetMaterial(project.path, descriptor.output.assetId);
    if (material.assetId !== descriptor.output.assetId
      || material.relativePath !== descriptor.output.relativePath
      || material.contentHash !== descriptor.output.contentHash
      || workflowSha256Bytes(material.bytes) !== descriptor.output.contentHash) {
      throw new Error('The workflow result no longer matches its recorded source asset.');
    }
    document = await openPngDocument(material.bytes, resultName(descriptor.output.relativePath));
  }

  const session = editor.openDocument(document, true, sourceKey, true);
  session.sourceExtension = descriptor.documentRelativePath ? 'ora' : 'png';
  session.workflowReturnState = {
    label: 'Return to Workflow',
    pendingReturn: false,
    returnedRevisionId: descriptor.editorRevisionId,
  };
  bindWorkflowRoundTripAuthority(session, descriptor.authority);
  return session;
}

export async function returnActiveDocumentToWorkflow(): Promise<void> {
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
    const artifacts = await project.commitWorkflowEditorReturn({
      revisionId,
      name: returnedDocument.name || 'Workflow edit',
      documentBytes,
      outputBytes,
      width: returnedDocument.width,
      height: returnedDocument.height,
    });
    const revision = workflow.commitWorkflowEditorReturn(session, {
      revisionId,
      bindingId,
      outputAssetReferenceId,
      artifacts,
      width: returnedDocument.width,
      height: returnedDocument.height,
      createdAt: Date.now(),
    });
    editor.markWorkflowReturned(session.id, revision.id, returnedDocumentRevision);
  } finally {
    returningSessions.delete(session);
  }
}
