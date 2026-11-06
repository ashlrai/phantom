import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { readFleetResetGroupAwait } from '../../src/mcp/fleet-reset-group-await.js';
import { awaitResetGroup } from '../../src/core/fleet/reset-group-await.js';
import type { UsageResetsV1 } from '../../src/core/fleet/usage-reset-detect.js';

const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });
async function connect(resetGroupAwait?: FleetReaders['resetGroupAwait']) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'group-test', version: '1' });
  clients.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}), resetGroupAwait }).connect(st);
  await client.connect(ct);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);

describe('fleet_reset_group_await', () => {
  it('advertises the bounded read-only operation', async () => {
    const tool = (await (await connect()).listTools()).tools.find(item => item.name === 'fleet_reset_group_await');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toMatchObject({ required: ['lanes', 'timeoutMs'], additionalProperties: false,
      properties: { lanes: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 60000 }, pollMs: { type: 'integer', minimum: 1, maximum: 60000 } } });
    expect(tool?.description).toMatch(/not release authority, free quota, lane health or launch success/);
  });

  it('rejects invalid arguments before invoking the reader', async () => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    for (const args of [ {}, { lanes: null, timeoutMs: 1 }, { lanes: [], timeoutMs: 1 },
      { lanes: ['aa', 'aa'], timeoutMs: 1 }, { lanes: Array.from({ length: 17 }, (_, i) => `lane${i}`), timeoutMs: 1 },
      ...['', ' a', 'a/b', '../x', null, 3].map(lane => ({ lanes: [lane], timeoutMs: 1 })),
      ...[null, 0, -1, 1.5, 60001, '1'].map(timeoutMs => ({ lanes: ['aa'], timeoutMs })),
      ...[null, 0, 2, 1.5, '1'].map(pollMs => ({ lanes: ['aa'], timeoutMs: 1, pollMs })),
      ...['root', 'runsDir', 'after', 'signal', 'extra'].map(key => ({ lanes: ['aa'], timeoutMs: 1, [key]: 'fake' })) ]) {
      await expect(client.callTool({ name: 'fleet_reset_group_await', arguments: args })).rejects.toThrow();
    }
    expect(reader).not.toHaveBeenCalled();
    const input = { lanes: ['aa', 'bb'], timeoutMs: 60000, pollMs: 60000 };
    await client.callTool({ name: 'fleet_reset_group_await', arguments: input });
    expect(reader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledWith(input);
  });

  it('projects public fields for all outcomes and invokes the group waiter once', async () => {
    for (const outcome of ['observed', 'deadline', 'cancelled', 'failed'] as const) {
      const fake = vi.fn(async () => ({ v: 1 as const, authority: 'none' as const, outcome, checks: 1,
        observed: [{ lane: 'aa', state: 'reset-detected' as const, heldBy: 'autobackoff' as const,
          readingAsOf: '2026-01-01T00:00:00.000Z', private: '/private/row' }], pending: ['bb'], private: '/private/source' }));
      const client = await connect(input => readFleetResetGroupAwait(input, fake));
      const value = parse(await client.callTool({ name: 'fleet_reset_group_await', arguments: { lanes: ['aa', 'bb'], timeoutMs: 50 } }));
      expect(value).toEqual({ v: 1, authority: 'none', outcome, checks: 1,
        observed: [{ lane: 'aa', state: 'reset-detected', heldBy: 'autobackoff', readingAsOf: '2026-01-01T00:00:00.000Z' }], pending: ['bb'] });
      expect(fake).toHaveBeenCalledOnce();
      expect(fake).toHaveBeenCalledWith({ lanes: ['aa', 'bb'], timeoutMs: 50, pollMs: 50 });
      expect(JSON.stringify(value)).not.toContain('/private');
    }
  });

  it('delegates to the real waiter with a fake ledger and clock', async () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    let wallCalls = 0;
    const ledger = vi.fn(async () => ({ sourceState: 'healthy', rows: [
      { lane: 'aa', held: true, heldBy: 'autobackoff', state: 'reset-detected', readingAsOf: new Date(base + 1).toISOString() },
      { lane: 'bb', held: true, heldBy: 'autobackoff', state: 'reset-time-passed', readingAsOf: new Date(base + 1).toISOString() },
    ] }) as UsageResetsV1);
    const client = await connect(input => readFleetResetGroupAwait(input, (options, deps) =>
      awaitResetGroup(options, { ...deps, read: ledger, now: () => 0, wallNow: () => base + (wallCalls++ ? 2 : 0) })));
    const value = parse(await client.callTool({ name: 'fleet_reset_group_await', arguments: { lanes: ['aa', 'bb'], timeoutMs: 100 } }));
    expect(value).toMatchObject({ outcome: 'observed', checks: 1, pending: [], observed: [{ lane: 'aa' }, { lane: 'bb' }] });
    expect(ledger).toHaveBeenCalledOnce();
    expect(ledger).toHaveBeenCalledWith({ runsDir: undefined });
  });

  it('returns partial evidence at the deadline and bounds a stalled ledger read', async () => {
    let count = 0;
    const base = Date.now();
    const client = await connect(input => readFleetResetGroupAwait(input, (options, deps) => awaitResetGroup(options, {
      ...deps, wallNow: () => base + (count++ ? 2 : 0), read: async () => ({ sourceState: 'healthy', rows: [
        { lane: 'aa', held: true, heldBy: 'autobackoff', state: 'reset-detected', readingAsOf: new Date(base + 1).toISOString() },
      ] }) as UsageResetsV1,
    })));
    const partial = parse(await client.callTool({ name: 'fleet_reset_group_await', arguments: { lanes: ['aa', 'bb'], timeoutMs: 40 } }));
    expect(partial).toMatchObject({ outcome: 'deadline', observed: [{ lane: 'aa' }], pending: ['bb'] });
    const stalled = await connect(input => readFleetResetGroupAwait(input, (options, deps) =>
      awaitResetGroup(options, { ...deps, read: () => new Promise(() => {}) })));
    const start = Date.now();
    const value = parse(await stalled.callTool({ name: 'fleet_reset_group_await', arguments: { lanes: ['aa'], timeoutMs: 40 } }));
    expect(value).toMatchObject({ outcome: 'deadline', checks: 0, pending: ['aa'] });
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
