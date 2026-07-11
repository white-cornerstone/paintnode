export type DocumentSourceKey = string;

export interface FileSourceLike {
  name: string;
  size: number;
  lastModified: number;
  webkitRelativePath?: string;
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function projectDocumentSourceKey(relativePath: string): DocumentSourceKey | null {
  const normalized = normalizePath(relativePath);
  return normalized ? `project:${normalized}` : null;
}

export function fileDocumentSourceKey(file: FileSourceLike): DocumentSourceKey {
  const path = normalizePath(file.webkitRelativePath || file.name);
  return `file:${path}:${file.size}:${file.lastModified}`;
}

export function nativePathDocumentSourceKey(path: string): DocumentSourceKey | null {
  const normalized = normalizePath(path);
  return normalized ? `native:${normalized}` : null;
}

export function workflowResultDocumentSourceKey(
  workflowId: string,
  nodeId: string,
  rootRunId: string,
  promotionId?: string,
): DocumentSourceKey {
  return `workflow:${workflowId}:${nodeId}:${rootRunId}:${promotionId ?? 'accepted'}`;
}
