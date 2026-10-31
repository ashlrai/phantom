import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { formatMinutes, incidents } from './incidents-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const lane = (name: string): FleetRuns['lanes'][number] => ({ lane: name, running: 1, target: 1, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null });
const healthy = (): FleetRuns => ({
  v: 1, generatedAt: at(0), sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: at(1), paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: 'up', lanes: [], workers: [], leaders: [], orchestratorAgents: null,
  publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [{ at: at(1), kind: 'launch', text: '' }], codexPersonal: null, inbox: [], drop: null,
});

describe('incidents', () => {
  it('returns nothing for healthy or absent data', () => {
    expect(incidents(healthy(), now)).toEqual([]);
    expect(incidents(null, now)).toEqual([]);
  });
  it('reports a stall with its duration and suppresses it after a merge or publish', () => {
    const runs = { ...healthy(), events: [{ at: at(40), kind: 'START', text: '' }] };
    expect(incidents(runs, now)).toContainEqual(expect.objectContaining({ id: 'stall', severity: 'incident', detail: 'No launches, publishes or merges for 40 min.' }));
    expect(incidents({ ...runs, mergesLastHour: { count: 2, items: [] } }, now)).toEqual([]);
    expect(incidents({ ...runs, publishesLastHour: [{ job: 'fake', lane: null, url: null, at: at(1) }] }, now)).toEqual([]);
    expect(incidents({ ...runs, sources: { ...runs.sources, runsDir: 'missing' } }, now)).toEqual([]);
    expect(incidents({ ...runs, mergesLastHour: { count: null, items: [] } }, now)[0]?.id).toBe('stall');
  });
  it('does not invent an age for empty, malformed, or future activity', () => {
    for (const events of [[], [{ at: 'invalid', kind: 'LAUNCH', text: '' }], [{ at: at(-1), kind: 'LAUNCH', text: '' }]]) {
      expect(incidents({ ...healthy(), events }, now)).toEqual([]);
    }
    expect(incidents({ ...healthy(), events: [{ at: at(40), kind: 'tick', text: '' }] }, now)[0]?.id).toBe('stall');
  });
  it('uses thresholds and recognizes every activity kind', () => {
    for (const kind of ['launch', 'PUBLISH', 'Claimed', 'start']) {
      expect(incidents({ ...healthy(), events: [{ at: at(29), kind, text: '' }] }, now)).toEqual([]);
      expect(incidents({ ...healthy(), events: [{ at: at(30), kind, text: '' }] }, now)[0]?.id).toBe('stall');
    }
    expect(incidents({ ...healthy(), lastTick: at(20) }, now)).toEqual([]);
    expect(incidents({ ...healthy(), lastTick: at(21) }, now)[0]).toMatchObject({ id: 'tick-stale', detail: 'dispatchd last ticked 21 min ago' });
    expect(incidents({ ...healthy(), lastTick: 'invalid' }, now)).toEqual([]);
    expect(formatMinutes(40 * 60_000)).toBe('40 min');
  });
  it('ranks incidents before warnings and preserves the lane diagnostic', () => {
    const state = 'down: token rejected (run fix-claude-lane.sh)';
    const rows = incidents({ ...healthy(), lastTick: at(21), claudeLane: state, switches: ['queue/HOLD'], paused: true }, now);
    expect(rows.map(row => row.id)).toEqual(['tick-stale', 'claude-lane', 'hold', 'paused']);
    expect(rows[1]).toMatchObject({ severity: 'incident', title: 'Claude lane is down', detail: state, fix: null });
    expect(rows[2]).toMatchObject({ severity: 'warn', detail: 'HOLD is on: nothing launches until it is removed.' });
    expect(incidents({ ...healthy(), switches: ['HOLD'] }, now)[0]?.id).toBe('hold');
  });
  it('collapses held and starved lanes separately and bounds reasons', () => {
    const runs = { ...healthy(), lanes: [
      { ...lane('codex-cmp'), held: true, heldReason: `  ${'x'.repeat(90)}  ` },
      { ...lane('devin'), held: true, heldReason: 'reason' },
      { ...lane('ignored'), held: true, target: 0 },
      { ...lane('codex-local'), running: 0, queued: 15 },
    ] };
    const rows = incidents(runs, now);
    expect(rows.map(row => row.id)).toEqual(['held-lanes', 'starved']);
    expect(rows[0]?.detail).toBe(`2 lanes held: codex-cmp (${'x'.repeat(80)}) · devin (reason)`);
    expect(rows[1]?.detail).toBe('idle with work queued: codex-local (15 queued)');
  });
});
