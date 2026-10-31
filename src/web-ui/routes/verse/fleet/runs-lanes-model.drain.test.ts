import { describe, expect, it } from 'vitest';
import { drainText, laneDrain, laneNote, type RunsLane } from './runs-lanes-model.js';

const lane: RunsLane = { lane: 'codex-personal', running: 2, target: 2, queued: 2, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null };

describe('lane queue drain', () => {
  it('preserves held reasons and formats a held result', () => {
    const held = { ...lane, held: true, heldReason: 'quota' };
    expect(laneDrain(held).state).toBe('held');
    expect(laneNote(held)).toBe('held: quota');
    expect(drainText({ ...laneDrain(held), queued: held.queued })).toBe('held');
  });

  it('shows available slots when idle', () => {
    const idle = { ...lane, running: 1, queued: 0 };
    expect(laneDrain(idle).state).toBe('idle');
    expect(laneNote(idle)).toBe('1 free · waiting for jobs');
  });

  it('shows the estimated drain for a draining queue', () => {
    expect(laneDrain(lane).state).toBe('draining');
    expect(laneNote(lane)).toBe('queued 2 · drains in ~13 min');
  });

  it('shows queued jobs and no free slots when saturated', () => {
    const saturated = { ...lane, queued: 5 };
    expect(laneDrain(saturated).state).toBe('saturated');
    expect(laneNote(saturated)).toBe('saturated · 5 queued, 0 free');
  });

  it.each([['codex-personal', 13], ['devin', 70], ['other', 15]])('uses the Oct 31 median for %s', (name, minutes) => {
    expect(laneDrain({ ...lane, lane: name }).drainMinutes).toBe(minutes);
  });

  it('does not predict a drain when the target is zero', () => {
    const disabled = { ...lane, running: 0, target: 0, queued: 1 };
    expect(laneDrain(disabled)).toMatchObject({ state: 'saturated', drainMinutes: null, freeSlots: 0 });
    expect(laneNote(disabled)).toBe('saturated · 1 queued, 0 free');
    expect(laneNote({ ...disabled, held: true })).toBe('held: reason unknown');
  });
});
