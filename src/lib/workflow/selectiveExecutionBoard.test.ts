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
    expect(boardSource).toContain('workflow.retryCandidateBranch');
    expect(boardSource).toContain('workflow.candidateBranchGroups(node.id)');
    expect(boardSource).toContain('data-candidate-state={candidate.status}');
    expect(boardSource).toContain('Lineage:');
    expect(boardSource).toContain('aria-label="Candidate count"');
    expect(boardSource).toContain('aria-label="Candidate concurrency"');
    expect(boardSource).toContain('Branches / candidate 2 fails once');
  });
});
