import { migrateWorkflowFileV1, WorkflowMigrationError } from './migration';
import { WorkflowDomainError, WorkflowGraphDomain } from './domain';
import {
  WORKFLOW_GRAPH_VERSION,
  normalizeInterruptedWorkflowRuns,
  parseWorkflowGraphV2,
  type WorkflowGraphV2,
  type WorkflowValidationIssue,
} from './schema';
import { withInputAssetScopePorts } from './inputAssetScope';
import { withTransformVisualReferencePorts } from './transformPorts';
import { withReviewDecisionContracts } from './reviewDecisionContracts';

const LEGACY_GENERIC_ART_DIRECTION_SIZE = { width: 340, height: 408 } as const;
const COMPACT_GENERIC_ART_DIRECTION_HEIGHT = 320;

export interface WorkflowReadResult {
  ok: boolean;
  graph?: WorkflowGraphV2;
  sourceVersion: number | null;
  requiresExplicitSave: boolean;
  normalizedInterruptedRuns: boolean;
  issues: WorkflowValidationIssue[];
}

function versionFrom(input: unknown): number | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const version = (input as Record<string, unknown>).version;
  return typeof version === 'number' && Number.isFinite(version) ? version : null;
}

function domainIssue(error: WorkflowDomainError, graph: WorkflowGraphV2): WorkflowValidationIssue {
  const edgeIndex = error.details.edgeIndex;
  if (typeof edgeIndex === 'number') {
    return {
      path: `edges[${edgeIndex}]`,
      message: `${error.code}: ${error.message}`,
      severity: 'error',
    };
  }
  const nodeId = error.details.nodeId;
  const nodeIndex = typeof nodeId === 'string'
    ? graph.nodes.findIndex((node) => node.id === nodeId)
    : -1;
  if (nodeIndex >= 0) {
    const direction = error.details.direction;
    const suffix = direction === 'input' || direction === 'output'
      ? `.ports.${direction}s`
      : '';
    return {
      path: `nodes[${nodeIndex}]${suffix}`,
      message: `${error.code}: ${error.message}`,
      severity: 'error',
    };
  }
  return { path: '', message: `${error.code}: ${error.message}`, severity: 'error' };
}

function normalizeLegacyCreatorLayout(graph: WorkflowGraphV2): {
  graph: WorkflowGraphV2;
  normalized: boolean;
} {
  let normalized = false;
  const nodes = graph.nodes.map((node) => {
    const legacyGenericArtDirection = node.type === 'art-direction'
      && node.id !== 'composition'
      && node.size.width === LEGACY_GENERIC_ART_DIRECTION_SIZE.width
      && node.size.height === LEGACY_GENERIC_ART_DIRECTION_SIZE.height;
    if (!legacyGenericArtDirection) return node;
    normalized = true;
    return {
      ...node,
      size: { ...node.size, height: COMPACT_GENERIC_ART_DIRECTION_HEIGHT },
    };
  });
  return normalized ? { graph: { ...graph, nodes }, normalized } : { graph, normalized };
}

function validateLoadedGraph(
  graph: WorkflowGraphV2,
  sourceVersion: number,
  requiresExplicitSave: boolean,
  issues: WorkflowValidationIssue[] = [],
): WorkflowReadResult {
  try {
    const runNormalizedGraph = normalizeInterruptedWorkflowRuns(graph);
    const normalizedInterruptedRuns = runNormalizedGraph !== graph;
    const layoutNormalization = normalizeLegacyCreatorLayout(runNormalizedGraph);
    const inputPortGraph = withInputAssetScopePorts(layoutNormalization.graph);
    const transformPortNormalization = withTransformVisualReferencePorts(inputPortGraph);
    const reviewDecisionNormalization = withReviewDecisionContracts(transformPortNormalization.graph);
    const normalizedGraph = reviewDecisionNormalization.graph;
    const domain = new WorkflowGraphDomain(normalizedGraph);
    return {
      ok: true,
      graph: domain.graph,
      sourceVersion,
      requiresExplicitSave: requiresExplicitSave
        || normalizedInterruptedRuns
        || layoutNormalization.normalized
        || transformPortNormalization.normalized
        || reviewDecisionNormalization.normalized,
      normalizedInterruptedRuns,
      issues,
    };
  } catch (error) {
    if (!(error instanceof WorkflowDomainError)) throw error;
    return {
      ok: false,
      sourceVersion,
      requiresExplicitSave: false,
      normalizedInterruptedRuns: false,
      issues: [...issues, domainIssue(error, graph)],
    };
  }
}

export function readWorkflowGraph(input: unknown): WorkflowReadResult {
  const sourceVersion = versionFrom(input);
  if (sourceVersion === 1) {
    try {
      return validateLoadedGraph(migrateWorkflowFileV1(input), sourceVersion, true);
    } catch (error) {
      const migrationError = error instanceof WorkflowMigrationError
        ? error
        : new WorkflowMigrationError((error as Error)?.message ?? String(error), '');
      return {
        ok: false,
        sourceVersion,
        requiresExplicitSave: false,
        normalizedInterruptedRuns: false,
        issues: [{ path: migrationError.path, message: migrationError.message, severity: 'error' }],
      };
    }
  }

  if (sourceVersion === WORKFLOW_GRAPH_VERSION) {
    const parsed = parseWorkflowGraphV2(input);
    if (parsed.ok && parsed.value) {
      return validateLoadedGraph(parsed.value, sourceVersion, false, parsed.issues);
    }
    return {
      ok: false,
      sourceVersion,
      requiresExplicitSave: false,
      normalizedInterruptedRuns: false,
      issues: parsed.issues,
    };
  }

  return {
    ok: false,
    sourceVersion,
    requiresExplicitSave: false,
    normalizedInterruptedRuns: false,
    issues: [{
      path: 'version',
      message: sourceVersion === null
        ? 'Workflow version must be a finite number'
        : `Unsupported workflow version: ${sourceVersion}`,
      severity: 'error',
    }],
  };
}
