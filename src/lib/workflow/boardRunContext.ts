import { workflowSha256Text } from './provenance';
import { safeWorkflowIdentifier } from './provenanceSafety';
import type { WorkflowAssetMaterial, WorkflowProjectAsset } from './transformExecutor';

export type WorkflowBoardRunIdGenerator = (nodeId: string, attempt: number) => string;
export type WorkflowBoardProjectMaterialReader = (
  projectPath: string,
  assetId: string,
) => Promise<WorkflowAssetMaterial>;

export async function resolveWorkflowBoardProjectAsset(
  projectPath: string | null,
  asset: Readonly<WorkflowProjectAsset>,
  readProjectMaterial: WorkflowBoardProjectMaterialReader,
): Promise<WorkflowAssetMaterial> {
  if (!projectPath) throw new Error('No project is open.');
  return readProjectMaterial(projectPath, asset.id);
}

export function createWorkflowBoardRunIdGenerator(baseRunId: string): WorkflowBoardRunIdGenerator {
  const safeBase = safeWorkflowIdentifier(baseRunId, 'Board run ID').slice(0, 120);
  return (nodeId, attempt) => {
    const safeNodeId = safeWorkflowIdentifier(nodeId, 'Workflow node ID');
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Workflow run attempt must be positive.');
    const nodeDigest = workflowSha256Text(safeNodeId).slice('sha256:'.length, 'sha256:'.length + 20);
    return safeWorkflowIdentifier(`${safeBase}:${nodeDigest}:${attempt}`, 'Workflow run ID');
  };
}
