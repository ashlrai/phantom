import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { inventoryStaging } from '../src/core/fleet/staging-inventory.js';
import { createFleetServer } from '../src/mcp/fleet-server.js';
import { readStagingBatch, type StagingScanner } from '../src/mcp/fleet-staging-inventory-batch.js';

const roots = ['/tmp/fake-staging-a', '/tmp/fake-staging-b', '/tmp/fake-staging-c'];
const report = (root: string) => inventoryStaging(root, {
  list: async () => ({ state: 'ok', children: [], skippedSymlinks: 0, truncated: false }),
});
const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });

async function connect(scan: StagingScanner) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createFleetServer({ status: async () => ({}), loop: async () => ({}), stagingScanner: scan });
  const client = new Client({ name: 'staging-cancel-test', version: '1' });
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('staging batch cancellation', () => {
  it('does not scan a pre-aborted batch', async () => {
    const controller = new AbortController(); controller.abort();
    const seen: string[] = [];
    const result = await readStagingBatch(roots, async root => { seen.push(root); return report(root); }, controller.signal);
    expect(seen).toEqual([]);
    expect(result).toMatchObject({ requested: 3, completed: 0, cancelled: true, complete: false,
      reports: roots.map(root => ({ root, source: 'unattempted', complete: false })) });
  });

  it('preserves settled evidence and marks later roots unattempted', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const result = await readStagingBatch(roots, async root => {
      seen.push(root);
      const value = await report(root);
      controller.abort();
      return value;
    }, controller.signal);
    expect(seen).toEqual([roots[0]]);
    expect(result).toMatchObject({ requested: 3, completed: 1, cancelled: true, complete: false,
      reports: [{ root: roots[0], complete: true }, { root: roots[1], source: 'unattempted', complete: false },
        { root: roots[2], source: 'unattempted', complete: false }] });
  });

  it('keeps the ordinary response compatible', async () => {
    const seen: string[] = [];
    const result = await readStagingBatch(roots, async root => { seen.push(root); return report(root); });
    expect(seen).toEqual(roots);
    expect(result).toMatchObject({ schema: 'fleet.staging-inventory-batch.v1', requested: 3, completed: 3,
      reports: roots.map(root => ({ root, complete: true })) });
    expect(result).not.toHaveProperty('cancelled');
    expect(result).not.toHaveProperty('complete');
  });

  it('stops admitting roots after a real MCP request is cancelled during a scan', async () => {
    let release!: () => void;
    let started!: () => void;
    let settled!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const firstSettled = new Promise<void>(resolve => { settled = resolve; });
    const seen: string[] = [];
    const client = await connect(async root => {
      seen.push(root); started();
      await gate;
      const value = await report(root);
      settled();
      return value;
    });
    const controller = new AbortController();
    const call = client.callTool({ name: 'fleet_staging_inventory_batch', arguments: { roots } }, undefined, { signal: controller.signal });
    const rejected = expect(call).rejects.toThrow();
    await firstStarted;
    controller.abort();
    await rejected;
    release();
    await firstSettled;
    // Allow the handler's await continuation to observe cancellation.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(seen).toEqual([roots[0]]);
  });
});
