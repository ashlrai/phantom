/**
 * ops-lane-model.slot-target.test.ts : the queued chip reads against the
 * lane's slot target and warns when the ready queue is over-deep.
 */
import { describe, expect, it } from 'vitest';
import type { FleetLaneView } from '../../../data/api-types.js';
import { QUEUE_OVERDEEP_FACTOR, laneChipText, queueDepthTone } from './ops-lane-model.js';

const lane = (over: Partial<FleetLaneView> = {}): FleetLaneView => ({
  hold: null, lane: 'codex-personal', queueDepth: 3, liveJobs: 2, mergesPerHour: 1.25, slotTarget: 10,
  credit: {
    state: 'observed', label: '64% weekly', remainingPct: 64, remainingCredits: null, creditsUnit: null,
    resetAt: null, burnPerHour: null, projectedExhaustionAt: null, observedAt: null, source: 'budget-ledger',
  },
  ...over,
});
const queued = (l: FleetLaneView) => laneChipText(l)[1]!;

describe('queued chip vs slot target', () => {
  it('warns on an over-deep queue', () => {
    expect(queued(lane({ queueDepth: 653 }))).toEqual({ text: 'queued 653 / 10 slots', tone: 'warn' });
  });
  it('shows the target without a tone at 2x', () => {
    expect(queued(lane({ queueDepth: 20 })).text).toBe('queued 20 / 10 slots');
    expect(queued(lane({ queueDepth: 20 })).tone).toBeUndefined();
  });
  it('does not warn exactly at the factor, warns one past it', () => {
    expect(QUEUE_OVERDEEP_FACTOR).toBe(3);
    expect(queueDepthTone(lane({ queueDepth: 30 }))).toBeNull();
    expect(queueDepthTone(lane({ queueDepth: 31 }))).toBe('warn');
  });
  it('warns when a 0-slot lane has ready work, not when it is empty', () => {
    expect(queued(lane({ slotTarget: 0, queueDepth: 2 }))).toEqual({ text: 'queued 2 / 0 slots', tone: 'warn' });
    expect(queueDepthTone(lane({ slotTarget: 0, queueDepth: 0 }))).toBeNull();
  });
  it('keeps plain `queued N` when slotTarget is missing or null', () => {
    expect(queued(lane({ slotTarget: undefined, queueDepth: 653 }))).toEqual({ text: 'queued 653', tone: undefined });
    expect(queued(lane({ slotTarget: null, queueDepth: 5 })).text).toBe('queued 5');
    expect(queueDepthTone(lane({ slotTarget: null, queueDepth: 653 }))).toBeNull();
  });
  it('stays quiet when the queue depth is unknown', () => {
    expect(queued(lane({ queueDepth: null }))).toMatchObject({ text: 'queued — / 10 slots' });
    expect(queueDepthTone(lane({ queueDepth: null }))).toBeNull();
  });
});
