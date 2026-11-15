import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SURFACES, type SurfaceOwnerDeps } from '../src/core/fleet/surface-owner.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { parseFleetSurfaceOwnerArgs, readFleetSurfaceOwner } from '../src/mcp/fleet-surface-owner.js';

const NOW = Date.parse('2026-11-13T14:00:00.000Z');
const deps: SurfaceOwnerDeps = {
  now: () => NOW,
  board: () => ({
    schema: 'fleet.coordination.v1', state: 'known', messages: [], proposals: [], expiredClaims: 0,
    claims: [{ id: 'fake-claim', agent: 'fake-agent', repo: 'fake/repo', task: 'watch dot-handoff fake work',
      claimedAt: NOW - 60_000, expiresAt: NOW + 60_000 }],
  }),
  log: async () => [{ sha: 'abc1234', date: '2026-11-13T12:00:00.000Z',
    subject: 'bridge(RQ-PHX-FAKE1): x (#1)', filesChanged: 1 }],
};
const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });

async function connect(surfaceOwner = (surface: string) => readFleetSurfaceOwner(surface, deps)) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), surfaceOwner });
  const client = new Client({ name: 'fake-agent', version: '1.0.0' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('fleet_surface_owner MCP evidence', () => {
  it.each(Object.keys(SURFACES))('accepts exactly the named surface %s', surface => {
    expect(parseFleetSurfaceOwnerArgs({ surface })).toEqual({ surface });
  });

  it.each([{}, { surface: 'unknown' }, { surface: 'toString' }, { surface: 1 },
    { surface: 'dot-handoff', root: '/fake' }, { surface: 'dot-handoff', path: 'fake' },
    { surface: 'dot-handoff', cwd: '.' }])('refuses %j before any read', async args => {
    expect(parseFleetSurfaceOwnerArgs(args)).toBeNull();
    const reader = vi.fn((surface: string) => readFleetSurfaceOwner(surface, deps));
    const client = await connect(reader);
    await expect(client.callTool({ name: 'fleet_surface_owner', arguments: args }))
      .rejects.toMatchObject({ code: ErrorCode.InvalidParams });
    expect(reader).not.toHaveBeenCalled();
  });

  it('advertises the closed surface enum and returns advisory ownership with landed evidence', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.find(tool => tool.name === 'fleet_surface_owner')).toMatchObject({
      inputSchema: { type: 'object', properties: { surface: { type: 'string', enum: Object.keys(SURFACES) } },
        required: ['surface'], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
    const result = await client.callTool({ name: 'fleet_surface_owner', arguments: { surface: 'dot-handoff' } });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    const report = JSON.parse(text);
    expect(report).toMatchObject({ schemaVersion: 1, authority: 'none', surface: 'dot-handoff',
      asOf: new Date(NOW).toISOString(), owner: 'fake-agent', ownerSource: 'advisory-claim',
      liveClaims: [{ id: 'fake-claim', agent: 'fake-agent', expiresInSeconds: 60 }],
      lastLanded: { jobId: 'RQ-PHX-FAKE1', pr: 1 }, reasons: [], scannedPaths: SURFACES['dot-handoff'] });
    expect(report.note).toContain('Read-only');
    expect(report.note).toContain('advisory only');
    expect(report.note).toContain('no dispatch, claim or merge authority');
    expect(report.note).toContain("this computer's ledger");
    expect(text).not.toContain('watch dot-handoff fake work');
  });

  it.each(['unknown', 'throw'])('keeps ownership UNKNOWN when the board is %s', async state => {
    const report = await readFleetSurfaceOwner('dot-handoff', { ...deps, board: () => {
      if (state === 'throw') throw new Error('fake private ledger path');
      return { schema: 'fleet.coordination.v1', state: 'unknown', claims: [], messages: [], proposals: [], expiredClaims: null };
    } });
    expect(report).toMatchObject({ authority: 'none', owner: 'UNKNOWN', ownerSource: 'none', liveClaims: [],
      reasons: ['coordination ledger: missing or unreadable'], lastLanded: { jobId: 'RQ-PHX-FAKE1', pr: 1 } });
    expect(JSON.stringify(report)).not.toContain('fake private ledger path');
  });
});
