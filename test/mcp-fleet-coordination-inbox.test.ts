import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as coordination from '../src/core/fleet/coordination.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

let client: Client;
let server: ReturnType<typeof createFleetServer>;
const name = 'fleet_coordination_inbox';
const now = Date.now();
const board: coordination.FleetBoard = {
  schema: 'fleet.coordination.v1', state: 'known', claims: [], expiredClaims: 0,
  messages: [
    { id: 'm-deploy', from: 'alice', to: 'bob', at: now - 4_000, expiresAt: now + 86_400_000,
      body: 'deploy finished green' },
    { id: 'm-lunch', from: 'carol', to: 'bob', at: now - 3_000, expiresAt: now + 86_400_000,
      body: 'lunch?' },
    { id: 'm-all', from: 'alice', to: 'all', at: now - 2_000, expiresAt: now + 86_400_000,
      body: 'all hands: deploy freeze at noon' },
    { id: 'm-dave', from: 'dave', to: 'carol', at: now - 1_000, expiresAt: now + 86_400_000,
      body: 'not for bob' },
  ],
  proposals: [
    { id: 'p-1', repo: 'ashlrai/phantom', task: 'deploy the inbox fix', to: 'bob',
      at: now - 500, expiresAt: now + 86_400_000, executionAuthorized: false },
    { id: 'p-2', repo: 'ashlrai/other', task: 'unrelated chore', to: 'bob',
      at: now - 400, expiresAt: now + 86_400_000, executionAuthorized: false },
    { id: 'p-3', repo: 'ashlrai/phantom', task: 'carol only', to: 'carol',
      at: now - 300, expiresAt: now + 86_400_000, executionAuthorized: false },
  ],
};

async function read(args: Record<string, unknown> = { agent: 'bob' }) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return { result, text, value: JSON.parse(text) };
}

beforeEach(async () => {
  vi.spyOn(coordination, 'readFleetBoard').mockReturnValue(structuredClone(board));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  server = createFleetServer();
  await server.connect(st);
  client = new Client({ name: 'inbox-example', version: '1.0.0' });
  await client.connect(ct);
});
afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.restoreAllMocks();
});

describe('fleet coordination inbox real MCP handler', () => {
  it('lists agent plus the shared inbox filters with read-only annotations', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === name);
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['agent'] });
    expect(Object.keys((tool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).sort())
      .toEqual(['agent', 'before', 'contains', 'from', 'since']);
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations).toEqual(tools.find(t => t.name === 'fleet_coordination_returns')?.annotations);
  });

  it('returns the addressed messages and proposals, broadcast included', async () => {
    const { result, value } = await read();
    expect(result.isError).not.toBe(true);
    expect(value).toMatchObject({ schema: 'fleet.coordination.v1', state: 'known' });
    expect(value.messages.map((m: { id: string }) => m.id).sort()).toEqual(['m-all', 'm-deploy', 'm-lunch']);
    expect(value.proposals.map((p: { id: string }) => p.id).sort()).toEqual(['p-1', 'p-2']);
    expect(coordination.readFleetBoard).toHaveBeenCalledWith(expect.objectContaining({ reap: false }));
  });

  it('narrows by sender, window and text exactly like the CLI flags', async () => {
    const fromAlice = await read({ agent: 'bob', from: 'alice' });
    expect(fromAlice.value.messages.map((m: { id: string }) => m.id).sort()).toEqual(['m-all', 'm-deploy']);
    // Proposals carry no sender, so a sender read drops every proposal.
    expect(fromAlice.value.proposals).toEqual([]);

    const deploy = await read({ agent: 'bob', contains: 'DEPLOY' });
    expect(deploy.value.messages.map((m: { id: string }) => m.id).sort()).toEqual(['m-all', 'm-deploy']);
    expect(deploy.value.proposals).toHaveLength(1);
    expect(deploy.value.proposals[0].task).toBe('deploy the inbox fix');

    const since = await read({ agent: 'bob', since: String(now - 3_500) });
    expect(since.value.messages.map((m: { id: string }) => m.id).sort()).toEqual(['m-all', 'm-lunch']);

    const before = await read({ agent: 'bob', before: String(now - 2_500) });
    expect(before.value.messages.map((m: { id: string }) => m.id)).toEqual(['m-deploy', 'm-lunch']);
    expect(before.value.proposals).toEqual([]);
  });

  it('reports an unreadable ledger as unknown without exposing thrown text', async () => {
    vi.mocked(coordination.readFleetBoard).mockImplementation(() => { throw new Error('private-reader-detail'); });
    const { result, text, value } = await read();
    expect(result.isError).not.toBe(true);
    expect(value).toMatchObject({ schema: 'fleet.coordination.v1', state: 'unknown', messages: [], proposals: [] });
    expect(text).not.toContain('private-reader-detail');
  });

  it('reports a verified-empty ledger honestly', async () => {
    vi.mocked(coordination.readFleetBoard).mockReturnValue({ schema: 'fleet.coordination.v1', state: 'unknown',
      claims: [], messages: [], proposals: [], expiredClaims: null });
    const { value } = await read();
    expect(value).toMatchObject({ state: 'unknown', messages: [], proposals: [] });
  });

  it.each(['path', 'root', 'cwd', 'limit', 'agent2'])('rejects caller %s before reading', async key => {
    await expect(client.callTool({ name, arguments: { agent: 'bob', [key]: '/synthetic/private' } }))
      .rejects.toMatchObject({ code: -32602 });
    expect(coordination.readFleetBoard).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { agent: '' },
    { agent: 'bad agent' },
    { agent: 42 },
    { agent: 'bob', from: 'bad from' },
    { agent: 'bob', from: 7 },
    { agent: 'bob', since: 'not-a-time' },
    { agent: 'bob', before: 'whenever' },
    { agent: 'bob', contains: '' },
    { agent: 'bob', contains: 'x'.repeat(513) },
    { agent: 'bob', unknown: 'filter' },
  ])('rejects malformed arguments %j before reading the ledger', async args => {
    await expect(client.callTool({ name, arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
    expect(coordination.readFleetBoard).not.toHaveBeenCalled();
  });
});
