import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../src/mcp/fleet-server.js';

const connections: Client[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(connections.splice(0).map(c => c.close()));
});

async function connect(extra: Partial<FleetReaders> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), ...extra });
  const client = new Client({ name: 'claim-notices-test', version: '1.0.0' });
  connections.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const text = (r: { content?: unknown }) => (r.content as Array<{ text: string }>)[0]!.text;

const evidence = {
  v: 1,
  generatedAt: '2026-11-15T00:00:00.000Z',
  source: 'ok',
  bindings: 1,
  sent: { total: 1, recent: [{ state: 'ASSIGNED', claimId: 'J1', at: 123 }] },
  pending: [{ state: 'VERIFIED', threadKey: 'C0FAKE:123.456', text: 'J1 verified' }],
  slackConfigured: true,
};

describe('fleet_claim_notices MCP tool', () => {
  it('is listed with an empty, closed input schema', async () => {
    const { tools } = await (await connect()).listTools();
    const tool = tools.find(t => t.name === 'fleet_claim_notices');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toMatchObject({ properties: {}, additionalProperties: false });
    expect(tool!.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool!.description).toMatch(/durable bus note was written, not that Slack delivered it/);
    expect(tool!.description).toMatch(/pending rows are a dry-run plan/);
    expect(tool!.description).toMatch(/Authority none: never sends, ledgers or writes/);
  });

  it('returns the injected desktop claim-notice view', async () => {
    const client = await connect({ claimNotices: async () => evidence });
    const result = await client.callTool({ name: 'fleet_claim_notices', arguments: {} });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(text(result));
    expect(parsed).toEqual(evidence);
  });

  it('refuses any argument', async () => {
    const client = await connect({ claimNotices: async () => evidence });
    for (const args of [{ root: '/tmp' }, { cwd: '.' }, { limit: 1 }, { send: false }]) {
      await expect(client.callTool({ name: 'fleet_claim_notices', arguments: args })).rejects.toThrow(/Invalid fleet tool arguments/);
    }
  });

  it('a throwing reader reports unknown without thrown text', async () => {
    const client = await connect({ claimNotices: async () => { throw new Error('boom /Users/someone sk-secret'); } });
    const result = await client.callTool({ name: 'fleet_claim_notices', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toEqual({ status: 'unknown', reason: 'claim-notices-unavailable' });
    expect(text(result)).not.toMatch(/boom|sk-|Users/);
  });

  it('treats a reader-thrown timeout as unavailable', async () => {
    const client = await connect({ claimNotices: async () => { throw new Error('timeout'); } });
    const result = await client.callTool({ name: 'fleet_claim_notices', arguments: {} });
    expect(JSON.parse(text(result))).toEqual({ status: 'unknown', reason: 'claim-notices-unavailable' });
  });

  it('a reader that never resolves is bounded to unknown', async () => {
    const client = await connect({ claimNotices: () => new Promise(() => {}) });
    vi.useFakeTimers();
    const pending = client.callTool({ name: 'fleet_claim_notices', arguments: {} });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(JSON.parse(text(result))).toEqual({ status: 'unknown', reason: 'claim-notices-timeout' });
  });
});
