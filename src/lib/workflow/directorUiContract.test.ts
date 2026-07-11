import { describe, expect, it } from 'vitest';
import dialogSource from '../components/WorkflowDirectorDialog.svelte?raw';
import revisionDialogSource from '../components/WorkflowDirectorRevisionDialog.svelte?raw';
import boardSource from '../components/WorkflowBoard.svelte?raw';
import providerFreeRevisionSource from '../integrations/providerFreeWorkflowRevision.ts?raw';
import revisionHistorySource from './directorRevisionHistory.svelte.ts?raw';

describe('Workflow Director UI contract', () => {
  it('opens an explicit proposal dialog from the workflow board', () => {
    expect(boardSource).toContain('WorkflowDirectorDialog');
    expect(boardSource).toContain('Draft with AI Director');
  });

  it('shows proposal nodes, requirements, unsupported capabilities, validation issues, reject, and guarded accept', () => {
    expect(dialogSource).toContain('proposal.nodes');
    expect(dialogSource).toContain('proposal.requirements');
    expect(dialogSource).toContain('proposal.unsupportedCapabilities');
    expect(dialogSource).toContain('proposal.issues');
    expect(dialogSource).toContain('rejectDirectorProposalPreview');
    expect(dialogSource).toContain('acceptDirectorProposalPreview');
    expect(dialogSource).toContain('disabled={!proposal.canAccept}');
  });

  it('uses only configured Director adapters or QA Fake and does no discovery or authentication', () => {
    expect(dialogSource).toContain('createConfiguredWorkflowDirector');
    expect(dialogSource).toContain('createProviderFreeWorkflowDirector');
    expect(dialogSource).toContain("['codex', 'claude', 'antigravity']");
    expect(dialogSource).not.toMatch(/\b(discover\w*|authenticate\w*|login\w*|commandExists)\s*\(/i);
  });

  it('builds the strict context boundary from asset metadata and requested outputs', () => {
    expect(dialogSource).toContain('buildWorkflowDirectorContext');
    expect(dialogSource).toContain('directorAssetMetadata(asset)');
    expect(dialogSource).toContain('selectedOutputs()');
    expect(dialogSource).not.toContain('relativePath: asset.relativePath');
    expect(dialogSource).not.toContain('previewDataUrl: asset.previewDataUrl');
    expect(dialogSource).not.toContain('prompt: asset.prompt');
  });

  it('invalidates preview and independently guards accept when any live request context changes', () => {
    expect(dialogSource).toContain('workflowDirectorRequestKey');
    expect(dialogSource).toContain('liveRequestKey');
    expect(dialogSource).toContain('preview.requestKey === liveRequestKey');
    expect(dialogSource).toContain('acceptDirectorProposalPreview(preview, workflow, liveRequestKey)');
  });

  it('opens a dedicated current-workflow revision dialog separately from fresh Draft replacement', () => {
    expect(boardSource).toContain('WorkflowDirectorRevisionDialog');
    expect(boardSource).toContain('Revise current workflow');
    expect(boardSource).toContain("qaMode === 'provider-free'");
    expect(revisionDialogSource).toContain('Revise current workflow');
    expect(revisionDialogSource).not.toContain('applyDirectorProposal');
    expect(revisionDialogSource).not.toContain('Accept and replace workflow');
  });

  it('shows QA Fake revision operations and all patch impact categories before guarded acceptance', () => {
    expect(revisionDialogSource).toContain('QA Fake');
    expect(revisionDialogSource).toContain('No discovery, sign-in, AI provider, or image execution');
    expect(revisionDialogSource).toContain('view.operations');
    expect(revisionDialogSource).toContain('view.nodeChanges');
    expect(revisionDialogSource).toContain('view.connectionChanges');
    expect(revisionDialogSource).toContain('view.requirementChanges');
    expect(revisionDialogSource).toContain('view.downstreamStaleness');
    expect(revisionDialogSource).toContain('view.validationIssues');
    expect(revisionDialogSource).toContain('rejectWorkflowDirectorRevisionPreview');
    expect(revisionDialogSource).toContain('acceptWorkflowDirectorRevisionPreview');
  });

  it('cancels in-flight injected revision work and exposes transaction undo and redo status', () => {
    expect(revisionDialogSource).toContain('AbortController');
    expect(revisionDialogSource).toContain('controller?.abort()');
    expect(revisionDialogSource).toContain('createWorkflowDirectorRevisionHistoryState(workflow)');
    expect(revisionDialogSource).toContain('revisionHistory.canUndo');
    expect(revisionDialogSource).toContain('revisionHistory.canRedo');
    expect(revisionHistorySource).toContain('captureDirectorSession().mutationIdentity');
    expect(revisionHistorySource).toContain('target.canUndoDirectorPatch');
    expect(revisionHistorySource).toContain('target.canRedoDirectorPatch');
    expect(revisionDialogSource).toContain('workflow.undoDirectorPatch()');
    expect(revisionDialogSource).toContain('workflow.redoDirectorPatch()');
  });

  it('marks stale previews visibly and disables acceptance before the store guard is reached', () => {
    expect(revisionDialogSource).toContain('workflowDirectorRevisionPreviewIsCurrent');
    expect(revisionDialogSource).toContain('previewCurrent');
    expect(revisionDialogSource).toContain("'Stale preview'");
    expect(revisionDialogSource).toContain('disabled={!view.canAccept || !previewCurrent}');
  });

  it('keeps the revision fixture provider-free with no discovery, auth, provider, or image execution calls', () => {
    expect(revisionDialogSource).toContain('createProviderFreeWorkflowRevisionRequester');
    expect(revisionDialogSource).not.toContain('createConfiguredWorkflowDirector');
    expect(providerFreeRevisionSource).not.toMatch(/\b(discover\w*|authenticate\w*|login\w*|execute\w*|generate\w*)\s*\(/i);
  });
});
