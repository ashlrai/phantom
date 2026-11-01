import { describe, expect, it } from 'vitest';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { dispatchTellKinds, dispatchTellPrefill } from './dispatch-tell.js';
import { laneVerdict, readDispatch, youngestWorkerAges } from './fleet-dispatch-model.js';

const nowMs = Date.parse('2026-10-31T05:09:00Z');
const lane = { ...fleetRunsFixture().lanes[0]!, running: 0, target: 4, queued: 14 };
const context = (ageMs?: number) => ({ nowMs, lastTickAgeMs: 0, paused: false, claudeLane: null, youngestWorkerAgeMs: new Map(ageMs === undefined ? [] : [[lane.lane, ageMs]]) });

describe('launch evidence', () => {
  it('finds the youngest known worker age per lane in milliseconds', () => {
    expect(youngestWorkerAges([
      { lane: 'a', ageSeconds: 1200 }, { lane: 'b', ageSeconds: null },
      { lane: 'a', ageSeconds: null }, { lane: 'a', ageSeconds: 180 },
      { lane: 'b', ageSeconds: 90 }, { lane: 'a', ageSeconds: 300 },
      { lane: 'c', ageSeconds: null },
    ])).toEqual(new Map([['a', 180_000], ['b', 90_000]]));
    expect(youngestWorkerAges([])).toEqual(new Map());
  });

  it('shows the recent launch when filling', () => {
    expect(laneVerdict(lane, context(180_000))).toMatchObject({ kind: 'filling', tone: 'warn', headline: '4 free, 14 queued — last launch 3 min ago' });
  });

  it('reports a stale launch as stalled and prepares the interjection', () => {
    const verdict = laneVerdict(lane, context(20 * 60_000));
    expect(verdict).toMatchObject({ kind: 'stalled', tone: 'danger', headline: '4 free, 14 queued — nothing launched for 20 min', action: 'Queued lines are not launching on this lane: check holds, drip limits and dependencies in the dispatcher state' });
    expect(dispatchTellKinds().has('stalled')).toBe(true);
    expect(dispatchTellPrefill(verdict)).toBe('Lane codex-personal has 14 queued and 4 free slots but nothing launched for 20 min. Find out why and launch them.');
  });

  it('reports no worker with a fresh tick as stalled for this session', () => {
    const verdict = laneVerdict(lane, context());
    expect(verdict).toMatchObject({ kind: 'stalled', tone: 'danger', headline: '4 free, 14 queued — nothing launched for this session' });
    expect(dispatchTellPrefill(verdict)).toBe('Lane codex-personal has 14 queued and 4 free slots but nothing launched for this session. Find out why and launch them.');
  });

  it('honors threshold boundaries and gives starvation precedence', () => {
    expect(laneVerdict(lane, context(15 * 60_000 - 1)).kind).toBe('filling');
    expect(laneVerdict(lane, context(15 * 60_000)).kind).toBe('stalled');
    expect(laneVerdict(lane, { ...context(20 * 60_000), lastTickAgeMs: 300_001 }).kind).toBe('starved');
    for (const lastTickAgeMs of [null, 300_000]) {
      expect(laneVerdict(lane, { ...context(), lastTickAgeMs })).toMatchObject({ kind: 'filling', headline: '4 free, 14 queued — last launch unknown' });
    }
  });

  it('preserves held and at-target verdicts even with old workers', () => {
    expect(laneVerdict({ ...lane, held: true, heldReason: 'usage limit' }, context(20 * 60_000))).toMatchObject({ kind: 'held', headline: 'held — Usage limit', tone: 'warn' });
    expect(laneVerdict({ ...lane, running: 4 }, context(20 * 60_000))).toMatchObject({ kind: 'at-target', headline: 'at target', tone: 'ok' });
  });

  it('does not confuse a worker with an unknown age with an absent worker', () => {
    const runs = fleetRunsFixture({ claudeLane: null, lastTick: new Date(nowMs).toISOString(), lanes: [lane], workers: [{ job: 'job', repo: 'repo', lane: lane.lane, tier: 'mid', ageSeconds: null }] });
    expect(readDispatch(runs, nowMs)?.verdicts[0]).toMatchObject({ kind: 'filling', headline: '4 free, 14 queued — last launch unknown' });
    expect(readDispatch({ ...runs, workers: [] }, nowMs)?.verdicts[0]).toMatchObject({ kind: 'stalled', headline: '4 free, 14 queued — nothing launched for this session' });
  });
});
