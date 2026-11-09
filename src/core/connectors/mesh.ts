import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { nativeToolDefs } from '../mcp-native.js';
import { readProfile, type Connector } from './profile.js';
import { discoverTools } from './registry.js';

type Availability = 'available' | 'unavailable' | 'unknown';

/** Checks executable presence only; never starts a connector or resolves credentials. */
async function executableAvailability(command: string, path: string): Promise<Availability> {
  if (!isAbsolute(command) && command.includes('/')) return 'unknown';
  const candidates = isAbsolute(command) ? [command] : path.split(delimiter).filter(Boolean).map(dir => join(dir, command));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return 'available'; } catch { /* try the next PATH entry */ }
  }
  return 'unavailable';
}

/** Native tools that act on a browser or desktop; hooks are the gateway's own gated entry points. */
const COMPUTER_USE = ['ashlr_browser_task', 'ashlr_desktop_open'];

/**
 * With `lane`, connectors and registry tools restricted to other lanes are
 * omitted. Empty lane lists mean unrestricted discovery; running a connector
 * still needs an explicitly listed lane, so discovery never implies a grant.
 */
export async function buildToolMesh(home?: string, path = process.env.PATH ?? '', lane?: string) {
  const profile = await readProfile(home);
  const listed = profile.connectors.filter(c => !lane || c.lanes.length === 0 || c.lanes.includes(lane));
  const connectors = await Promise.all(listed.map(async (c: Connector) => ({
    id: c.id,
    kind: c.kind,
    description: c.description ?? null,
    availability: c.command ? await executableAvailability(c.command, path) : 'unknown' as Availability,
    availabilityMeaning: c.command ? 'executable presence only' : 'endpoint not probed',
    permissions: { scopes: c.scopes, agents: c.tools, lanes: c.lanes, credentialBindings: c.credentials.map(binding => binding.binding) },
    route: c.kind === 'cli' ? 'phm connectors run (currently denied pending Security review)' : c.kind === 'plugin' ? 'plugin host; invocation not provided by connector profile' : 'configure in an MCP client or gateway; profile alone does not register it',
  })));
  const native = nativeToolDefs();
  return {
    version: 1,
    lane: lane ?? null,
    capabilities: {
      // Search is client-provided (e.g. an MCP fetch/search server or client built-in); the hub does not proxy it.
      webSearch: { route: 'client-provided search tool or a registered MCP connector', availability: 'unknown' as const, mcpConnectors: connectors.filter(c => c.kind !== 'cli' && c.kind !== 'plugin').map(c => c.id) },
      computerUse: { hooks: native.filter(t => COMPUTER_USE.includes(t.name)).map(t => ({ name: t.name, permission: t.safety })), route: 'ashlr-hub MCP gateway; each call keeps its own confirmation and grant checks' },
      mcp: connectors.filter(c => c.kind === 'mcp-stdio' || c.kind === 'mcp-http').map(c => c.id),
      cli: connectors.filter(c => c.kind === 'cli').map(c => c.id),
    },
    registry: (await discoverTools(home, lane)).map(t => ({
      id: t.id, kind: t.kind, description: t.description, params: t.params, createdBy: t.createdBy, trust: 'agent-authored' as const,
      route: t.kind === 'skill' ? 'phm connectors tool invoke (returns untrusted text; runs nothing)' : 'phm connectors tool invoke (delegates to connector run, currently denied)',
    })),
    nativeTools: native.map(({ name, description, safety, inputSchema }) => ({
      name, description, inputSchema, permission: safety,
      availability: 'unknown' as const,
      route: 'ashlr-hub MCP gateway',
    })),
    connectors,
    setup: 'Use phm wire claude|cursor|codex to register the gateway; registration does not grant authorization.',
  };
}
