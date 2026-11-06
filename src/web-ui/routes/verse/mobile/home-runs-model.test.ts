import { describe, expect, it } from 'vitest';
import { homeRunsView, isHomeFleetRuns, type FleetRuns } from './home-runs-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const lane = (name: string, running: number | null, target: number | null, queued: number | null, held = false) =>
  ({ lane: name, running, target, queued, held });
const fixture: FleetRuns = {
  lastTick: '2026-10-31T11:59:20Z', claudeLane: 'up', switches: [],
  lanes: [lane('codex', 8, 24, 4)], mergesLastHour: { count: 2 },
  codexPersonal: { usedPct: 46, resetsAt: '2026-10-31T15:00:00Z' },
};

describe('homeRunsView', () => {
  it('summarizes the fleet and times', () => {
    expect(homeRunsView(fixture, now)).toEqual({
      headline: '8 running · 24 target', lanes: [{ lane: 'codex', text: '8/24 · 4 queued', tone: 'success' }],
      merges: '2 merged last hour', codex: 'Personal Codex 46 % used · resets in 3 h', tick: 'tick 40 s ago', incident: null,
    });
  });
  it('sums lanes without treating unknown counts as zero', () => {
    const view = homeRunsView({ ...fixture, lanes: [lane('a', 3, 5, 1), lane('b', null, 7, null)], mergesLastHour: { count: null }, lastTick: null, codexPersonal: null }, now);
    expect(view.headline).toBe('— running · 12 target');
    expect(view.lanes[1].text).toBe('—/7 · — queued');
    expect(view.merges).toBe('merges unknown');
    expect(view.tick).toBe('tick —');
    expect(view.codex).toBeNull();
    expect(homeRunsView(null, now).headline).toBe('— running · — target');
  });
  it('shows held and stalled lanes and omits only lanes with no target or queue', () => {
    const view = homeRunsView({ ...fixture, lanes: [lane('held', 1, 2, 1, true), lane('stalled', 0, 2, 1), lane('working', 1, 3, 1), lane('empty', 0, 0, 0), lane('unknown', 0, null, 0)] }, now);
    expect(view.lanes.map(({ lane: name, tone }) => [name, tone])).toEqual([['held', 'danger'], ['stalled', 'warning'], ['working', 'success'], ['unknown', 'success']]);
  });
  it('gives Claude down precedence over HOLD', () => {
    expect(homeRunsView({ ...fixture, claudeLane: 'DOWN: quota', switches: ['HOLD'] }, now).incident).toBe('Claude lane down');
    expect(homeRunsView({ ...fixture, switches: ['HOLD'] }, now).incident).toBe('HOLD is on');
  });
  it('validates the fields displayed, including nullable counts', () => {
    expect(isHomeFleetRuns({ v: 1, ...fixture, lanes: [lane('a', null, 1, 0)] })).toBe(true);
    expect(isHomeFleetRuns({ v: 1, ...fixture, lanes: [lane('a', NaN, 1, 0)] })).toBe(false);
    expect(isHomeFleetRuns({ v: 1, ...fixture, switches: [null] })).toBe(false);
    expect(isHomeFleetRuns({ v: 2, ...fixture })).toBe(false);
  });
});
