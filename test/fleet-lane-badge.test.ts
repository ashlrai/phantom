/**
 * fleet-lane-badge.test.ts : RQ-LANEBADGEN20OQ8. Each lane in the lanes read
 * carries one `health` verdict (ok, held, starved, wasteful, drained) with a
 * plain reason and the number behind it. Pure fixtures plus the real read over
 * a temp queue dir; precedence is drained > held > starved > wasteful.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFleetLaneSnapshot } from '../src/core/fleet/lane-console.js';
import { laneHealthFor, narrowLaneHealth, type LaneHealthInput } from '../src/core/fleet/lane-badge.js';

const NOW = Date.parse('2026-11-19T10:00:00Z');
const minutesAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString();
const input = (over: Partial<LaneHealthInput> = {}): LaneHealthInput => ({
  lane: 'claude', remainingPct: 60, held: false, heldReason: null, slotTarget: 8, starved: false, freeSlots: 0,
  readyRows: 2, starvedSince: null, starts: 2, merged: 2, windowMinutes: 60, liveJobs: 3, ...over,
});

describe('laneHealthFor', () => {
  it('ok: a plain line with the running and ready counts', () => {
    expect(laneHealthFor(input(), NOW)).toEqual({ state: 'ok', reason: 'ok: 3 running, 2 ready', number: 3 });
  });

  it('held: names the slots it keeps and the recorded reason', () => {
    expect(laneHealthFor(input({ held: true, heldReason: 'rate limit' }), NOW))
      .toEqual({ state: 'held', reason: 'held: keeps 8 launch slots and refuses to run (rate limit)', number: 8 });
  });

  it('starved: free slots, ready rows and how long', () => {
    expect(laneHealthFor(input({ starved: true, freeSlots: 5, readyRows: 0, starvedSince: minutesAgo(40) }), NOW))
      .toEqual({ state: 'starved', reason: 'starved: 5 free slots, 0 ready rows for 40 min', number: 5 });
  });

  it('wasteful: many starts and few merged PRs in the window', () => {
    expect(laneHealthFor(input({ starts: 8, merged: 1 }), NOW))
      .toEqual({ state: 'wasteful', reason: 'wasteful: 8 starts, 1 merged PR in 60 min', number: 8 });
  });

  it('does not call a lane wasteful below the start floor or at a healthy ratio', () => {
    expect(laneHealthFor(input({ starts: 4, merged: 0 }), NOW).state).toBe('ok');
    expect(laneHealthFor(input({ starts: 10, merged: 2 }), NOW).state).toBe('ok');
    expect(laneHealthFor(input({ starts: 9, merged: null }), NOW).state).toBe('ok');
  });

  it('drained: credit is spent', () => {
    expect(laneHealthFor(input({ remainingPct: 0 }), NOW))
      .toEqual({ state: 'drained', reason: 'drained: credit is spent, nothing launched here would run', number: 0 });
  });

  it('precedence: drained > held > starved > wasteful', () => {
    const all = input({ remainingPct: 0, held: true, starved: true, freeSlots: 3, starts: 9, merged: 0 });
    expect(laneHealthFor(all, NOW).state).toBe('drained');
    expect(laneHealthFor({ ...all, remainingPct: 40 }, NOW).state).toBe('held');
    expect(laneHealthFor({ ...all, remainingPct: 40, held: false }, NOW).state).toBe('starved');
    expect(laneHealthFor({ ...all, remainingPct: 40, held: false, starved: false }, NOW).state).toBe('wasteful');
  });
});

describe('narrowLaneHealth', () => {
  it('keeps a well-formed verdict and drops anything else', () => {
    expect(narrowLaneHealth({ state: 'held', reason: 'held: x', number: 2 })).toEqual({ state: 'held', reason: 'held: x', number: 2 });
    expect(narrowLaneHealth({ state: 'fine', reason: 'x', number: 1 })).toBeUndefined();
    expect(narrowLaneHealth({ state: 'ok', reason: '' })).toBeUndefined();
    expect(narrowLaneHealth(null)).toBeUndefined();
  });
});

describe('lanes read: health per lane', () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

  it('gives every lane one verdict from the queue files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-lane-badge-'));
    dirs.push(root);
    const queueDir = join(root, 'queue');
    await mkdir(queueDir, { recursive: true });
    await writeFile(join(queueDir, 'ready.tsv'), ['id\tstatus\tpool', 'j1\tREADY\tdevin', 'j2\tREADY\tzai', 'j3\tRUNNING\tcodex', 'j4\tREADY\tgrok'].join('\n'));
    await writeFile(join(queueDir, 'slots.json'), JSON.stringify({
      claude: { target: 8, floor: 8, ceiling: 12 },
      devin: { target: 4, floor: 4, ceiling: 4, held: true, held_reason: 'rate limit' },
      codex: { target: 1, floor: 1, ceiling: 4 },
      zai: { target: 3, floor: 3, ceiling: 4 },
      grok: { target: 1, floor: 1, ceiling: 1 },
    }), { mode: 0o600 });
    // zai started 6 jobs and merged none inside the window.
    await writeFile(join(queueDir, 'jobs.jsonl'), Array.from({ length: 6 }, (_, i) =>
      JSON.stringify({ event: 'launch', job: `w${i}`, pool: 'zai', ts: minutesAgo(10 + i) })).join('\n') + '\n');
    // grok has spent its credit.
    const usage = join(root, 'usage-readings.log');
    await writeFile(usage, JSON.stringify({ pool: 'grok', pctUsed: 100, observedAt: minutesAgo(1) }) + '\n');
    const snap = await getFleetLaneSnapshot({
      queueDir, budgetsDir: join(root, 'budgets'), usageLogPaths: [usage], now: () => new Date(NOW), starvedStateDir: root,
    });
    const health = (lane: string) => snap.lanes.find(row => row.lane === lane)!.health;
    expect(health('claude')).toMatchObject({ state: 'starved', number: 8 });
    expect(health('claude').reason).toMatch(/^starved: 8 free slots, 0 ready rows/);
    expect(health('devin')).toMatchObject({ state: 'held', number: 4 });
    expect(health('devin').reason).toContain('rate limit');
    expect(health('codex').state).toBe('ok');
    expect(health('zai')).toMatchObject({ state: 'wasteful', number: 6, reason: 'wasteful: 6 starts, 0 merged PRs in 60 min' });
    expect(health('grok').state).toBe('drained');
    expect(snap.schema).toBe('fleet.lanes.v1');
  });
});
