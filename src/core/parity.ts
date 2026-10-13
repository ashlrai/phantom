/**
 * UI ⇄ CLI ⇄ MCP parity registry. Every human-facing console capability is
 * listed with its API route, the CLI command (always with --json) and the MCP
 * tool an agent calls. test/parity.test.ts proves each entry exists on all
 * three surfaces and that they return the same schema.
 */
export interface ParityEntry {
  capability: string;
  consolePath: string;
  api: { method: 'GET' | 'POST'; path: string };
  cli: string;
  mcp: string;
  /** Agents may only narrow through this tool (widening returns needs-human). */
  agentLimit?: 'narrowing-only' | 'no-grant-signing';
}

export const PARITY: readonly ParityEntry[] = Object.freeze([
  { capability: 'ecosystem status', consolePath: '/control/ecosystem', api: { method: 'GET', path: '/api/ecosystem' }, cli: 'ashlr ecosystem status --json', mcp: 'ashlr_ecosystem_status' },
  { capability: 'enable ecosystem autonomy', consolePath: '/control/ecosystem', api: { method: 'POST', path: '/api/ecosystem/up' }, cli: 'ashlr ecosystem up --json', mcp: 'ashlr_ecosystem_up', agentLimit: 'no-grant-signing' },
  { capability: 'daily home dashboard', consolePath: '/home', api: { method: 'GET', path: '/api/home' }, cli: 'ashlr home --json', mcp: 'ashlr_home' },
  { capability: 'read settings', consolePath: '/control/settings', api: { method: 'GET', path: '/api/settings' }, cli: 'ashlr settings --json', mcp: 'ashlr_settings_get' },
  { capability: 'change a setting', consolePath: '/control/settings', api: { method: 'POST', path: '/api/settings' }, cli: 'ashlr settings set <key> <value> --json', mcp: 'ashlr_settings_set', agentLimit: 'narrowing-only' },
  { capability: 'first-run wizard', consolePath: '/home', api: { method: 'GET', path: '/api/welcome' }, cli: 'ashlr welcome --json', mcp: 'ashlr_welcome_status' },
]);
