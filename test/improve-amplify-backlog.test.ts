import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AMPLIFY_MAX_CAPACITY_ITEMS,
  AMPLIFY_MIN_DAYS,
  AMPLIFY_MIN_ROWS,
  amplifyBacklogItems,
  foldAmplifyEvidence,
} from '../src/core/improve/amplify-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const JOURNAL = join('metrics', 'amplify.jsonl');

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = await mkdtemp(join(tmpdir(), 'improve-amplify-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

interface TickOpts {
  actions?: { kind: string; pool?: string | null }[];
  heartbeat?: { stale?: boolean; sources?: { source: string; stale: boolean; reason?: string }[] };
  sources?: Record<string, string>;
}

/** One amplify.tick.v1 row as amplifyTick writes it: the snapshot spread plus schema/type. */
const tick = (at: string, opts: TickOpts = {}): Record<string, unknown> => ({
  schema: 'amplify.tick.v1',
  type: 'ADVISORY',
  at,
  objective: 'maximize verified outcomes',
  advisory: true,
  pools: [],
  vitals: { observed_at: null, load1: null, mem_free_pct: null, swap_gb: null, disk_free_gb: null },
  merge_velocity: { window_hours: 1, merged_per_hour: null },
  heartbeat: { stale: false, sources: [], ...(opts.heartbeat ?? {}) },
  actions: (opts.actions ?? []).map((a) => ({ kind: a.kind, pool: a.pool ?? null, priority: 50, recommendation: 'do the thing' })),
  sources: opts.sources ?? {},
});

const capacity = (pool: string) => ({ kind: 'use-expiring-capacity', pool });
const heartbeatAction = { kind: 'check-heartbeat' };
const mergeFlow = { kind: 'review-merge-flow' };
const refresh = (pool: string | null = null) => ({ kind: 'refresh-evidence', pool });
const saturation = { kind: 'review-saturation', pool: 'lane-a' };

/** Three ticks across two UTC days — the recurring bar. */
const recurringTicks = (make: (at: string) => Record<string, unknown>): string[] => [
  '2026-11-21T09:00:00.000Z', '2026-11-21T15:00:00.000Z', '2026-11-22T10:00:00.000Z',
].map((at) => JSON.stringify(make(at)));

const runsDir = async (name: string, lines: readonly string[]): Promise<string> => {
  const dir = join(home, name);
  await mkdir(join(dir, 'metrics'), { recursive: true });
  await writeFile(join(dir, JOURNAL), lines.join('\n') + '\n');
  return dir;
};

describe('foldAmplifyEvidence', () => {
  it('reports unknown on empty input and counts invalid and out-of-window rows honestly', () => {
    expect(foldAmplifyEvidence([], { nowMs: NOW_MS })).toMatchObject({ state: 'unknown', ticks: 0, capacity: [], heartbeat: null, mergeFlow: null, degraded: [] });
    const ev = foldAmplifyEvidence([
      null, 'junk', {}, { schema: 'other.v1', at: '2026-11-22T00:00:00.000Z' },
      { schema: 'amplify.tick.v1', at: 'not-a-date' },
      { schema: 'amplify.tick.v1', at: 12345 },
      tick('2026-11-22T00:00:00.000Z', { actions: [capacity('pool-a')] }),
      tick('2026-11-01T00:00:00.000Z', { actions: [capacity('pool-a')] }), // outside 7d window
      tick('2026-11-24T00:00:00.000Z', { actions: [capacity('pool-a')] }), // future
    ], { nowMs: NOW_MS });
    expect(ev.invalidRows).toBe(6);
    expect(ev.ticks).toBe(1);
    expect(ev.outsideWindow).toBe(2);
    expect(ev.state).toBe('known');
  });

  it('folds recurring capacity, heartbeat, merge-flow and degraded cells at the bars', () => {
    const lines = recurringTicks((at) => tick(at, {
      actions: [capacity('pool-a'), heartbeatAction, mergeFlow, refresh('pool-a'), saturation],
      heartbeat: { stale: true, sources: [{ source: 'queue/status.json', stale: true, reason: 'old' }] },
      sources: { 'queue/status.json': 'degraded', 'queue/budget-overrides.json': 'missing' },
    }));
    const ev = foldAmplifyEvidence(lines.map((l) => JSON.parse(l)), { nowMs: NOW_MS });
    expect(ev.ticks).toBe(AMPLIFY_MIN_ROWS);
    expect(ev.capacity).toHaveLength(1);
    expect(ev.capacity[0]).toMatchObject({ kind: 'capacity', label: 'pool-a', rows: AMPLIFY_MIN_ROWS, days: AMPLIFY_MIN_DAYS });
    expect(ev.heartbeat).toMatchObject({ kind: 'heartbeat', rows: AMPLIFY_MIN_ROWS, days: AMPLIFY_MIN_DAYS });
    expect(ev.heartbeat!.staleSources).toEqual([{ source: 'queue/status.json', rows: AMPLIFY_MIN_ROWS, reasons: ['old'] }]);
    expect(ev.mergeFlow).toMatchObject({ kind: 'merge-flow', rows: AMPLIFY_MIN_ROWS });
    // refresh('pool-a') recurs; the degraded 'queue/status.json' source recurs; 'missing' never counts; saturation never counts.
    expect(ev.degraded.map((c) => `${c.kind}:${c.label}`).sort()).toEqual([
      'refresh:pool-a',
      'source:queue/status.json',
    ]);
  });

  it('does not count single-day bursts, thin cells, saturation or off-contract kinds', () => {
    // All three ticks on ONE UTC day: days < AMPLIFY_MIN_DAYS.
    const oneDay = ['2026-11-22T01:00:00.000Z', '2026-11-22T05:00:00.000Z', '2026-11-22T09:00:00.000Z']
      .map((at) => tick(at, { actions: [capacity('pool-a'), mergeFlow] }));
    let ev = foldAmplifyEvidence(oneDay, { nowMs: NOW_MS });
    expect(ev.capacity).toEqual([]);
    expect(ev.mergeFlow).toBeNull();

    // Two days but only two qualifying ticks for capacity: rows < AMPLIFY_MIN_ROWS.
    const thin = [
      tick('2026-11-21T09:00:00.000Z', { actions: [capacity('pool-a')] }),
      tick('2026-11-22T09:00:00.000Z', { actions: [capacity('pool-a')] }),
    ];
    ev = foldAmplifyEvidence(thin, { nowMs: NOW_MS });
    expect(ev.capacity).toEqual([]);

    // review-saturation and unknown kinds across many days never recur.
    const noise = recurringTicks((at) => tick(at, { actions: [saturation, { kind: 'mystery' }] }));
    ev = foldAmplifyEvidence(noise.map((l) => JSON.parse(l)), { nowMs: NOW_MS });
    expect(ev.capacity).toEqual([]);
    expect(ev.heartbeat).toBeNull();
    expect(ev.mergeFlow).toBeNull();
    expect(ev.degraded).toEqual([]);
  });

  it('keeps per-pool capacity cells distinct and sorts worst first', () => {
    const lines = [
      ...recurringTicks((at) => tick(at, { actions: [capacity('pool-b')] })),
      ...recurringTicks((at) => tick(at, { actions: [capacity('pool-a'), capacity('pool-b')] })),
    ];
    const ev = foldAmplifyEvidence(lines.map((l) => JSON.parse(l)), { nowMs: NOW_MS });
    expect(ev.capacity.map((c) => c.label)).toEqual(['pool-b', 'pool-a']);
    expect(ev.capacity[0]!.rows).toBe(AMPLIFY_MIN_ROWS * 2);
  });
});

describe('amplifyBacklogItems', () => {
  it('emits capacity, heartbeat, merge-flow and degraded items at the recurring bars', async () => {
    const lines = recurringTicks((at) => tick(at, {
      actions: [capacity('pool-a'), heartbeatAction, mergeFlow, refresh('pool-a')],
      heartbeat: { stale: true, sources: [{ source: 'supervisor/status-mac.md', stale: true, reason: 'old' }] },
      sources: { 'metrics/fleet-controller.jsonl': 'degraded' },
    }));
    const dir = await runsDir('runs-all', lines);
    const items = await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.map((i) => i.id)).toEqual([
      'amplify-expiring-capacity-pool-a',
      'amplify-heartbeat-stale',
      'amplify-merge-flow-stalled',
      'amplify-evidence-degraded',
    ]);
    expect(items.every((i) => i.priority === 3 && i.area === 'amplify')).toBe(true);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(items[0]!.prompt).toContain('pool-a');
    expect(items[0]!.prompt).toContain('metrics/amplify.jsonl');
    expect(items[1]!.prompt).toContain('supervisor/status-mac.md');
    expect(items[2]!.prompt).toContain('merge_rate_1h');
    expect(items[3]!.prompt).toContain('fleet-controller.jsonl');
    expect(items[3]!.prompt).toContain('pool-a');
  });

  it('emits one item per recurring pool up to the cap, with stable slugs', async () => {
    const pools = Array.from({ length: AMPLIFY_MAX_CAPACITY_ITEMS + 2 }, (_, i) => `pool-${i}`);
    const lines = recurringTicks((at) => tick(at, { actions: pools.map((p) => capacity(p)) }));
    const dir = await runsDir('runs-pools', lines);
    const items = await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(AMPLIFY_MAX_CAPACITY_ITEMS);
    expect(items.every((i) => i.id.startsWith('amplify-expiring-capacity-pool-'))).toBe(true);
    // Stable ids: a refresh re-derives the same set.
    const again = await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it('emits nothing below the recurring bars, on missing or unreadable journals, or for another repository', async () => {
    // Single-day burst only.
    const oneDay = ['2026-11-22T01:00:00.000Z', '2026-11-22T05:00:00.000Z', '2026-11-22T09:00:00.000Z']
      .map((at) => tick(at, { actions: [capacity('pool-a')] }));
    const dirOne = await runsDir('runs-oneday', oneDay);
    expect(await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: dirOne, now: new Date(NOW_MS) })).toEqual([]);

    // Missing runs dir and missing journal.
    const empty = await runsDir('runs-empty', []);
    await rm(join(empty, JOURNAL));
    expect(await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW_MS) })).toEqual([]);
    expect(await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);

    // A directory where the journal should be is not a file.
    const dirAsFile = join(home, 'runs-dirfile');
    await mkdir(join(dirAsFile, 'metrics', 'amplify.jsonl'), { recursive: true });
    expect(await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: dirAsFile, now: new Date(NOW_MS) })).toEqual([]);

    // Garbage lines are not evidence.
    const junk = await runsDir('runs-junk', ['not json', '{"schema":"amplify.tick.v1"}', '']);
    expect(await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: junk, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this install's fleet evidence.
    const dir = await runsDir('runs-repo', recurringTicks((at) => tick(at, { actions: [capacity('pool-a'), heartbeatAction] })));
    expect(await amplifyBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await amplifyBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW_MS) })).not.toEqual([]);
  });

  it('honors ASHLR_RUNS_DIR and the limit option', async () => {
    const lines = recurringTicks((at) => tick(at, {
      actions: [capacity('pool-a'), capacity('pool-b'), heartbeatAction, mergeFlow, refresh(null)],
      sources: { 'queue/status.json': 'degraded' },
    }));
    const dir = await runsDir('runs-env', lines);
    process.env.ASHLR_RUNS_DIR = dir;
    try {
      const items = await amplifyBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS), limit: 2 });
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.id)).toEqual(['amplify-expiring-capacity-pool-a', 'amplify-expiring-capacity-pool-b']);
    } finally {
      delete process.env.ASHLR_RUNS_DIR;
    }
  });

  it('states truncated tails as lower bounds in the emitted prompts', async () => {
    // >1 MiB of retained rows: the tail read drops the oldest bytes.
    const filler: string[] = [];
    for (let i = 0; i < 4000; i += 1) {
      filler.push(JSON.stringify(tick('2026-11-22T00:00:00.000Z', { actions: [capacity('pool-z')] })));
    }
    const dir = await runsDir('runs-big', [...filler, ...recurringTicks((at) => tick(at, { actions: [capacity('pool-a')] }))]);
    const items = await amplifyBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('appends amplify items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    try {
      const runs = join(home, '.ashlr-runs');
      await mkdir(join(runs, 'metrics'), { recursive: true });
      await writeFile(join(runs, JOURNAL), recurringTicks((at) => tick(at, { actions: [capacity('pool-a'), heartbeatAction] })).join('\n') + '\n');
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const amplifyItems = first.items.filter((i) => i.id.startsWith('amplify-'));
      expect(amplifyItems.map((i) => i.id)).toEqual(['amplify-expiring-capacity-pool-a', 'amplify-heartbeat-stale']);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(amplifyItems)).toBe(2);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('amplify-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('amplify-'))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
