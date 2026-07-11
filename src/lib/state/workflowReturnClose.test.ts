import { describe, expect, it } from 'vitest';
import { persistWorkflowAfterReturnForClose } from './workflowReturnClose';

describe('workflow return quit sequencing', () => {
  it('requires and persists a newly dirty workflow after Return before quit continues', async () => {
    let workflowDirty = true;
    let persisted = false;
    const result = await persistWorkflowAfterReturnForClose({
      documentReturnSucceeded: true,
      workflowIsDirty: () => workflowDirty,
      saveWorkflow: async () => {
        persisted = true;
        workflowDirty = false;
        return true;
      },
    });

    expect(result).toBe(true);
    expect(persisted).toBe(true);
    expect(workflowDirty).toBe(false);
  });

  it.each(['cancelled', 'failed'])('aborts quit when workflow persistence is %s', async () => {
    await expect(persistWorkflowAfterReturnForClose({
      documentReturnSucceeded: true,
      workflowIsDirty: () => true,
      saveWorkflow: async () => false,
    })).resolves.toBe(false);
  });

  it('aborts before workflow save when Return itself fails', async () => {
    let saveCalls = 0;
    await expect(persistWorkflowAfterReturnForClose({
      documentReturnSucceeded: false,
      workflowIsDirty: () => true,
      saveWorkflow: async () => {
        saveCalls += 1;
        return true;
      },
    })).resolves.toBe(false);
    expect(saveCalls).toBe(0);
  });
});
