import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { inventoryStaging, ELIGIBILITY } from '../src/core/fleet/staging-inventory.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import type { StagingScanner } from '../src/mcp/fleet-staging-inventory-batch.js';

const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });
async function connect(scanner: StagingScanner) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), stagingScanner: scanner });
  const client = new Client({ name: 'retry-test', version: '1' });
  clients.push(client);
  await server.connect(b); await client.connect(a);
  return client;
}
const report = (root: string) => inventoryStaging(root, { list: async () => ({ state: 'ok', children: [], skippedSymlinks: 0, truncated: false }) });
const batch = (reports: Record<string, unknown>[]) => ({ schema: 'fleet.staging-inventory-batch.v1', requested: reports.length, completed: reports.filter(r => r.complete).length, reports });
async function call(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: 'fleet_staging_inventory_retry', arguments: args });
  return JSON.parse((result.content as { text: string }[])[0]!.text);
}

describe('fleet staging retry MCP', () => {
  it('lists the tool and retries only incomplete roots, preserving the others and order', async () => {
    const seen: string[] = [];
    const client = await connect(async root => { seen.push(root); return report(root); });
    const tool = (await client.listTools()).tools.find(t => t.name === 'fleet_staging_inventory_retry');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool?.inputSchema).toMatchObject({ required: ['report'], additionalProperties: false });
    const complete = await report('/tmp/retry-a');
    const input = batch([complete, { root: '/tmp/retry-b', complete: false, source: 'failed', cleanupEligibility: ELIGIBILITY }]);
    const result = await call(client, { report: input });
    expect(seen).toEqual(['/tmp/retry-b']);
    expect(result).toMatchObject({ requested: 2, completed: 2, reports: [complete, { root: '/tmp/retry-b', complete: true }] });
    expect(result.reports[0]).toEqual(complete);
    expect(JSON.stringify(result)).toContain(ELIGIBILITY);
    expect(input.reports[1]).toMatchObject({ complete: false, source: 'failed' });
  });
  it('keeps scanner failures incomplete and preserves the disclaimer', async () => {
    const client = await connect(async () => { throw new Error('private failure'); });
    const result = await call(client, { report: batch([{ root: '/tmp/retry-b', complete: false, source: 'failed' }]) });
    expect(result).toMatchObject({ requested: 1, completed: 0, reports: [{ root: '/tmp/retry-b', complete: false, source: 'failed', cleanupEligibility: ELIGIBILITY }] });
    expect(JSON.stringify(result)).not.toContain('private failure');
  });
  it('does not scan all-complete or invalid reports', async () => {
    let scans = 0;
    const client = await connect(async root => { scans++; return report(root); });
    const complete = await report('/tmp/retry-a');
    expect(await call(client, { report: batch([complete]) })).toMatchObject({ completed: 1, reports: [complete] });
    for (const args of [{ report: {} }, { report: batch([{ root: 'relative', complete: false, source: 'failed' }]) },
      { report: batch([complete]), extra: true }, { report: { padding: 'x'.repeat(1024 * 1024) } }]) {
      await expect(call(client, args)).rejects.toThrow();
    }
    expect(scans).toBe(0);
  });
});
