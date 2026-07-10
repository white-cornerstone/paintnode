import { migrateWorkflowFileV1, WorkflowMigrationError } from './migration';
import {
  WORKFLOW_GRAPH_VERSION,
  parseWorkflowGraphV2,
  type WorkflowGraphV2,
  type WorkflowValidationIssue,
} from './schema';

export interface WorkflowReadResult {
  ok: boolean;
  graph?: WorkflowGraphV2;
  sourceVersion: number | null;
  requiresExplicitSave: boolean;
  issues: WorkflowValidationIssue[];
}

function versionFrom(input: unknown): number | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const version = (input as Record<string, unknown>).version;
  return typeof version === 'number' && Number.isFinite(version) ? version : null;
}

export function readWorkflowGraph(input: unknown): WorkflowReadResult {
  const sourceVersion = versionFrom(input);
  if (sourceVersion === 1) {
    try {
      return {
        ok: true,
        graph: migrateWorkflowFileV1(input),
        sourceVersion,
        requiresExplicitSave: true,
        issues: [],
      };
    } catch (error) {
      const migrationError = error instanceof WorkflowMigrationError
        ? error
        : new WorkflowMigrationError((error as Error)?.message ?? String(error), '');
      return {
        ok: false,
        sourceVersion,
        requiresExplicitSave: false,
        issues: [{ path: migrationError.path, message: migrationError.message, severity: 'error' }],
      };
    }
  }

  if (sourceVersion === WORKFLOW_GRAPH_VERSION) {
    const parsed = parseWorkflowGraphV2(input);
    return {
      ok: parsed.ok,
      graph: parsed.value,
      sourceVersion,
      requiresExplicitSave: false,
      issues: parsed.issues,
    };
  }

  return {
    ok: false,
    sourceVersion,
    requiresExplicitSave: false,
    issues: [{
      path: 'version',
      message: sourceVersion === null
        ? 'Workflow version must be a finite number'
        : `Unsupported workflow version: ${sourceVersion}`,
      severity: 'error',
    }],
  };
}
