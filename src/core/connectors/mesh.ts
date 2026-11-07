import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { nativeToolDefs } from '../mcp-native.js';
import { readProfile, type Connector } from './profile.js';

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

export async function buildToolMesh(home?: string, path = process.env.PATH ?? '') {
  const profile = await readProfile(home);
  const connectors = await Promise.all(profile.connectors.map(async (c: Connector) => ({
    id: c.id,
    kind: c.kind,
    description: c.description ?? null,
    availability: c.command ? await executableAvailability(c.command, path) : 'unknown' as Availability,
    availabilityMeaning: c.command ? 'executable presence only' : 'endpoint not probed',
    permissions: { scopes: c.scopes, agents: c.tools, lanes: c.lanes, credentialBindings: c.credentials.map(binding => binding.binding) },
    route: c.kind === 'cli' ? 'phm connectors run (currently denied pending Security review)' : c.kind === 'plugin' ? 'plugin host; invocation not provided by connector profile' : 'configure in an MCP client or gateway; profile alone does not register it',
  })));
  return {
    version: 1,
    nativeTools: nativeToolDefs().map(({ name, description, safety, inputSchema }) => ({
      name, description, inputSchema, permission: safety,
      availability: 'unknown' as const,
      route: 'ashlr-hub MCP gateway',
    })),
    connectors,
    setup: 'Use phm wire claude|cursor|codex to register the gateway; registration does not grant authorization.',
  };
}
