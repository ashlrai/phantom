import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as coordination from '../src/core/fleet/coordination.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

let client: Client;
let server: ReturnType<typeof createFleetServer>;
const name = 'fleet_coordination_returns';
const now = Date.now();
const board: coordination.FleetBoard = {
  schema: 'fleet.coordination.v1', state: 'known', claims: [], proposals: [], expiredClaims: 0,
  messages: [{ id: 'return-claim-392', from: 'dot-example', to: 'all', at: now, expiresAt: now + 86_400_000,
    body: 'RESULT VERIFIED ashlrai/phantom claim claim-392 task "Read returns": pr #392 head abc1234' }],
};

async function read() {
  const result = await client.callTool({ name, arguments: {} });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return { result, text, value: JSON.parse(text) };
}

beforeEach(async () => {
  vi.spyOn(coordination, 'readFleetBoard').mockReturnValue(structuredClone(board));
  const [ct, st] = InMemoryTransport.createLinkedPair();
  server = createFleetServer();
  await server.connect(st);
  client = new Client({ name: 'returns-example', version: '1.0.0' });
  await client.connect(ct);
});
afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.restoreAllMocks();
});

describe('fleet coordination returns real MCP handler (392)', () => {
  it('lists an empty closed schema with the same read-only annotations as claims', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === name);
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations).toEqual(tools.find(t => t.name === 'fleet_coordination_claims')?.annotations);
  });

  it('returns a VERIFIED receipt with its PR and head from the board', async () => {
    const { result, value } = await read();
    expect(result.isError).not.toBe(true);
    expect(value).toMatchObject({ state: 'known', source: 'coordination-ledger', unparsed: 0,
      returns: [{ claimId: 'claim-392', repo: 'ashlrai/phantom', result: 'VERIFIED',
        evidenceKind: 'pr', pr: 392, head: 'abc1234' }] });
    expect(value.returns).toHaveLength(1);
    expect(Number.isFinite(Date.parse(value.asOf))).toBe(true);
    expect(coordination.readFleetBoard).toHaveBeenCalledExactlyOnceWith({ now: Date.parse(value.asOf), reap: false });
  });

  it('reports a throwing reader as unknown without exposing thrown text', async () => {
    vi.mocked(coordination.readFleetBoard).mockImplementation(() => { throw new Error('private-reader-detail'); });
    const { result, text, value } = await read();
    expect(result.isError).not.toBe(true);
    expect(value).toMatchObject({ state: 'unknown', returns: [] });
    expect(text).not.toContain('private-reader-detail');
  });

  it.each(['path', 'root', 'cwd', 'limit'])('rejects caller %s before reading', async key => {
    await expect(client.callTool({ name, arguments: { [key]: '/synthetic/private' } }))
      .rejects.toMatchObject({ code: -32602 });
    expect(coordination.readFleetBoard).not.toHaveBeenCalled();
  });
});
