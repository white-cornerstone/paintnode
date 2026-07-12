import { describe, expect, it } from 'vitest';
import boardSource from '../components/WorkflowBoard.svelte?raw';

describe('Workflow Board selective execution UX contract', () => {
  it('exposes preview-first actions and visible per-node preflight without bypassing the store', () => {
    expect(boardSource).toContain('Run this node');
    expect(boardSource).toContain('Run from here');
    expect(boardSource).toContain('preflightSelectiveExecution');
    expect(boardSource).toContain('runSelectiveExecution');
    expect(boardSource).toContain('cancelSelectiveExecution');
    expect(boardSource).toContain('WorkflowNodePreflight');
    expect(boardSource).toContain('Preview selective run');
    expect(boardSource).toContain('Confirm selective run');
    expect(boardSource).toContain('maxConcurrency: 1');
    expect(boardSource).toContain('createWorkflowBoardRunIdGenerator');
    expect(boardSource).toContain('WorkflowSelectiveUiState');
    expect(boardSource).toContain('selectiveUiState.invalidatePreview()');
    expect(boardSource).toContain(
      'resolveWorkflowBoardProjectAsset(runProjectPath, asset, resolveProjectAssetMaterial)',
    );
    expect(boardSource).not.toContain('provider-free-qa-asset-v1');
  });

  it('renders the exact transient state for each Transform during confirmed selective execution', () => {
    expect(boardSource).toContain('workflow.transformExecution(node.id)');
    expect(boardSource).toContain('data-workflow-selective-running-state');
  });

  it('invalidates the visible preview when graph, project, provider, or run options change', () => {
    expect(boardSource).toContain('workflow.rev');
    expect(boardSource).toContain('project.identity');
    expect(boardSource).toContain('providerSelection.provider');
    expect(boardSource).toContain('JSON.stringify(runOptions)');
    expect(boardSource).toContain('invalidateSelectivePreview');
  });

  it('communicates provider-neutral candidate branch count, state, lineage, and retry', () => {
    expect(boardSource).toContain('Generate branches');
    expect(boardSource).toContain('workflow.runCandidateBranches');
    expect(boardSource).toContain("workflow.runReviewedOutput(targetOutput.id, context.options)");
    expect(boardSource).toContain("resolveWorkflowCampaignPath(workflow.serialize(), { outputNodeId: targetOutput.id })");
    expect(boardSource).toContain("workflow.reviewResolution(path.reviewNodeId, assets, true, project.identity)");
    expect(boardSource).toContain("reviewedOutput ? 'Use promoted'");
    expect(boardSource).toContain('workflow.runCampaignGenerate(targetOutput.id, context.options)');
    expect(boardSource).toContain('workflow.retryCandidateBranch');
    expect(boardSource).toContain('workflow.candidateBranchGroups(node.id)');
    expect(boardSource).toContain('workflowCandidateProgressLabel');
    expect(boardSource).toContain('workflowCandidateBranchResultSummary(outcome.group)');
    expect(boardSource).toContain('candidate-result-summary');
    expect(boardSource).toContain("oninput={(event) => workflow.assignAsset");
    expect(boardSource).toContain('Selected ${asset.name}');
    expect(boardSource).toContain('review-candidate-preview');
    expect(boardSource).toContain("'Checking for reusable output…'");
    expect(boardSource).toContain("'Reused verified output; no provider request was sent'");
    expect(boardSource).toContain('Reuse or update');
    expect(boardSource).toContain('Regenerate');
    expect(boardSource).toContain('data-candidate-state={candidate.status}');
    expect(boardSource).toContain('Lineage:');
    expect(boardSource).toContain('aria-label="Candidate count"');
    expect(boardSource).toContain('aria-label="Candidate concurrency"');
    expect(boardSource).toContain('Branch recovery checkpoint');
    expect(boardSource).toContain('Format recovery checkpoint');
    expect(boardSource).toContain(
      'if (context.runProjectPath && project.path === context.runProjectPath) await project.refresh(context.runProjectPath);',
    );
    expect(boardSource).toContain('role="tablist"');
    expect(boardSource).toContain("event.key !== 'ArrowLeft' && event.key !== 'ArrowRight'");
    expect(boardSource).toContain('Promote this candidate');
    expect(boardSource).toContain('<strong>Brief</strong>');
    expect(boardSource).toContain('<strong>Art direction</strong>');
    expect(boardSource).toContain('Provenance:');
    expect(boardSource).toContain('aria-controls={`review-candidate-panel-${node.id}`}');
    expect(boardSource).toContain('aria-labelledby={`review-candidate-tab-${node.id}-${reviewCandidate.candidateId}`}');
    expect(boardSource).toContain('.focus()');
    expect(boardSource).toContain('requireVerifiedReview: true');
    expect(boardSource).toContain('reviewResolutions');
    expect(boardSource).toContain('untrack(() => workflow.refreshReviewState');
    expect(boardSource).toContain('const executionOptionsIdentity = workflowExecutionOptionsIdentity();');
    expect(boardSource).toContain('reviewRefreshGate.shouldRefresh');
    expect(boardSource).toContain('workflow.invalidateReviewState(reviewNodeIds)');
    expect(boardSource).toContain('reviewRefreshGate.reset()');
    expect(boardSource.indexOf('reviewRefreshGate.shouldRefresh'))
      .toBeLessThan(boardSource.indexOf('const epoch = ++reviewVerificationEpoch'));
  });
});
