import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimFleetWork, postFleetMessage, proposeFleetAssignment } from '../src/core/fleet/coordination.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

let dir: string;
let path: string;
let client: Client;
let server: ReturnType<typeof createFleetServer>;
const name = 'fleet_coordination_board';
async function read() {
  const result = await client.callTool({ name, arguments: {} });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return { text, value: JSON.parse(text) };
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'board-mcp-'));
  path = join(dir, 'coordination.jsonl');
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', path);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  server = createFleetServer();
  await server.connect(st);
  client = new Client({ name: 'board-example', version: '1.0.0' });
  await client.connect(ct);
});
afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('fleet coordination board real MCP handler', () => {
  it('advertises a read-only tool and serves the whole board without leases or writes', async () => {
    const tool = (await client.listTools()).tools.find(t => t.name === name);
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    expect((await read()).value).toMatchObject({ v: 1, source: 'coordination-ledger',
      schema: 'fleet.coordination.v1', state: 'unknown', claims: [], messages: [], proposals: [], expiredClaims: null });
    const claim = claimFleetWork({ repo: 'ashlrai/phantom', task: 'board work', agent: 'dot-board' });
    expect(claim.ok).toBe(true);
    if (!claim.ok) throw new Error('fixture claim failed');
    expect(postFleetMessage({ from: 'dot-board', to: 'all', body: 'board hello' }).ok).toBe(true);
    expect(proposeFleetAssignment({ repo: 'ashlrai/phantom', task: 'board assign', to: 'dot-board' }).ok).toBe(true);
    const before = readFileSync(path, 'utf8');
    const output = await read();
    expect(output.value).toMatchObject({ v: 1, source: 'coordination-ledger', state: 'known', expiredClaims: 0 });
    expect(Number.isFinite(Date.parse(output.value.asOf))).toBe(true);
    expect(output.value.claims).toHaveLength(1);
    expect(output.value.claims[0]).toMatchObject({ repo: 'ashlrai/phantom', task: 'board work', agent: 'dot-board' });
    expect(output.value.messages).toHaveLength(1);
    expect(output.value.messages[0]).toMatchObject({ from: 'dot-board', to: 'all', body: 'board hello' });
    expect(output.value.proposals).toHaveLength(1);
    expect(output.value.proposals[0]).toMatchObject({ repo: 'ashlrai/phantom', task: 'board assign',
      to: 'dot-board', executionAuthorized: false });
    for (const forbidden of [claim.value.lease, 'leaseHash', 'lease']) expect(output.text).not.toContain(forbidden);
    expect(readFileSync(path, 'utf8')).toBe(before);
    chmodSync(path, 0o644);
    expect((await read()).value).toMatchObject({ state: 'unknown', claims: [], messages: [], proposals: [], expiredClaims: null });
    chmodSync(path, 0o600);
    expect((await read()).value).toMatchObject({ state: 'known' });
    expect((await read()).value.claims).toHaveLength(1);
  });

  it.each(['path', 'root', 'cwd', 'workingDirectory', 'limit', 'agent', 'from'])(
    'refuses caller %s', async key => {
      await expect(client.callTool({ name, arguments: { [key]: '/synthetic/private' } }))
        .rejects.toMatchObject({ code: -32602 });
    });
});
