export async function persistWorkflowAfterReturnForClose(options: Readonly<{
  documentReturnSucceeded: boolean;
  workflowIsDirty: () => boolean;
  saveWorkflow: () => Promise<boolean>;
}>): Promise<boolean> {
  if (!options.documentReturnSucceeded) return false;
  if (!options.workflowIsDirty()) return true;
  return options.saveWorkflow();
}
