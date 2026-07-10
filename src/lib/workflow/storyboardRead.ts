import type { WorkflowStoryboardDescriptor, WorkflowStoryboardRead } from './transformExecutor';

export interface WorkflowStoryboardReaders {
  readEmbedded(dataUrl: string): Promise<Uint8Array>;
  readOra(relativePath: string): Promise<Uint8Array>;
}

export async function resolveWorkflowStoryboardRead(
  storyboard: Readonly<WorkflowStoryboardDescriptor>,
  readers: WorkflowStoryboardReaders,
): Promise<WorkflowStoryboardRead | null> {
  if (storyboard.dataUrl) {
    return {
      bytes: await readers.readEmbedded(storyboard.dataUrl),
      relativePath: 'storyboards/embedded-composition.png',
    };
  }
  if (!storyboard.oraPath) return null;
  return {
    bytes: await readers.readOra(storyboard.oraPath),
    relativePath: storyboard.oraPath,
  };
}
