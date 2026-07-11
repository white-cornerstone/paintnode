export async function commitWorkflowEditorReturnTransaction<TArtifact, TResult>(options: Readonly<{
  preflight: () => void;
  writeArtifacts: () => Promise<TArtifact>;
  commitGraph: (artifacts: TArtifact) => TResult;
  rollbackArtifacts: (artifacts: TArtifact) => Promise<void>;
}>): Promise<TResult> {
  options.preflight();
  const artifacts = await options.writeArtifacts();
  try {
    options.preflight();
    return options.commitGraph(artifacts);
  } catch (error) {
    try {
      await options.rollbackArtifacts(artifacts);
    } catch (rollbackError) {
      throw new Error(
        `${(error as Error)?.message ?? String(error)} Cleanup also failed: ${(rollbackError as Error)?.message ?? String(rollbackError)}`,
      );
    }
    throw error;
  }
}
