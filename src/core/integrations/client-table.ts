/**
 * Single source of truth for the AI clients Phantom knows how to wire or
 * inspect. `wire`, `wire status` and detection read this table; other repos
 * read the JSON form (`docs/client-table.json`, or `phm wire table --json`).
 *
 * Data only: no I/O, no process.platform branching. Paths are relative to the
 * user's home directory and are resolved by consumers. Per-OS entries exist so
 * a client can diverge later; today every OS uses the same home-relative path.
 * The darwin/linux paths match what the existing wiring code writes; win32 is
 * the same relative path and has not been independently verified.
 */

export type ClientId = 'claude' | 'codex' | 'cursor' | 'gemini';
export type ClientOs = 'darwin' | 'linux' | 'win32';
export type ClientConfigFormat = 'json-mcpServers' | 'toml-mcp_servers';

/** `write`: `phm wire` can register the gateway. `status`: read-only report only. */
export type ClientWireSupport = 'write' | 'status';

export interface ClientEntry {
  id: ClientId;
  displayName: string;
  wire: ClientWireSupport;
  /** Config file path segments relative to the home directory, per OS. */
  configPath: Record<ClientOs, readonly string[]>;
  format: ClientConfigFormat;
  detection: {
    /** Home-relative paths whose existence means the client is installed. */
    homePaths: readonly (readonly string[])[];
    /** Executable name looked up on PATH. */
    binary: string;
  };
  /** Key of the server entry inside the config's server map. */
  serverName: string;
  /**
   * The entry `wire` writes and `wire status` compares against. JSON clients
   * only; Codex is registered through its own CLI so its shape is described by
   * `command` and `args`.
   */
  wiredEntry: {
    type?: 'stdio';
    command: string;
    args: readonly string[];
    env?: Readonly<Record<string, string>>;
  };
  /** Where the config location and schema were verified. */
  source: string;
}

const same = (...segments: string[]): Record<ClientOs, readonly string[]> => ({
  darwin: segments,
  linux: segments,
  win32: segments,
});

export const CLIENT_TABLE_VERSION = 1;

export const CLIENT_TABLE: readonly ClientEntry[] = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    wire: 'write',
    configPath: same('.claude.json'),
    format: 'json-mcpServers',
    detection: { homePaths: [['.claude'], ['.claude.json']], binary: 'claude' },
    serverName: 'ashlr-hub',
    wiredEntry: { type: 'stdio', command: 'ashlr', args: ['mcp'], env: {} },
    source: 'src/core/integrations/editors.ts (existing wiring)',
  },
  {
    id: 'codex',
    displayName: 'Codex',
    wire: 'write',
    configPath: same('.codex', 'config.toml'),
    format: 'toml-mcp_servers',
    detection: { homePaths: [['.codex']], binary: 'codex' },
    serverName: 'ashlr-hub',
    wiredEntry: { command: 'ashlr', args: ['mcp'] },
    source: 'src/core/integrations/editors.ts (existing wiring)',
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    wire: 'write',
    configPath: same('.cursor', 'mcp.json'),
    format: 'json-mcpServers',
    detection: { homePaths: [['.cursor']], binary: 'cursor' },
    serverName: 'ashlr-hub',
    wiredEntry: { command: 'ashlr', args: ['mcp'] },
    source: 'src/core/integrations/editors.ts (existing wiring)',
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    wire: 'status',
    configPath: same('.gemini', 'settings.json'),
    format: 'json-mcpServers',
    detection: { homePaths: [['.gemini']], binary: 'gemini' },
    serverName: 'ashlr-hub',
    wiredEntry: { command: 'ashlr', args: ['mcp'] },
    source: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md',
  },
];

/** JSON document other repos can read. Stable key order; no secrets. */
export function clientTableJson(): { version: number; clients: readonly ClientEntry[] } {
  return { version: CLIENT_TABLE_VERSION, clients: CLIENT_TABLE };
}

export function getClient(id: ClientId): ClientEntry {
  const entry = CLIENT_TABLE.find(c => c.id === id);
  if (!entry) throw new Error(`unknown client: ${id}`);
  return entry;
}
