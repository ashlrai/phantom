/**
 * PHX-RESETAUTORELEASE31 — Phantom releases its own autobackoff usage holds
 * when the resource ledger proves the window reset, without Mason. Core
 * tests against real files in a temp runs dir: lane-a resets mid-hold and is
 * released; a manual hold, a stale reading and a degraded ledger never are.
 */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  getResetReleaseState, planResetReleases, readResetReleases,
  runResetReleaseOnce, startResetReleaseLoop, stopResetReleaseLoopForTest,
  type ResetReleaseRecord,
} from '../src/core/fleet/usage-reset-release.js';
import type { UsageResetRow, UsageResetsV1 } from '../src/core/fleet/usage-reset-detect.js';
import { readLaneTargets, type LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';
import type { LaneHoldOptions } from '../src/core/fleet/runs-lane-hold.js';
import { parseDispatchEvents } from '../src/core/fleet/runs-dir-state.js';

const T0 = Date.parse('2026-10-31T19:00:00Z');
const READING = '2026-10-31T19:10:00Z'; // ledger as-of, T0 + 10 min
const HELD_UNTIL = '2026-11-04T00:00:00Z'; // autobackoff's guess, far in the future
const EXPIRED_UNTIL = '2026-10-31T19:05:00Z'; // already past at NOW
const NOW_MS = Date.parse('2026-10-31T19:28:00Z');
const NOW_ISO = new Date(NOW_MS).toISOString();

let runsDir: string;
let slotsPath: string;
const slots = () => ({
  'lane-a': { target: 2, floor: 0, ceiling: 4, held: true,
    held_reason: `autobackoff fake job=j-1 until=${HELD_UNTIL} src=fake`,
    held_until: HELD_UNTIL, held_by: 'autobackoff', last_change: T0 / 1000 },
  'lane-b': { target: 1, floor: 0, ceiling: 2, held: true,
    held_reason: 'manual: operator', held_by: 'Mason t1221u', last_change: T0 / 1000 },
  'lane-c': { target: 1, floor: 0, ceiling: 2, held: true,
    held_reason: `autobackoff fake job=j-2 until=${EXPIRED_UNTIL} src=fake`,
    held_until: EXPIRED_UNTIL, held_by: 'autobackoff', last_change: T0 / 1000 },
  'lane-d': { target: 1, floor: 0, ceiling: 2, held: true,
    held_reason: `autobackoff fake job=j-3 until=${HELD_UNTIL} src=fake`,
    held_until: HELD_UNTIL, held_by: 'autobackoff', last_change: Date.parse('2026-10-31T19:20:00Z') / 1000 },
});
const status = () => ({
  last_tick: READING,
  lanes: { 'lane-a': { held: true }, 'lane-b': { held: true }, 'lane-c': { held: true }, 'lane-d': { held: true } },
  budget: { 'lane-a': { weekly_used_pct: 3 }, 'lane-b': { weekly_used_pct: 0 }, 'lane-c': { weekly_used_pct: 0 }, 'lane-d': { weekly_used_pct: 3 } },
});
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'reset-release-'));
  await mkdir(join(runsDir, 'queue'));
  slotsPath = join(runsDir, 'queue/slots.json');
  await writeFile(slotsPath, JSON.stringify(slots(), null, 1));
  await writeFile(join(runsDir, 'queue/status.json'), JSON.stringify(status()));
});
afterEach(async () => {
  stopResetReleaseLoopForTest();
  vi.unstubAllEnvs();
  await rm(runsDir, { recursive: true, force: true });
});
const row = (lane: string, over: Partial<UsageResetRow> = {}): UsageResetRow => ({
  lane, held: true, heldReason: 'autobackoff fake', heldUntil: HELD_UNTIL, holdSince: '2026-10-31T19:00:00Z',
  heldBy: 'autobackoff', usedPct: 3, readingAsOf: READING, resetAt: null,
  state: 'reset-detected', releasable: true, tell: '', ...over,
});

it('plans only autobackoff rows proven reset or expired — a manual hold is never a candidate', () => {
  const plan = planResetReleases([
    row('reset-lane'), row('expired-lane', { state: 'hold-expired' }),
    row('manual-lane', { heldBy: 'manual', heldReason: 'manual: operator', state: 'manual-hold', releasable: false }),
    row('manual-releasable', { heldBy: 'manual', state: 'reset-detected', releasable: true }),
    row('still-used', { state: 'consistent', releasable: false }),
    row('auto-unflagged', { state: 'reset-detected', releasable: false }),
  ]);
  expect(plan.map((r) => r.lane)).toEqual(['reset-lane', 'expired-lane']);
});

it('releases reset and expired autobackoff holds, writes the audit line and the dispatch event, then idles', async () => {
  const first = await runResetReleaseOnce({ runsDir, now: () => NOW_MS });
  expect(first).toMatchObject({ at: NOW_ISO, checked: 4, errors: [] });
  expect(first.released).toEqual([
    { lane: 'lane-a', state: 'reset-detected', usedPct: 3, readingAsOf: READING, heldUntil: HELD_UNTIL },
    { lane: 'lane-c', state: 'hold-expired', usedPct: 0, readingAsOf: READING, heldUntil: EXPIRED_UNTIL },
  ]);
  const lanes = await readLaneTargets({ runsDir });
  expect(lanes.lanes.find((l) => l.lane === 'lane-a')).toMatchObject({ held: false, changedBy: expect.stringContaining('reset-detect') });
  expect(lanes.lanes.find((l) => l.lane === 'lane-c')).toMatchObject({ held: false });
  // The manual hold and the stale reading are untouched.
  expect(lanes.lanes.find((l) => l.lane === 'lane-b')).toMatchObject({ held: true, heldReason: 'manual: operator' });
  expect(lanes.lanes.find((l) => l.lane === 'lane-d')).toMatchObject({ held: true });

  const records = (await readFile(join(runsDir, 'queue/reset-releases.jsonl'), 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as ResetReleaseRecord);
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({ v: 1, at: NOW_ISO, lane: 'lane-a', state: 'reset-detected', usedPct: 3, by: 'reset-detect' });
  expect(records[0]!.reason).toBe(`window reset: reads 3% at ${READING}`);
  expect(records[1]!.reason).toBe(`hold expired at ${EXPIRED_UNTIL}`);

  // The Events pane reads dispatch-events.log via parseDispatchEvents.
  const events = parseDispatchEvents(await readFile(join(runsDir, 'dispatch-events.log'), 'utf8'));
  expect(events.map((e) => e.kind)).toEqual(['LANE_HOLD', 'LANE_HOLD']);
  expect(events[0]!.at).toBe(NOW_ISO.replace('.000', ''));
  expect(events[0]!.text).toBe(`released lane-a by reset-detect: window reset: reads 3% at ${READING}`);

  const second = await runResetReleaseOnce({ runsDir, now: () => NOW_MS });
  expect(second).toMatchObject({ checked: 4, released: [], errors: [] });
  expect((await readFile(join(runsDir, 'queue/reset-releases.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);
});

it('releases nothing when the ledger is degraded, and never throws', async () => {
  await writeFile(join(runsDir, 'queue/status.json'), '{');
  const result = await runResetReleaseOnce({ runsDir, now: () => NOW_MS });
  expect(result.released).toEqual([]);
  const lanes = await readLaneTargets({ runsDir });
  expect(lanes.lanes.find((l) => l.lane === 'lane-a')).toMatchObject({ held: true });
});

it('honours the read/release seams', async () => {
  const releases: { lane: string; by?: string; reason?: string }[] = [];
  const resets = (sourceState: UsageResetsV1['sourceState']): UsageResetsV1 => ({
    v: 1, generatedAt: NOW_ISO, sourceState, rows: [row('lane-a')],
  });
  const fake = {
    release: async (lane: string, opts: LaneHoldOptions): Promise<LaneTargetsV1> => {
      releases.push({ lane, by: opts.changedBy, reason: opts.reason });
      return { v: 1, generatedAt: NOW_ISO, sourceState: 'healthy', lanes: [] };
    },
  };
  const done = await runResetReleaseOnce({ runsDir, now: () => NOW_MS, read: async () => resets('healthy'), ...fake });
  expect(done.released.map((r) => r.lane)).toEqual(['lane-a']);
  expect(releases).toEqual([{ lane: 'lane-a', by: 'reset-detect', reason: `window reset: reads 3% at ${READING}` }]);
  releases.length = 0;
  const degraded = await runResetReleaseOnce({ runsDir, now: () => NOW_MS, read: async () => resets('degraded'), ...fake });
  expect(degraded.released).toEqual([]);
  expect(releases).toEqual([]);
});

it('keeps loop errors in state and never throws — an audit failure is reported, not fatal', async () => {
  // Force the audit append to fail while the release itself succeeds.
  await mkdir(join(runsDir, 'queue/reset-releases.jsonl'));
  let fire: (() => void) | null = null;
  let sets = 0;
  const schedule = {
    set: (fn: () => void) => { sets++; fire = fn; return { unref() {} }; },
    clear: () => { fire = null; },
  };
  startResetReleaseLoop({ runsDir, now: () => NOW_MS, intervalMs: 1000, schedule });
  startResetReleaseLoop({ runsDir, now: () => NOW_MS, intervalMs: 1000, schedule });
  expect(sets).toBe(1); // idempotent: one timer per process
  await vi.waitFor(() => expect(getResetReleaseState().lastRunAt).toBe(NOW_ISO));
  const state = getResetReleaseState();
  expect(state.started).toBe(true);
  expect(state.lastError).toContain('lane-a');
  expect(state.lastResult!.released.map((r) => r.lane)).toEqual(['lane-a', 'lane-c']);
  // A cleared sink lets the next tick finish clean; firing inside waitFor
  // tolerates a tick still in flight (the loop drops overlapping fires).
  await rm(join(runsDir, 'queue/reset-releases.jsonl'), { recursive: true });
  await vi.waitFor(() => {
    fire!();
    expect(getResetReleaseState().lastError).toBeNull();
    expect(getResetReleaseState().lastResult!.released).toEqual([]);
  });
  stopResetReleaseLoopForTest();
  expect(getResetReleaseState()).toMatchObject({ started: false, lastRunAt: null, lastResult: null, lastError: null });
});

it('reads the release audit newest-first, bounded, skipping malformed lines', async () => {
  const path = join(runsDir, 'queue/reset-releases.jsonl');
  const record = (lane: string, at: string) => ({ v: 1, at, lane, state: 'reset-detected', usedPct: 3, readingAsOf: READING, heldUntil: HELD_UNTIL, by: 'reset-detect', reason: 'fake' });
  await writeFile(path, [
    JSON.stringify(record('lane-aa', '2026-10-31T19:00:00Z')),
    'not json', '{"x":1}', '',
    JSON.stringify(record('lane-bb', '2026-10-31T19:01:00Z')),
    JSON.stringify(record('lane-cc', '2026-10-31T19:02:00Z')),
  ].join('\n') + '\n');
  expect(await readResetReleases(runsDir)).toMatchObject([{ lane: 'lane-cc' }, { lane: 'lane-bb' }, { lane: 'lane-aa' }]);
  expect(await readResetReleases(runsDir, 2)).toHaveLength(2);
  // A file bigger than the 64 KiB tail still yields its newest lines.
  await writeFile(path, `${JSON.stringify({ ...record('lane-old', '2026-10-31T18:00:00Z'), pad: 'x'.repeat(70 * 1024) })}\n${JSON.stringify(record('lane-new', '2026-10-31T19:30:00Z'))}\n`);
  expect(await readResetReleases(runsDir)).toEqual([expect.objectContaining({ lane: 'lane-new' })]);
  expect(await readResetReleases(join(runsDir, 'missing'))).toEqual([]);
});
