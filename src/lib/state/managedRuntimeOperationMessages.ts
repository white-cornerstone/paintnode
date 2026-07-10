import type { ManagedRuntimeProvider } from '../ai/managedRuntime';

export function managedRuntimeLabel(provider: ManagedRuntimeProvider): string {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

export function managedRuntimeCompletionMessage(provider: ManagedRuntimeProvider): string {
  return `${managedRuntimeLabel(provider)} support is installed and ready to sign in.`;
}
