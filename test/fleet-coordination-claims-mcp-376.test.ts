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
    const schema = tool?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    expect(Object.keys(schema?.properties ?? {}).sort())
      .toEqual(['agent', 'before', 'contains', 'excludeAgent', 'id', 'repo', 'since']);
    expect((await read()).value).toMatchObject({ state: 'unknown', expiredClaims: null });
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

  it.each(['path', 'root', 'cwd', 'workingDirectory', 'limit'])('refuses caller %s', async key => {
    await expect(client.callTool({ name, arguments: { [key]: '/synthetic/private' } }))
      .rejects.toMatchObject({ code: -32602 });
  });

  it('applies the shared filter set and refuses malformed values', async () => {
    const first = claimFleetWork({ repo: 'ashlrai/phantom', task: 'alpha held', agent: 'agent-a' });
    const second = claimFleetWork({ repo: 'other/repo', task: 'beta held', agent: 'agent-b' });
    if (!first.ok || !second.ok) throw new Error('fixture claims failed');

    const byAgent = await read({ agent: 'agent-a' });
    expect(byAgent.value.claims.map((c: { id: string }) => c.id)).toEqual([first.value.claim.id]);
    expect(byAgent.value.matched).toBe(1);

    const excluded = await read({ excludeAgent: 'agent-a' });
    expect(excluded.value.claims.map((c: { id: string }) => c.id)).toEqual([second.value.claim.id]);

    const byId = await read({ id: second.value.claim.id });
    expect(byId.value.claims).toHaveLength(1);
    expect(byId.value.claims[0].id).toBe(second.value.claim.id);

    const byRepo = await read({ repo: 'ASHLRAI/Phantom' });
    expect(byRepo.value.claims.map((c: { id: string }) => c.id)).toEqual([first.value.claim.id]);

    const needle = await read({ contains: 'BETA' });
    expect(needle.value.claims.map((c: { id: string }) => c.id)).toEqual([second.value.claim.id]);

    // A filtered-empty read is an honest known empty, never an invented row.
    const miss = await read({ agent: 'nobody' });
    expect(miss.value).toMatchObject({ state: 'known', claims: [], matched: 0, omitted: 0 });

    // Malformed values and non-string types are refused before the ledger.
    for (const bad of [{ agent: 'has space' }, { repo: 'no-slash' }, { since: 'bogus' },
      { agent: 42 }, { contains: '' }, { id: 'x'.repeat(200) }, { unknown: 'x' }]) {
      await expect(client.callTool({ name, arguments: bad })).rejects.toMatchObject({ code: -32602 });
    }
  });
});
