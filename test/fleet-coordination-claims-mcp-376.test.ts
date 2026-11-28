import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimFleetWork } from '../src/core/fleet/coordination.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';

let dir: string;
let path: string;
let client: Client;
let server: ReturnType<typeof createFleetServer>;
const name = 'fleet_coordination_claims';
async function read(args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]!.text;
  return { text, value: JSON.parse(text) };
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claims-mcp-376-'));
  path = join(dir, 'coordination.jsonl');
  vi.stubEnv('PHANTOM_FLEET_LEDGER_PATH', path);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  server = createFleetServer();
  await server.connect(st);
  client = new Client({ name: 'claims-example', version: '1.0.0' });
  await client.connect(ct);
});
afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('fleet coordination claims real MCP handler (376)', () => {
  it('advertises a read-only tool and freshly reads real claims without leases or writes', async () => {
    const tool = (await client.listTools()).tools.find(t => t.name === name);
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.inputSchema).toMatchObject({ type: 'object', additionalProperties: false,
      properties: { id: {}, agent: {}, repo: {}, since: {}, before: {}, contains: {} } });
    expect(Object.keys((tool?.inputSchema as { properties: object }).properties).sort())
      .toEqual(['agent', 'before', 'contains', 'id', 'repo', 'since']);
    expect((await read()).value).toMatchObject({ state: 'unknown', expiredClaims: null,
      matched: null, omitted: null });
    const result = claimFleetWork({ repo: 'ashlrai/phantom', task: 'example work', agent: 'dot-example' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('fixture claim failed');
    const before = readFileSync(path, 'utf8');
    const output = await read();
    expect(output.value).toMatchObject({ v: 1, source: 'coordination-ledger', state: 'known', expiredClaims: 0,
      claims: [{ id: result.value.claim.id, repo: 'ashlrai/phantom', task: 'example work', agent: 'dot-example' }] });
    expect(output.value.claims).toHaveLength(1);
    expect(Number.isFinite(Date.parse(output.value.asOf))).toBe(true);
    for (const forbidden of [result.value.lease, 'leaseHash', 'lease', 'messages', 'proposals']) expect(output.text).not.toContain(forbidden);
    expect(readFileSync(path, 'utf8')).toBe(before);
    chmodSync(path, 0o644);
    expect((await read()).value).toMatchObject({ state: 'unknown', claims: [], expiredClaims: null });
    chmodSync(path, 0o600);
    expect((await read()).value.claims).toHaveLength(1);
  });

  it('filters the live claims before the newest-50 slice and reports matched/omitted', async () => {
    const first = claimFleetWork({ repo: 'ashlrai/phantom', task: 'alpha work', agent: 'dot-one' });
    const second = claimFleetWork({ repo: 'ashlrai/other', task: 'beta work', agent: 'dot-two' });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('fixture claims failed');
    const byId = await read({ id: first.value.claim.id });
    expect(byId.value.claims.map((c: { id: string }) => c.id)).toEqual([first.value.claim.id]);
    expect(byId.value).toMatchObject({ state: 'known', matched: 1, omitted: 0 });
    const byAgent = await read({ agent: 'dot-two' });
    expect(byAgent.value.claims.map((c: { id: string }) => c.id)).toEqual([second.value.claim.id]);
    expect(byAgent.value.matched).toBe(1);
    const byRepo = await read({ repo: 'ASHLRAI/PHANTOM' });
    expect(byRepo.value.claims.map((c: { id: string }) => c.id)).toEqual([first.value.claim.id]);
    expect(byRepo.value.matched).toBe(1);
    const byText = await read({ contains: 'BETA' });
    expect(byText.value.claims.map((c: { id: string }) => c.id)).toEqual([second.value.claim.id]);
    const miss = await read({ contains: 'nothing-matches-this' });
    expect(miss.value.claims).toEqual([]);
    expect(miss.value).toMatchObject({ state: 'known', matched: 0, omitted: 0 });
  });

  it.each(['path', 'root', 'cwd', 'workingDirectory', 'limit', 'owner', 'excludeOwner', 'origin', 'job', 'jobs', 'key', 'from', 'result', 'claim', 'thread'])('refuses caller %s', async key => {
    await expect(client.callTool({ name, arguments: { [key]: '/synthetic/private' } }))
      .rejects.toMatchObject({ code: -32602 });
  });

  it.each([{ id: 'bad id!' }, { agent: '' }, { repo: 'not-a-repo' }, { since: 'whenever' },
    { before: '-5' }, { contains: '   ' }, { contains: 'x'.repeat(513) }, { id: 42 }])('refuses malformed filter %j', async args => {
    await expect(client.callTool({ name, arguments: args }))
      .rejects.toMatchObject({ code: -32602 });
  });
});
