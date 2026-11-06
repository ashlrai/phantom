/**
 * RQ-PHX-RESETTIMEPASSED04 — an autobackoff usage hold is releasable as soon
 * as the provider's own resetAt is behind us, even when the newest reading
 * predates the hold (the codex-cmp Nov 1 lesson: the lane waited about a day
 * on a guessed heldUntil while its window had already reset). Manual holds
 * and expired holds keep their states, and a resetAt that is future,
 * unparseable, at-or-before the hold start, or more than 8 days old is never
 * evidence.
 */
import { expect, it } from 'vitest';
import { detectUsageResets, RESET_TIME_PASSED_MAX_AGE_MS } from '../src/core/fleet/usage-reset-detect.js';
import { planResetReleases } from '../src/core/fleet/usage-reset-release.js';
import type { LaneTargetRow } from '../src/core/fleet/runs-lane-targets.js';
import type { ResourceLaneRow } from '../src/core/fleet/runs-resource-ledger.js';

const nowMs = Date.parse('2026-11-03T12:00:00Z');
const HOLD_SINCE = '2026-11-02T12:00:00Z'; // hold placed a day ago
const HELD_UNTIL = '2026-11-04T00:00:00Z'; // autobackoff's guess, still a day out
const RESET_PASSED = '2026-11-02T20:00:00Z'; // after the hold, already behind us
const FRESH_ASOF = '2026-11-03T11:00:00Z'; // newer than the hold
const STALE_ASOF = '2026-11-02T11:00:00Z'; // predates the hold

const lane = (over: Partial<LaneTargetRow> = {}): LaneTargetRow => ({
  lane: 'codex-cmp', target: 1, floor: 0, ceiling: 2, pausedFrom: null, held: true,
  heldReason: `autobackoff codex_usage_limit job=fake until=${HELD_UNTIL} src=outcome_unreadable`,
  heldUntil: HELD_UNTIL, lastChange: HOLD_SINCE, changedBy: 'autobackoff', ...over,
});
const reading = (over: Partial<ResourceLaneRow> = {}): ResourceLaneRow => ({
  lane: 'codex-cmp', running: 0, target: 1, held: true, window: 'weekly', usedPct: 97,
  creditsRemaining: null, resetAt: RESET_PASSED, burnPctPerHour: null, tokensPerHour6h: null,
  projectedExhaustion: null, source: 'codex-personal-sessions', deadSignal: null,
  observation: { source: 'codex-personal-sessions', asOf: FRESH_ASOF }, ...over,
});
const detect = (l: LaneTargetRow, r: ResourceLaneRow | null, ledgerAsOf: string | null = FRESH_ASOF) =>
  detectUsageResets({ lanes: [l], ledger: r ? [r] : [], ledgerAsOf, nowMs })[0]!;

it('releases when the provider resetAt passed after the hold started, even on a stale reading', () => {
  // The lesson: the newest reading predates the hold, yet the reset time it
  // advertised has already passed — that alone releases the lane. A stale
  // usedPct (here 97%) does not block it.
  for (const asOf of [FRESH_ASOF, STALE_ASOF]) {
    const row = detect(lane(), reading({ observation: { source: 'codex-personal-sessions', asOf } }), asOf);
    expect(row).toMatchObject({ state: 'reset-time-passed', releasable: true, heldBy: 'autobackoff', resetAt: RESET_PASSED });
    expect(row.tell).toBe(`codex-cmp passed its provider reset at ${new Date(Date.parse(RESET_PASSED)).toISOString()}: release the hold.`);
    expect(planResetReleases([row]).map(r => r.lane)).toEqual(['codex-cmp']);
  }
});

it('does not release on a resetAt still in the future', () => {
  const row = detect(lane(), reading({ resetAt: '2026-11-03T13:00:00Z' }));
  expect(row).toMatchObject({ state: 'consistent', releasable: false });
});

it('does not release on a resetAt at or before the hold start — it belongs to the old window', () => {
  for (const resetAt of [HOLD_SINCE, '2026-11-02T11:00:00Z']) {
    const row = detect(lane(), reading({ resetAt }));
    expect(row).toMatchObject({ state: 'consistent', releasable: false });
  }
});

it('never releases a manual hold, even with a passed resetAt', () => {
  const row = detect(lane({ heldReason: 'Mason t1221u usage hold', changedBy: 'Mason' }), reading());
  expect(row).toMatchObject({ state: 'manual-hold', releasable: false, heldBy: 'manual' });
  expect(planResetReleases([row])).toEqual([]);
});

it('does not release on an unparseable resetAt', () => {
  for (const resetAt of ['not-a-date', '']) {
    const row = detect(lane(), reading({ resetAt }));
    expect(row).toMatchObject({ state: 'consistent', releasable: false });
  }
});

it('treats a resetAt more than 8 days in the past as stale data', () => {
  const holdSince = new Date(nowMs - 10 * 86_400_000).toISOString();
  const resetAt = new Date(nowMs - RESET_TIME_PASSED_MAX_AGE_MS - 86_400_000).toISOString(); // 9 days ago
  const row = detect(lane({ lastChange: holdSince }), reading({ resetAt }));
  expect(row).toMatchObject({ state: 'consistent', releasable: false });
});

it('keeps hold-expired first when heldUntil has also passed', () => {
  const row = detect(lane({ heldUntil: STALE_ASOF }), reading());
  expect(row).toMatchObject({ state: 'hold-expired', releasable: true });
});

it('needs a valid reading: a future-dated observation stays no-reading', () => {
  const row = detect(lane(), reading({ observation: { source: 'codex-personal-sessions', asOf: '2026-11-04T00:00:00Z' } }));
  expect(row).toMatchObject({ state: 'no-reading', releasable: false });
});
