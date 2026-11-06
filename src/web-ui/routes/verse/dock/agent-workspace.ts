import { useSyncExternalStore } from 'react';

/** Opt-in agentWorkspace flag, scoped per chat; no session data is persisted. */
export const AGENT_WORKSPACE_KEY = 'ashlr.verse.agentWorkspace.v1';
const listeners = new Set<() => void>();
export const WORKSPACE_PANES = ['terminal', 'browser', 'computer', 'diff'] as const;

export function agentWorkspaceEnabled(sessionId: string | null): boolean {
  if (!sessionId) return false;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(AGENT_WORKSPACE_KEY) ?? '{}');
    return saved !== null && typeof saved === 'object' && Object.prototype.hasOwnProperty.call(saved, sessionId)
      && (saved as Record<string, unknown>)[sessionId] === true;
  } catch { return false; }
}

export function setAgentWorkspace(sessionId: string, enabled: boolean): void {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(AGENT_WORKSPACE_KEY) ?? '{}');
    const saved = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    localStorage.setItem(AGENT_WORKSPACE_KEY, JSON.stringify({ ...saved, [sessionId]: enabled }));
  } catch { return; }
  for (const listener of listeners) listener();
}

export function useAgentWorkspace(sessionId: string | null): boolean {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    window.addEventListener('storage', listener);
    return () => { listeners.delete(listener); window.removeEventListener('storage', listener); };
  }, () => agentWorkspaceEnabled(sessionId), () => false);
}
