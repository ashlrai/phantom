/** Explicit preview opt-in. Absent, malformed and server-side reads stay off. */
export function agentWorkspaceEnabled(): boolean {
  return typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('agentWorkspace') === '1';
}
