import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { incidents } from './incidents-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
// Row shapes as they appear in dispatch-events.log: a healthy pass reports
// counters; a failed pass reports `<executor> rc=N` — the rc value is
// unreliable, so the shape itself is what marks failure.
const pass = (minutes: number) => ({ at: at(minutes), kind: 'LEADER', text: 'fixups=0 bets=3 reaps=1 ignored=0 free_gb=137' });
const fail = (minutes: number, executor = 'codex') => ({ at: at(minutes), kind: 'LEADER', text: `${executor} rc=0` });
const healthy = (): FleetRuns => ({
  v: 1, generatedAt: at(0), sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: at(1), paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: 'up', lanes: [], workers: [], leaders: [], orchestratorAgents: null,
  publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [{ at: at(1), kind: 'launch', text: '' }], claimed: [], codexPersonal: null, inbox: [], drop: null,
});
const executorDown = (runs: FleetRuns) => incidents(runs, now).filter(row => row.id === 'executor-down');

describe('executor-down incident', () => {
  it('fires once when failed rows have followed a healthy pass for over 30 minutes', () => {
    const rows = executorDown({ ...healthy(), events: [fail(1), fail(16), fail(31), pass(46)] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'incident', title: 'Leader executor is failing', fix: null });
    expect(rows[0]!.detail).toContain('3 failed rows in a row');
    expect(rows[0]!.detail).toContain(at(46));
  });
  it('counts only LEADER failures, ignoring interleaved activity rows', () => {
    const runs = { ...healthy(), events: [fail(1), { at: at(3), kind: 'LAUNCH', text: 'RQ-EXAMPLE-1' }, fail(16), fail(31), pass(46)] };
    expect(executorDown(runs)[0]?.detail).toContain('3 failed rows in a row');
  });
  it('clears when a healthy pass is the newest LEADER row', () => {
    expect(executorDown({ ...healthy(), events: [pass(1), fail(16), fail(31)] })).toEqual([]);
    expect(executorDown({ ...healthy(), events: [fail(1), pass(2), fail(31)] })).toEqual([]);
  });
  it('stays quiet while the evidence is under 30 minutes old', () => {
    // The newest healthy pass is still inside the threshold.
    expect(executorDown({ ...healthy(), events: [fail(1), fail(10), pass(29)] })).toEqual([]);
    // No healthy row retained: the oldest failed row in the tail sets the clock.
    expect(executorDown({ ...healthy(), events: [fail(1), fail(10), fail(20)] })).toEqual([]);
  });
  it('fires at the 30 minute boundary in both anchor modes', () => {
    expect(executorDown({ ...healthy(), events: [fail(1), pass(30)] })).toHaveLength(1);
    const rows = executorDown({ ...healthy(), events: [fail(1), fail(15), fail(30)] });
    expect(rows[0]?.detail).toContain('3 failed rows in a row');
    expect(rows[0]?.detail).toContain('no healthy pass in the retained tail');
  });
  it('fires for a failed row naming an executor other than codex', () => {
    expect(executorDown({ ...healthy(), events: [fail(1, 'claude'), fail(31, 'claude'), pass(46)] })).toHaveLength(1);
    const other = { ...healthy(), events: [{ at: at(1), kind: 'LEADER', text: 'gemini rc=17' }, pass(46)] };
    expect(executorDown(other)).toHaveLength(1);
  });
  it('does not fire when the tail holds no LEADER rows', () => {
    expect(executorDown(healthy())).toEqual([]);
    expect(executorDown({ ...healthy(), events: [] })).toEqual([]);
    expect(executorDown({ ...healthy(), events: [{ at: at(40), kind: 'LAUNCH', text: 'RQ-EXAMPLE-1' }] })).toEqual([]);
  });
  it('keeps the stall incident unchanged when both conditions hold', () => {
    const rows = incidents({ ...healthy(), events: [fail(1), fail(16), fail(31), pass(46)] }, now);
    expect(rows.map(row => row.id)).toContain('executor-down');
    expect(rows.find(row => row.id === 'stall')).toMatchObject({
      severity: 'incident', title: 'Fleet stalled', detail: 'No launches, publishes or merges for 46 min.',
    });
  });
});
