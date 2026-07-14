import { describe, expect, it } from 'vitest';
import boardSource from '../components/WorkflowBoard.svelte?raw';
import directorDialogSource from '../components/WorkflowDirectorDialog.svelte?raw';
import revisionDialogSource from '../components/WorkflowDirectorRevisionDialog.svelte?raw';
import { CREATOR_NODE_DEFINITIONS } from './registry';
import schemaSource from './schema.ts?raw';

const expectedNodeTypes = [
  'input',
  'brief',
  'art-direction',
  'extract-assets',
  'transform',
  'review',
  'output',
] as const;

describe('Workflow Task coverage for AI-assisted workflow actions', () => {
  it('keeps an explicit audit entry for every registered creator node type', () => {
    expect(CREATOR_NODE_DEFINITIONS.map((definition) => definition.type)).toEqual(expectedNodeTypes);

    const coverage = {
      input: 'manual asset input; no AI job',
      brief: 'node-scoped AI Director revision',
      'art-direction': 'node-scoped AI Director revision',
      'extract-assets': 'AI Director and image extraction',
      transform: 'selective execution, generation, candidate branches, and candidate retry',
      review: 'optional AI candidate review',
      output: 'output-triggered transform generation',
    } satisfies Record<(typeof expectedNodeTypes)[number], string>;

    expect(Object.keys(coverage)).toEqual(expectedNodeTypes);
  });

  it('keeps unsupported imported nodes blocked and outside AI execution', () => {
    expect(schemaSource).toContain("| 'unsupported';");
    expect(boardSource).toContain('typeLabel="Unsupported"');
    expect(boardSource).not.toContain('runUnsupported');
  });

  it('tracks Brief and Art Direction AI assistance through the shared revision task lifecycle', () => {
    expect(boardSource).toContain("node.type === 'brief'");
    expect(boardSource).toContain("node.type === 'art-direction'");
    expect(boardSource).toContain("'Enhance Brief with AI'");
    expect(boardSource).toContain("'Develop Art Direction'");
    expect(boardSource).toContain('revisionDirectorOpen = true');

    expect(revisionDialogSource).toContain('const task = aiTasks.create({');
    expect(revisionDialogSource).toContain('title: `AI Director: ${title}`');
    expect(revisionDialogSource).toContain('aiTasks.setCancel(task.id');
    expect(revisionDialogSource).toContain('aiTasks.complete(task.id');
    expect(revisionDialogSource).toContain('aiTasks.fail(task.id');
    expect(revisionDialogSource).toContain('aiTasks.markCancelled(task.id');
  });

  it('tracks Extract Assets from provider invocation through completion, failure, or cancellation', () => {
    expect(boardSource).toContain('async function runAssetExtraction');
    expect(boardSource).toContain('title: `Extract assets: ${node.name}`');
    expect(boardSource).toContain('aiTasks.setCancel(extractionTask.id');
    expect(boardSource).toContain('aiTasks.setProgress(extractionTask.id');
    expect(boardSource).toContain('aiTasks.complete(extractionTask.id');
    expect(boardSource).toContain('aiTasks.fail(extractionTask.id');
    expect(boardSource).toContain('aiTasks.markCancelled(extractionTask.id');
  });

  it('tracks every Transform AI execution path, including branch generation and retry', () => {
    expect(boardSource).toContain("title: `Workflow: ${selectiveMode === 'run-node' ? 'Run this node' : 'Run from here'}`");
    expect(boardSource).toContain("title: `Workflow: ${targetOutput.name || 'Generate output'}`");
    expect(boardSource).toContain('title: `Generate candidates: ${transformName}`');
    expect(boardSource).toContain('title: `Retry ${retryLabel}: ${transformName}`');
    expect(boardSource).toContain('activeWorkflowTaskId = task.id');
    expect(boardSource).toContain('aiTasks.setRetry(task.id, () => generateCandidateBranches');
    expect(boardSource).toContain('aiTasks.setRetry(task.id, () => retryCandidate');
  });

  it('tracks AI Review while leaving human promotion as a manual action', () => {
    expect(boardSource).toContain('async function runAiReview');
    expect(boardSource).toContain('title: `AI Review: ${node.title}`');
    expect(boardSource).toContain('aiTasks.setCancel(task.id');
    expect(boardSource).toContain("aiTasks.complete(task.id, 'Recommendation saved')");
    expect(boardSource).toContain('async function promoteReviewCandidate');
  });

  it('routes Output generation through a Workflow Task and keeps Place manual', () => {
    expect(boardSource).toContain('onclick={() => void generate(outputNode)}');
    expect(boardSource).toContain("title: `Workflow: ${targetOutput.name || 'Generate output'}`");
    expect(boardSource).toContain("editor.flash(`Placed ${outputAsset.name}`)");
  });

  it('tracks whole-workflow AI Director drafting as well as node-scoped revisions', () => {
    expect(directorDialogSource).toContain('const task = aiTasks.create({');
    expect(directorDialogSource).toContain("title: 'AI Director: Draft workflow'");
    expect(directorDialogSource).toContain('aiTasks.setCancel(task.id');
    expect(directorDialogSource).toContain('aiTasks.complete(task.id');
    expect(directorDialogSource).toContain('aiTasks.fail(task.id');
    expect(directorDialogSource).toContain('aiTasks.markCancelled(task.id');
  });
});
