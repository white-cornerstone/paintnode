import { describe, expect, it } from 'vitest';
import dialogSource from '../components/WorkflowDirectorDialog.svelte?raw';
import boardSource from '../components/WorkflowBoard.svelte?raw';

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
});
