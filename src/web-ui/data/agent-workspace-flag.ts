/**
 * data/agent-workspace-flag.ts: minimal local gate for the `agentWorkspace`
 * flag (default off). RQ-DESKTOP-P1-1 is building the real flag store with a
 * Settings toggle; when it lands, replace this body with a read from that
 * store. Enable locally with localStorage `phantom.flag.agentWorkspace = "1"`.
 */
export const AGENT_WORKSPACE_STORAGE_KEY = 'phantom.flag.agentWorkspace';

export function isAgentWorkspaceEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(AGENT_WORKSPACE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
