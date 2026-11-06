import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { inventoryStaging, ELIGIBILITY } from '../src/core/fleet/staging-inventory.js';
import { createFleetServer, MAX_FLEET_OUTPUT_BYTES } from '../src/mcp/fleet-server.js';
import { type StagingScanner } from '../src/mcp/fleet-staging-inventory-batch.js';

const clients: Client[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function connect(scan?: StagingScanner) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), stagingScanner: scan });
  const client = new Client({ name: 'staging-test', version: '1' });
  clients.push(client);
  await server.connect(b);
  await client.connect(a);
  return client;
}
async function call(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_staging_inventory_batch', arguments: args });
  return { result, text: (result.content as { text: string }[])[0]!.text };
}
const report = (root: string) => inventoryStaging(root, { list: async () => ({ state: 'ok', children: [], skippedSymlinks: 0, truncated: false }) });

describe('fleet staging batch MCP', () => {
  it('lists the read-only tool and scans two normalized roots in order', async () => {
    const seen: string[] = [];
    let active = 0;
    let maximum = 0;
    const client = await connect(async root => {
      active++; maximum = Math.max(maximum, active); seen.push(root);
      await Promise.resolve();
      const result = await report(root); active--; return result;
    });
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_staging_inventory_batch');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool?.inputSchema).toMatchObject({ required: ['roots'], additionalProperties: false });
    const { text } = await call(client, { roots: ['/tmp/a/../a', '/tmp/b'] });
    expect(JSON.parse(text)).toMatchObject({ requested: 2, completed: 2, reports: [{ root: '/tmp/a' }, { root: '/tmp/b' }] });
    expect(seen).toEqual(['/tmp/a', '/tmp/b']);
    expect(maximum).toBe(1);
    expect(text).toContain(ELIGIBILITY);
  });
  it('rejects invalid input before scanning', async () => {
    let calls = 0;
    const client = await connect(async root => { calls++; return report(root); });
    for (const args of [{ roots: ['/tmp/a', '/tmp/x/../a'] }, { roots: ['relative'] },
      { roots: ['/tmp/' + 'x'.repeat(17000)] }, { roots: ['/tmp/a'], extra: true },
      { roots: [] }, { roots: ['/tmp/a\0b'] }, { roots: Array.from({ length: 9 }, (_, i) => `/tmp/${i}`) }]) {
      await expect(call(client, args)).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });
  it('isolates a failed middle root and sanitizes output', async () => {
    const client = await connect(async root => {
      if (root === '/tmp/b') throw new Error('private exception');
      const result = await report(root);
      return { ...result, entries: [{ name: 'person@example.com', modifiedAt: 'now', bytes: 1 }] };
    });
    const { text } = await call(client, { roots: ['/tmp/a', '/tmp/b', '/tmp/c'] });
    expect(JSON.parse(text)).toMatchObject({ requested: 3, completed: 2, reports: [{ complete: true }, { root: '/tmp/b', complete: false, source: 'failed' }, { root: '/tmp/c', complete: true }] });
    expect(text).not.toContain('person@example.com');
    expect(text).not.toContain('private exception');
  });
  it('returns the server cap error without truncating JSON', async () => {
    const client = await connect(async root => ({ ...await report(root), entries: [{ name: 'x'.repeat(MAX_FLEET_OUTPUT_BYTES), modifiedAt: 'now', bytes: 1 }] }));
    const { result, text } = await call(client, { roots: ['/tmp/a'] });
    expect(result.isError).toBe(true);
    expect(text).toContain('exceeds the output limit');
  });
  it('scans tiny temporary directories with the real scanner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'staging-mcp-')); dirs.push(dir);
    const a = join(dir, 'a'); const b = join(dir, 'b');
    mkdirSync(join(a, 'child'), { recursive: true }); mkdirSync(b);
    const client = await connect();
    const { text } = await call(client, { roots: [a, b] });
    const result = JSON.parse(text);
    expect(result).toMatchObject({ requested: 2, completed: 2, reports: [{ complete: true, entries: [{ name: 'child' }] }, { complete: true, entries: [] }] });
  });
});
