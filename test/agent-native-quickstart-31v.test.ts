import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TOP_LEVEL_COMMANDS } from '../src/cli/completions.js';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdKnowledge } from '../src/cli/knowledge.js';
import { cmdMcp } from '../src/cli/mcp.js';
import { cmdVerse } from '../src/cli/verse.js';
import { listNativeTools } from '../src/core/mcp-native.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

const guide = readFileSync(new URL('../docs/AGENT-NATIVE-QUICKSTART.md', import.meta.url), 'utf8');

afterEach(() => vi.restoreAllMocks());

describe('agent-native quickstart contracts', () => {
  it('uses CLI verbs advertised by their live command help', async () => {
    let output = '';
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { output += args.join(' ') + '\n'; });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    });
    const handlers = { fleet: cmdFleet, knowledge: cmdKnowledge, mcp: cmdMcp, verse: cmdVerse };
    const commands = [...guide.matchAll(/^phm ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/gm)];
    expect(commands.length).toBeGreaterThan(0);
    for (const [, group, verb] of commands) {
      expect(TOP_LEVEL_COMMANDS).toContain(group);
      expect(Object.keys(handlers)).toContain(group);
      output = '';
      const handler = handlers[group as keyof typeof handlers];
      expect(await handler(['--help'])).toBe(0);
      if (verb) expect(output, `phm ${group} ${verb}`).toMatch(new RegExp(`\\b${verb}\\b`));
    }
  });

  it('names only registered team and read-only fleet MCP tools', async () => {
    const native = new Set(listNativeTools().map(tool => tool.name));
    const teamNames = new Set(guide.match(/\bphm_team_[a-z_]+\b/g));
    expect(teamNames.size).toBeGreaterThan(0);
    for (const name of teamNames) expect(native.has(name), name).toBe(true);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createFleetServer({ status: async () => ({}), loop: async () => ({}) });
    const client = new Client({ name: 'quickstart-contract', version: '1.0.0' });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const advertised = new Set((await client.listTools()).tools.map(tool => tool.name));
      const fleetNames = new Set(guide.match(/\bfleet_[a-z_]+\b/g));
      expect(fleetNames.size).toBe(2);
      for (const name of fleetNames) expect(advertised.has(name), name).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
