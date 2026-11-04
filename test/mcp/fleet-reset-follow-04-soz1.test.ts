/**
 * RQ-PHX-RESETMCPFOLLOWS04SOZ1 — fleet_reset_follow collects newly recorded
 * reset releases across lanes in one bounded call on the isolated fleet MCP
 * server, delegating to the same follower as `phm fleet reset-follow`.
 * Every source read is an injected fake; no real audit log, clock or provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFleetServer, type FleetReaders } from '../../src/mcp/fleet-server.js';
import {
  MAX_FLEET_RESET_FOLLOW_RECORDS, readFleetResetFollow, type FleetResetFollowArgs,
} from '../../src/mcp/fleet-reset-follow.js';
import { RESET_FOLLOW_SOURCE_LIMIT, followResetReleases } from '../../src/core/fleet/reset-history-follow.js';
import type { readResetReleases, ResetReleaseRecord } from '../../src/core/fleet/usage-reset-release.js';

const T0 = '2026-11-04T19:00:00.000Z', t0 = Date.parse(T0);
const iso = (ms: number): string => new Date(ms).toISOString();
const rec = (lane: string, at: string, over: Partial<ResetReleaseRecord> = {}): ResetReleaseRecord =>
  ({ v: 1, by: 'reset-detect', reason: 'private reason /private/raw', lane, at,
     state: 'reset-detected', usedPct: 3, readingAsOf: '2026-11-04T18:50:00Z',
     heldUntil: '2026-11-04T20:00:00Z', ...over });
/** Fake monotonic clock: each injected sleep advances time; hook fires per sleep. */
const clock = (onSleep?: (calls: number) => void) => {
  const sleeps: number[] = []; let t = 1000;
  return { sleeps, now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; onSleep?.(sleeps.length); } };
};
const seqRead = (seq: ResetReleaseRecord[][]) => { let i = 0; return vi.fn(async () => seq[Math.min(i++, seq.length - 1)]!); };

const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });
async function connect(resetFollow?: FleetReaders['resetFollow']) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'reset-follow-test', version: '1' });
  clients.push(client);
  await createFleetServer({ status: async () => ({}), loop: async () => ({}), resetFollow }).connect(st);
  await client.connect(ct);
  return client;
}
const parse = (result: { content?: unknown }) => JSON.parse((result.content as Array<{ text: string }>)[0].text);

/** The real followResetReleases with an injected audit reader, clock and optional signal override. */
const realFollow = (read: typeof readResetReleases, c: ReturnType<typeof clock>,
    signal?: AbortSignal): typeof followResetReleases =>
  (options, deps) => followResetReleases(
    signal === undefined ? options : { ...options, signal },
    { ...deps, read, now: c.now, wallNow: () => t0, sleep: c.sleep });
const rig = (read: typeof readResetReleases, onSleep?: (calls: number) => void, signal?: AbortSignal) => {
  const c = clock(onSleep);
  const reader: FleetReaders['resetFollow'] = (input: FleetResetFollowArgs) =>
    readFleetResetFollow(input, realFollow(read, c, signal));
  return { c, reader };
};

describe('fleet_reset_follow', () => {
  it('advertises bounded arguments and recorded-release follow semantics', async () => {
    const client = await connect();
    const tool = (await client.listTools()).tools.find(item => item.name === 'fleet_reset_follow');
    expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tool?.inputSchema).toMatchObject({ type: 'object', required: ['timeoutMs'], additionalProperties: false,
      properties: { timeoutMs: { type: 'integer', minimum: 1, maximum: 60000 },
        pollMs: { type: 'integer', minimum: 1, maximum: 60000 },
        lane: { type: 'string', pattern: '\\S' }, after: { type: 'string' } } });
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(['after', 'lane', 'pollMs', 'timeoutMs']);
    expect(tool?.description).toMatch(/recorded past releases, never a live lane-health, capacity or launch-success verdict/);
    expect(tool?.description).toMatch(/never releases a hold, probes a provider or changes a lane/);
    expect(tool?.description).toMatch(/limit when collection stopped at the 200-record bound/);
  });

  it('distinguishes every terminal outcome at the protocol boundary', async () => {
    for (const outcome of ['deadline', 'cancelled', 'failed', 'limit'] as const) {
      const fake = vi.fn(async () => ({ v: 1, authority: 'none' as const, outcome, reads: 2, delivered: 0,
        watermark: T0, sourceLimit: RESET_FOLLOW_SOURCE_LIMIT, note: 'n', records: [] }));
      const client = await connect(fake);
      const raw = await client.callTool({ name: 'fleet_reset_follow', arguments: { timeoutMs: 50 } });
      expect(raw.isError).not.toBe(true);
      expect(parse(raw).outcome).toBe(outcome);
      expect(fake).toHaveBeenCalledWith({ timeoutMs: 50 });
    }
  });

  it('rejects malformed, out-of-bounds and root-override arguments before invoking', async () => {
    const reader = vi.fn(async () => ({}));
    const client = await connect(reader);
    for (const args of [ {}, { timeoutMs: null }, { timeoutMs: 0 }, { timeoutMs: 60001 },
      { timeoutMs: -5 }, { timeoutMs: 1.5 }, { timeoutMs: '1' }, { timeoutMs: 1, pollMs: null },
      { timeoutMs: 1, pollMs: 0 }, { timeoutMs: 1, pollMs: 2 }, { timeoutMs: 1, pollMs: 1.5 },
      { timeoutMs: 1, pollMs: '5' }, { timeoutMs: 1, lane: null }, { timeoutMs: 1, lane: '' },
      { timeoutMs: 1, lane: '  ' }, { timeoutMs: 1, lane: 5 }, { timeoutMs: 1, after: null },
      { timeoutMs: 1, after: 5 }, { timeoutMs: 1, after: '' }, { timeoutMs: 1, after: 'not-a-date' },
      ...['runsDir', 'runs-dir', 'path', 'root', 'extra', 'signal', 'emit', 'limit', 'deadline']
        .map(key => ({ timeoutMs: 1, [key]: '/fake' })) ]) {
      await expect(client.callTool({ name: 'fleet_reset_follow', arguments: args })).rejects.toThrow();
    }
    expect(reader).not.toHaveBeenCalled();
    await client.callTool({ name: 'fleet_reset_follow',
      arguments: { timeoutMs: 60000, pollMs: 60000, lane: 'x', after: T0 } });
    expect(reader).toHaveBeenCalledOnce();
    expect(reader).toHaveBeenCalledWith({ timeoutMs: 60000, pollMs: 60000, lane: 'x', after: T0 });
  });

  it('a never-settling reader cannot keep the call alive beyond its timeout', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const read = vi.fn(() => new Promise<ResetReleaseRecord[]>(() => {}));
    const client = await connect((input: FleetResetFollowArgs) =>
      readFleetResetFollow(input, (options, deps) => followResetReleases(options, { ...deps, read })));
    const started = Date.now();
    const raw = await client.callTool({ name: 'fleet_reset_follow', arguments: { timeoutMs: 60 } });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(raw.isError).not.toBe(true);
    expect(parse(raw)).toMatchObject({ outcome: 'deadline', reads: 0, delivered: 0, inFlight: true });
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });

  describe('through the real follower', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
      vi.setSystemTime(t0);
    });
    afterEach(() => { vi.useRealTimers(); });

    it('collects newly recorded releases across two lanes in one call, oldest first', async () => {
      // Newest-first source rows: alpha and beta share one timestamp and both
      // flow; the at-or-before-watermark row never emits; repeats dedupe.
      const alpha = rec('alpha', iso(t0 + 5)), beta = rec('beta', iso(t0 + 5)), older = rec('alpha', iso(t0 + 2));
      const read = seqRead([[alpha, beta, older, rec('alpha', iso(t0 - 1000))], [alpha, beta, older]]);
      const { c, reader } = rig(read);
      const client = await connect(reader);
      const raw = await client.callTool({ name: 'fleet_reset_follow', arguments: { timeoutMs: 1000, pollMs: 400 } });
      expect(raw.isError).not.toBe(true);
      const value = parse(raw);
      expect(value).toMatchObject({ v: 1, authority: 'none', outcome: 'deadline', reads: 3,
        delivered: 3, watermark: T0, sourceLimit: RESET_FOLLOW_SOURCE_LIMIT });
      expect(value.records.map((row: { lane: string }) => row.lane)).toEqual(['alpha', 'beta', 'alpha']);
      expect(value.records.map((row: { at: string }) => row.at)).toEqual([iso(t0 + 2), iso(t0 + 5), iso(t0 + 5)]);
      expect(Object.keys(value.records[0] as object).sort())
        .toEqual(['at', 'heldUntil', 'lane', 'readingAsOf', 'state', 'usedPct']);
      expect(value.note).toMatch(/Never a live lane-health, capacity or launch-success verdict/);
      expect(c.sleeps).toEqual([400, 400, 200]);
      for (const call of read.mock.calls) expect(call).toEqual([undefined, 200]); // configured default root
      expect(JSON.stringify(value)).not.toContain('private reason');
      expect(JSON.stringify(value)).not.toContain('/private');
    });

    it('honours an exact lane filter and an exclusive after watermark', async () => {
      const read = seqRead([[rec('beta', iso(t0 + 7)), rec('alpha', iso(t0 + 5)),
        rec('alpha', iso(t0 - 30_000)), rec('alpha', iso(t0 - 60_000))]]);
      const { reader } = rig(read);
      const client = await connect(reader);
      const value = parse(await client.callTool({ name: 'fleet_reset_follow',
        arguments: { timeoutMs: 500, lane: 'alpha', after: iso(t0 - 60_000) } }));
      // beta is lane-filtered; the record stamped exactly at `after` is excluded.
      expect(value).toMatchObject({ outcome: 'deadline', delivered: 2, watermark: iso(t0 - 60_000) });
      expect(value.records.map((row: { at: string }) => row.at)).toEqual([iso(t0 - 30_000), iso(t0 + 5)]);
    });

    it('returns only the public release fields with secrets and paths scrubbed', async () => {
      const dirty = rec('evil\u001b[31m', iso(t0 + 5), { readingAsOf: '/private/reading/path',
        heldUntil: `sk-test-${'F'.repeat(22)}` });
      const { reader } = rig(seqRead([[dirty]]));
      const client = await connect(reader);
      const value = parse(await client.callTool({ name: 'fleet_reset_follow', arguments: { timeoutMs: 100 } }));
      expect(value.delivered).toBe(1);
      expect(value.records[0]).toMatchObject({ lane: 'evil\u001b[31m', at: dirty.at, state: 'reset-detected',
        usedPct: 3, readingAsOf: '[path]', heldUntil: '[REDACTED]' });
      expect('reason' in value.records[0] || 'by' in value.records[0]).toBe(false);
      for (const bad of ['private reason', '/private', 'sk-test-'])
        expect(JSON.stringify(value)).not.toContain(bad);
    });

    it('maps a rejecting audit reader to failed without leaking its error', async () => {
      const read = vi.fn(async (): Promise<ResetReleaseRecord[]> => { throw new Error('/private/reader-secret'); });
      const { reader } = rig(read);
      const client = await connect(reader);
      const raw = await client.callTool({ name: 'fleet_reset_follow', arguments: { timeoutMs: 100, pollMs: 20 } });
      expect(raw.isError).not.toBe(true);
      const value = parse(raw);
      expect(value).toMatchObject({ outcome: 'failed', reads: 0, delivered: 0, records: [] });
      expect(value).not.toHaveProperty('lastError');
      expect(JSON.stringify(value)).not.toContain('/private');
      expect(JSON.stringify(value)).not.toContain('reader-secret');
    });

    it('stops collection at the record bound with an explicit limit outcome and disposes the follower', async () => {
      const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
      const rows = Array.from({ length: MAX_FLEET_RESET_FOLLOW_RECORDS + 5 },
        (_, i) => rec('alpha', iso(t0 + 1 + i)));
      const read = vi.fn(async (): Promise<ResetReleaseRecord[]> => rows);
      const { reader } = rig(read);
      const client = await connect(reader);
      const value = parse(await client.callTool({ name: 'fleet_reset_follow', arguments: { timeoutMs: 60000 } }));
      expect(value).toMatchObject({ outcome: 'limit', delivered: MAX_FLEET_RESET_FOLLOW_RECORDS });
      expect(value.records).toHaveLength(MAX_FLEET_RESET_FOLLOW_RECORDS);
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(5000); // a live follower would read again
      expect(read).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
    });

    it('a cancelled follow reports cancelled, never a false limit or success', async () => {
      const external = new AbortController();
      const { reader } = rig(seqRead([[rec('alpha', iso(t0 + 5))]]), () => external.abort(), external.signal);
      const client = await connect(reader);
      const value = parse(await client.callTool({ name: 'fleet_reset_follow',
        arguments: { timeoutMs: 1000, pollMs: 400 } }));
      expect(value).toMatchObject({ outcome: 'cancelled', delivered: 1 });
      expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves no signal listeners or timers behind after a normal call', async () => {
      const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
      const { reader } = rig(seqRead([[rec('alpha', iso(t0 + 5))]]));
      const client = await connect(reader);
      await client.callTool({ name: 'fleet_reset_follow', arguments: { timeoutMs: 500, pollMs: 200 } });
      expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
