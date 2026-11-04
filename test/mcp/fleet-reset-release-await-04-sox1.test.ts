import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import { readFleetResetReleaseAwait, type FleetResetReleaseAwaitArgs } from '../../src/mcp/fleet-reset-release-await.js';
import { awaitResetRelease, type ResetReleaseAwaitOutcome } from '../../src/core/fleet/reset-release-await.js';
import type { readResetReleases, ResetReleaseRecord } from '../../src/core/fleet/usage-reset-release.js';

const start = Date.parse('2026-11-04T18:06:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const now = (): number => Date.now() - start;
const record = (over: Record<string, unknown> = {}): ResetReleaseRecord => ({ v: 1, lane: 'alpha',
  at: iso(start + 10), by: 'reset-detect', reason: 'secret reason /private/hidden',
  state: 'reset-detected', usedPct: 3, readingAsOf: null, heldUntil: null, ...over });

const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });
async function connect(resetReleaseAwait?: FleetReaders['resetReleaseAwait']) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'reset-release-await-test', version: '1' });
  clients.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}), resetReleaseAwait }).connect(st);
  await client.connect(ct);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);

describe('fleet_reset_release_await', () => {
  it('advertises bounded arguments and recorded-release audit semantics', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(item => item.name === 'fleet_reset_release_await');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toMatchObject({ type: 'object', required: ['lane', 'timeoutMs'], additionalProperties: false,
      properties: { lane: { type: 'string', pattern: '\\S' }, timeoutMs: { type: 'integer', minimum: 1, maximum: 60000 },
        pollMs: { type: 'integer', minimum: 1, maximum: 60000 } } });
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(['lane', 'pollMs', 'timeoutMs']);
    expect(tool?.description).toMatch(/past audit evidence, never present lane health or successful dispatch/);
    expect(tool?.description).toMatch(/never releases a hold, probes a provider or changes a lane/);
  });

  it('passes all outcomes through the projection and strips audit internals', async () => {
    for (const outcome of ['recorded', 'deadline', 'cancelled', 'failed'] as ResetReleaseAwaitOutcome[]) {
      const fake = vi.fn(async () => ({ v: 1 as const, authority: 'none' as const, outcome,
        lane: '/fake/private/lane', checks: 2,
        release: outcome === 'recorded' ? { timestamp: '2026-01-01T00:00:10.000Z', state: 'reset-detected' as const } : null,
        reason: 'secret /fake/reason', by: 'reset-detect', path: '/fake/source' }));
      const client = await connect((input: FleetResetReleaseAwaitArgs) =>
        readFleetResetReleaseAwait(input, fake as typeof awaitResetRelease));
      const raw = await client.callTool({ name: 'fleet_reset_release_await', arguments: { lane: 'alpha', timeoutMs: 50 } });
      expect(raw.isError).not.toBe(true);
      const value = parse(raw);
      expect(value).toEqual({ v: 1, authority: 'none', outcome, lane: '[path]', checks: 2,
        release: outcome === 'recorded' ? { timestamp: '2026-01-01T00:00:10.000Z', state: 'reset-detected' } : null });
      expect(fake).toHaveBeenCalledWith({ lane: 'alpha', timeoutMs: 50, pollMs: 50 });
      expect(JSON.stringify(value)).not.toContain('/fake');
    }
  });

  it('rejects malformed, out-of-bounds and root override arguments before reading', async () => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    for (const args of [ {}, { lane: '', timeoutMs: 1 }, { lane: '  ', timeoutMs: 1 }, { lane: null, timeoutMs: 1 },
      { lane: 'x', timeoutMs: null }, { lane: 'x', timeoutMs: 0 }, { lane: 'x', timeoutMs: 60001 },
      { lane: 'x', timeoutMs: 1.5 }, { lane: 'x', timeoutMs: '1' }, { lane: 'x', timeoutMs: 1, pollMs: null },
      { lane: 'x', timeoutMs: 1, pollMs: 2 }, { lane: 'x', timeoutMs: 1, pollMs: 0 },
      { lane: 'x', timeoutMs: 1, pollMs: 1.5 }, { lane: 'x', timeoutMs: 1, pollMs: '5' },
      ...['runsDir', 'runs-dir', 'path', 'root', 'extra', 'signal'].map(key => ({ lane: 'x', timeoutMs: 1, [key]: '/fake' })) ]) {
      await expect(client.callTool({ name: 'fleet_reset_release_await', arguments: args })).rejects.toThrow();
    }
    expect(reader).not.toHaveBeenCalled();
    await client.callTool({ name: 'fleet_reset_release_await', arguments: { lane: 'x', timeoutMs: 60000, pollMs: 60000 } });
    expect(reader).toHaveBeenCalledOnce();
  });

  describe('through the real core waiter', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
      vi.setSystemTime(start);
    });
    afterEach(() => { vi.useRealTimers(); });
    /** The real awaitResetRelease with a fake clock and fake audit reader — no fixture result. */
    const realWaiter = (read: typeof readResetReleases): FleetReaders['resetReleaseAwait'] =>
      (input: FleetResetReleaseAwaitArgs) => readFleetResetReleaseAwait(input,
        options => awaitResetRelease(options, { read, now }));

    it('records only after a fresh audit line for the lane lands', async () => {
      const rows: ResetReleaseRecord[] = [record({ at: iso(start - 60_000) })];
      const read = vi.fn(async (): Promise<ResetReleaseRecord[]> => rows);
      const client = await connect(realWaiter(read));
      const pending = client.callTool({ name: 'fleet_reset_release_await',
        arguments: { lane: 'alpha', timeoutMs: 100, pollMs: 20 } });
      await vi.advanceTimersByTimeAsync(20);   // early checks miss the stale line
      const at = iso(Date.now());
      rows.push(record({ at }));               // release audit lands mid-wait
      await vi.advanceTimersByTimeAsync(40);
      const value = parse(await pending);
      expect(value).toEqual({ v: 1, authority: 'none', outcome: 'recorded', lane: 'alpha',
        checks: read.mock.calls.length, release: { timestamp: at, state: 'reset-detected' } });
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
      for (const call of read.mock.calls) expect(call).toEqual([undefined, 200]);  // configured default root
      expect(JSON.stringify(value)).not.toContain('/private');
    });

    it('never satisfies the wait on stale audit lines alone', async () => {
      const read = vi.fn(async (): Promise<ResetReleaseRecord[]> => [record({ at: iso(start - 60_000) })]);
      const client = await connect(realWaiter(read));
      const pending = client.callTool({ name: 'fleet_reset_release_await',
        arguments: { lane: 'alpha', timeoutMs: 100, pollMs: 20 } });
      await vi.advanceTimersByTimeAsync(200);
      const value = parse(await pending);
      expect(value).toEqual({ v: 1, authority: 'none', outcome: 'deadline', lane: 'alpha',
        checks: read.mock.calls.length, release: null });
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('maps a rejecting audit reader to failed without leaking its error', async () => {
      const read = vi.fn(async (): Promise<ResetReleaseRecord[]> => { throw new Error('/private/reader-secret'); });
      const client = await connect(realWaiter(read));
      const raw = await client.callTool({ name: 'fleet_reset_release_await',
        arguments: { lane: 'alpha', timeoutMs: 100, pollMs: 20 } });
      expect(raw.isError).not.toBe(true);
      const value = parse(raw);
      expect(value).toEqual({ v: 1, authority: 'none', outcome: 'failed', lane: 'alpha', checks: 0, release: null });
      expect(JSON.stringify(value)).not.toContain('/private');
    });
  });
});
