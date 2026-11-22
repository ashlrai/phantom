import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetMasonDigest } from '../src/cli/fleet-mason-digest.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { setLiveOverride } from '../src/core/fleet/dynconfig.js';
import { emptyOwnerSettings } from '../src/core/comms/owner-channel.js';
import {
  buildMasonDigest, MASON_DIGEST_SCHEMA, tickMasonDigest, type MasonDigestInputs, type MasonDigestReaders,
} from '../src/core/comms/mason-digest.js';
import type { SpendRow } from '../src/core/usage/spend.js';

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const HOUR = 3_600_000;

const counts = (over: Record<string, number | null>) => ({ launched: 5, published: 4, merged: 3, finished: 5, empty: 1, empty_rate: 0.2, median_publish_to_merge_s: 540, merge_time_unknown: 0, ...over });
const throughput = (over: Record<string, number | null> = {}) => ({ schema: 'throughput.v1', metrics: 'ok', hours: 1, totals: counts(over), buckets: [], groups: [] }) as unknown as MasonDigestInputs['throughput'];
const pool = (name: string, used: number | null, hours: number | null): SpendRow => ({ pool: name, unit: 'percent', usedPercent: used, hoursLeft: hours, status: used === null ? 'unknown' : 'on-pace' }) as SpendRow;
const spend = (pools: SpendRow[]) => ({ schema: 'usage.spend.v1', v: 1, asOf: null, headline: 'x', pools }) as unknown as MasonDigestInputs['spend'];

const busy = (): MasonDigestInputs => ({
  throughput: throughput(),
  slots: [{ lane: 'claude', running: 3, capacity: 4 }, { lane: 'zai', running: 2, capacity: 3 }],
  releases: [{ repo: 'phantom', tag: 'v1.2.3', publishedAt: new Date(NOW - 20 * 60_000).toISOString() }, { repo: 'locus', tag: 'v0.1.0', publishedAt: new Date(NOW - 3 * 86_400_000).toISOString() }],
  spend: spend([pool('claude', 62.4, 5.04), pool('zai', 10, 100.2)]),
  asks: [{ id: 'a1', limit: 'secrets' }, { id: 'a2', limit: 'money' }, { id: 'a3', limit: 'outside-send' }],
});
const quiet = (): MasonDigestInputs => ({
  throughput: throughput({ merged: 0, launched: 0, published: 0, finished: 0, empty: 0, empty_rate: null, median_publish_to_merge_s: null }),
  slots: [{ lane: 'claude', running: 0, capacity: 4 }], releases: [{ repo: 'phantom', tag: 'v1', publishedAt: new Date(NOW - 5 * 86_400_000).toISOString() }],
  spend: spend([pool('claude', 20, 40)]), asks: [],
});
const unknownPools = (): MasonDigestInputs => ({ ...busy(), spend: null });

describe('buildMasonDigest', () => {
  it('summarises a busy hour in six plain lines', () => {
    const d = buildMasonDigest(busy(), NOW, NOW - HOUR);
    expect(d.schema).toBe(MASON_DIGEST_SCHEMA);
    expect(d.lines).toEqual([
      'Merged: 3 PRs in the last hour, median 9 min to merge.',
      'Releases: 1 published.',
      'Lanes: 5 busy of 7 target.',
      'Pools: claude 62% used, resets in 5h; zai 10% used, resets in 100.2h.',
      'Wasted launches: 20%.',
      'Needs you: 2 (password or sign-in, payment).',
    ]);
    expect(d.has_news).toBe(true);
    expect(d.asks).toBe(2);
  });

  it('a quiet hour has no news and says nothing needs Mason', () => {
    const d = buildMasonDigest(quiet(), NOW, NOW - HOUR);
    expect(d.has_news).toBe(false);
    expect(d.lines[0]).toBe('Merged: 0 PRs in the last hour, median none to merge.');
    expect(d.lines[4]).toBe('Wasted launches: none finished.');
    expect(d.lines[5]).toBe('Needs you: nothing.');
  });

  it('prints unknown, never 0, for a missing pool reading and unreadable sources', () => {
    expect(buildMasonDigest(unknownPools(), NOW, NOW - HOUR).lines[3]).toBe('Pools: unknown.');
    const none = buildMasonDigest({ throughput: null, slots: null, releases: null, spend: null, asks: null }, NOW, NOW - HOUR);
    expect(none.lines).toEqual([
      'Merged: unknown (the job ledger could not be read).', 'Releases: unknown.', 'Lanes: unknown of unknown target.', 'Pools: unknown.',
      'Wasted launches: unknown.', 'Needs you: unknown (the ask ledger could not be read).',
    ]);
    expect([none.merged, none.releases_published, none.lanes_busy, none.asks, none.wasted_launch_rate]).toEqual([null, null, null, null, null]);
    expect(none.has_news).toBe(false);
    const partial = buildMasonDigest({ ...busy(), spend: spend([pool('claude', 50, null)]) }, NOW, NOW - HOUR);
    expect(partial.lines[3]).toBe('Pools: claude 50% used, resets in unknown.');
  });
});

describe('tickMasonDigest', () => {
  let runsDir: string;
  beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'digest-')); });
  afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

  const post = vi.fn(async () => ({ status: 'accepted' as const }));
  beforeEach(() => { post.mockClear(); });
  const readers = (inputs: MasonDigestInputs): Partial<MasonDigestReaders> => ({
    throughput: async () => inputs.throughput!, slots: async () => inputs.slots, releases: async () => inputs.releases!, spend: async () => inputs.spend!, asks: () => inputs.asks,
  });
  const tick = (inputs: MasonDigestInputs, at: number, extra: Partial<Parameters<typeof tickMasonDigest>[0]> = {}) => tickMasonDigest({
    runsDir, now: at, apply: true, owner: { runsDir, settings: emptyOwnerSettings() }, readOff: async () => false, readers: readers(inputs), post, ...extra,
  });

  it('posts a busy hour once, as one line group to the owner thread writer', async () => {
    const r = await tick(busy(), NOW);
    expect(r.state).toBe('posted');
    expect(post).toHaveBeenCalledTimes(1);
    const [input] = post.mock.calls[0] as unknown as [{ text: string; idempotencyKey: string }];
    expect(input.text.split('\n').length).toBeLessThanOrEqual(6);
    expect(input.idempotencyKey).toMatch(/^mason-digest-\d+$/);
  });

  it('does not post a quiet hour', async () => {
    expect((await tick(quiet(), NOW)).state).toBe('quiet');
    expect(post).not.toHaveBeenCalled();
  });

  it('posts at most once an hour, and again only when something changed', async () => {
    expect((await tick(busy(), NOW)).state).toBe('posted');
    const changed = { ...busy(), asks: [{ id: 'a9', limit: 'secrets' as const }] };
    expect((await tick(changed, NOW + 30 * 60_000)).state).toBe('rate-limited');
    expect((await tick(busy(), NOW + 61 * 60_000)).state).toBe('unchanged');
    expect((await tick(changed, NOW + 61 * 60_000)).state).toBe('posted');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('stays off when the kill switch is on or unreadable, and does nothing on a dry run', async () => {
    expect((await tick(busy(), NOW, { readOff: async () => true })).state).toBe('off');
    expect((await tick(busy(), NOW, { readOff: async () => null })).state).toBe('off');
    expect((await tick(busy(), NOW, { apply: false })).state).toBe('dry-run');
    expect(post).not.toHaveBeenCalled();
  });

  it('honors the real live-config kill switch before reading any fleet inputs', async () => {
    await setLiveOverride({ key: 'mason.digest.off', value: 1, by: 'test', reason: 'pause digest' }, { runsDir });
    const read = vi.fn();
    expect((await tick(busy(), NOW, { readOff: undefined, readers: { throughput: read } })).state).toBe('off');
    expect(read).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('does not record a post the thread refused, so the next tick retries', async () => {
    const refuse = vi.fn(async () => ({ status: 'unavailable' as const }));
    expect((await tick(busy(), NOW, { post: refuse })).state).toBe('unavailable');
    expect((await tick(busy(), NOW + 60_000)).state).toBe('posted');
  });
});

describe('phm fleet mason-digest', () => {
  let runsDir: string;
  const logs: string[] = [];
  beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'digest-cli-')); logs.length = 0; vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); }); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(runsDir, { recursive: true, force: true }); });
  const inputs = busy();
  const readers: Partial<MasonDigestReaders> = { throughput: async () => inputs.throughput!, slots: async () => inputs.slots, releases: async () => inputs.releases!, spend: async () => inputs.spend!, asks: () => inputs.asks };

  it('is discoverable through the fleet convention loader', async () => {
    const module = await FLEET_SUBCOMMAND_LOADERS['mason-digest']!();
    expect(module.cmdFleetMasonDigest).toBe(cmdFleetMasonDigest);
    expect(await cmdFleetMasonDigest(['--help'])).toBe(0);
    expect(logs[0]).toContain('phm fleet mason-digest');
  });

  it('dry run prints the lines and posts nothing', async () => {
    const post = vi.fn(async () => ({ status: 'accepted' as const }));
    expect(await cmdFleetMasonDigest([], { now: NOW, runsDir, readers, post })).toBe(0);
    expect(logs[0]).toContain('Merged: 3 PRs in the last hour');
    expect(post).not.toHaveBeenCalled();
  });

  it('--json carries the schema id and --post reports the post', async () => {
    const post = vi.fn(async () => ({ status: 'accepted' as const }));
    expect(await cmdFleetMasonDigest(['--json', '--post'], { now: NOW, runsDir, readers, post })).toBe(0);
    const out = JSON.parse(logs[0]!);
    expect(out.schema).toBe('phantom.mason.digest.v1');
    expect(out.post.state).toBe('posted');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('rejects a bad window and unknown flags', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetMasonDigest(['--since', '9999h'], { now: NOW, runsDir, readers })).toBe(2);
    expect(await cmdFleetMasonDigest(['--send'], { now: NOW, runsDir, readers })).toBe(2);
    expect(err).toHaveBeenCalled();
  });
});
