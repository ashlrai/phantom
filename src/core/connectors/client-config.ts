/**
 * Client MCP config snippets generated from the profile. Credential-bearing
 * servers start through `phm connectors exec`, so a snippet carries ids,
 * selectors and executables only; every snippet passes the secret-shape gate
 * before it is returned. Nothing is written to a client config.
 */
import { stringify } from 'smol-toml';
import { assertMetadata, ConnectorError, readProfile, name as nameSchema } from './profile.js';

export const CLIENTS = ['claude', 'cursor', 'codex'] as const;
export type Client = typeof CLIENTS[number];
type Server = { command: string; args: string[] } | { type?: 'http'; url: string };
export interface ClientConfig {
  client: Client;
  lane: string;
  format: 'json' | 'toml';
  servers: string[];
  skipped: Array<{ id: string; reason: string }>;
  config: string;
}

export async function buildClientConfig(client: string, lane: string, options: { home?: string; project?: string } = {}): Promise<ClientConfig> {
  if (!(CLIENTS as readonly string[]).includes(client)) throw new ConnectorError('Use --client claude, cursor or codex.');
  if (!nameSchema.safeParse(lane).success) throw new ConnectorError('Supply --lane using letters, digits, dots, underscores or hyphens.');
  if (options.project !== undefined && !options.project.startsWith('/')) throw new ConnectorError('Use an absolute --project directory.');
  const servers: Record<string, Server> = {};
  const skipped: ClientConfig['skipped'] = [];
  for (const c of (await readProfile(options.home)).connectors) {
    if (c.kind !== 'mcp-stdio' && c.kind !== 'mcp-http') continue;
    // Same selector rule as exec: a server is generated only for listed clients and lanes.
    if (!c.tools.includes(client) || !c.lanes.includes(lane)) continue;
    if (c.kind === 'mcp-http') {
      if (c.credentials.length) { skipped.push({ id: c.id, reason: 'HTTP header credentials are not injected in this version. Use an mcp-stdio bridge connector or a credential-free endpoint.' }); continue; }
      servers[c.id] = client === 'claude' ? { type: 'http', url: c.url! } : { url: c.url! };
      continue;
    }
    // The command is the profile's own; exec appends the profile args at launch.
    const project = options.project ? ['--project', options.project] : [];
    servers[c.id] = { command: 'phm', args: ['connectors', 'exec', c.id, '--tool', client, '--lane', lane, ...project, '--', c.command!] };
  }
  const config = client === 'codex'
    ? stringify({ mcp_servers: servers })
    : `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
  assertMetadata(config);
  return { client: client as Client, lane, format: client === 'codex' ? 'toml' : 'json', servers: Object.keys(servers), skipped, config };
}
