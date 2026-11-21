import { useSyncExternalStore } from 'react';

/** P1's flag store is not present yet. Keep the one default-off flag local. */
export function isAgentWorkspaceEnabled(): boolean {
  try { return typeof window !== 'undefined' && window.localStorage.getItem('agentWorkspace') === 'true'; }
  catch { return false; }
}
function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  window.addEventListener('agentWorkspace-changed', onChange);
  return () => {
    window.removeEventListener('storage', onChange);
    window.removeEventListener('agentWorkspace-changed', onChange);
  };
}
export function useAgentWorkspace(): boolean {
  return useSyncExternalStore(subscribe, isAgentWorkspaceEnabled, () => false);
}
