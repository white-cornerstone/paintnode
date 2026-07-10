import type { CodexDetectionResult } from '../integrations/desktop';
import type { AiExecutableMode } from '../state/settings';

export type AiDetectionProvider = 'codex' | 'claude' | 'antigravity' | 'grok';

const providerDetails: Record<AiDetectionProvider, { name: string; connection: string }> = {
  codex: { name: 'Codex', connection: 'the bundled SDK' },
  claude: { name: 'Claude', connection: 'the bundled Agent SDK' },
  antigravity: { name: 'Antigravity', connection: 'the local CLI' },
  grok: { name: 'Grok', connection: 'the local grok CLI sign-in' },
};

export function providerDetectionSuccessMessage(
  provider: AiDetectionProvider,
  detection: CodexDetectionResult,
  executableMode: AiExecutableMode,
): string {
  const details = providerDetails[provider];
  const version = detection.version?.trim() || details.name;
  if (executableMode === 'custom' && detection.path) {
    return `${version} is available at ${detection.path}.`;
  }
  return `${version} is available through ${details.connection}.`;
}
