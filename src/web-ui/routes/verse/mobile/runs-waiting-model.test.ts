import { describe, expect, it } from 'vitest';
import { waitingView, type WaitingRuns } from './runs-waiting-model.js';

const lane = { lane: 'codex-personal', queued: 8, running: 20, target: 20, held: false, heldReason: null };
const view = (lanes: WaitingRuns['lanes'], drop: WaitingRuns['drop'] = null) => waitingView({ lanes, drop }, 0);

describe('waitingView', () => {
  it('shows full queued lanes', () => {
    expect(view([lane])).toMatchObject({ verdict: 'Queued behind full lanes', rows: [
      { title: 'codex-personal · 8 queued · running 20 of 20', badge: 'Full', tone: 'neutral' },
    ] });
  });
  it('shows held reasons and a held verdict', () => {
    expect(view([{ ...lane, held: true, heldReason: 'usage limit' }])).toMatchObject({ verdict: 'Waiting on held lanes', rows: [
      { badge: 'Held: usage limit', tone: 'warning' },
    ] });
    expect(view([{ ...lane, queued: 0, held: true }]).rows[0]?.badge).toBe('Held: reason unavailable');
  });
  it('flags queued work with open slots, including held lanes', () => {
    const result = view([{ ...lane, running: 18 }, { ...lane, lane: 'devin', queued: 24, running: 1, target: 3, held: true }]);
    expect(result.verdict).toBe('Launch stall: codex-personal, devin have open slots and queued work');
    expect(result.rows[0]).toMatchObject({ badge: 'Open slots: 2', tone: 'success' });
    expect(result.rows[1]?.badge).toBe('Held: reason unavailable');
  });
  it('reports unknown capacity without inventing slots', () => {
    expect(view([{ ...lane, running: null }])).toMatchObject({ verdict: 'Waiting for lane status', rows: [
      { title: 'codex-personal · 8 queued · running — of 20', badge: 'Capacity unknown', tone: 'neutral' },
    ] });
  });
  it('counts drop files and lists each lane once', () => {
    const drop = { pending: [{ lane: 'devin', file: 'one' }, { lane: 'devin', file: 'two' }, { lane: 'codex', file: 'three' }] };
    expect(view([], drop)).toMatchObject({ verdict: 'Waiting in the drop folder', rows: [
      { title: '3 jobs in the drop folder', subtitle: 'devin, codex' },
    ] });
  });
  it('returns an empty view', () => {
    expect(view([{ ...lane, queued: 0 }], { pending: [] })).toEqual({ rows: [], verdict: 'Nothing waiting' });
  });
});
