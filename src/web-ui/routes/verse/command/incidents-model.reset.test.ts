import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { incidents, RESET_IGNORED_USED_PCT_MAX } from './incidents-model.js';

const now = Date.parse('2026-10-31T20:20:00Z');
const at = new Date(now).toISOString();
const lane = (name: string): FleetRuns['lanes'][number] => ({ lane: name, running: 0, target: 1, queued: 14, held: true, heldReason: 'autobackoff: usage exhausted', tokensLastHour: null, merged24h: null, mergeRate24h: null });
const healthy = (): FleetRuns => ({
  v: 1, generatedAt: at, sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: at, paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: 'up', lanes: [], workers: [], leaders: [], orchestratorAgents: null,
  publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [{ at, kind: 'launch', text: '' }], codexPersonal: null, inbox: [], drop: null,
});
const resetState = (): FleetRuns => ({ ...healthy(), lanes: [lane('codex-personal')], codexPersonal: { usedPct: 0, resetsAt: null, asOf: at } });
const hasResetIncident = (runs: FleetRuns) => incidents(runs, now).some(row => row.id === 'reset-ignored');

describe('reset ignored incident', () => {
  it('reports the fresh personal reading before the held-lanes warning', () => {
    const rows = incidents(resetState(), now);
    const localTime = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
    expect(rows.map(row => row.id)).toEqual(['reset-ignored', 'held-lanes']);
    expect(rows[0]).toEqual({
      id: 'reset-ignored', severity: 'incident', title: 'Personal Codex has reset but its lane is still held',
      detail: `codex-personal reads 0% as of ${localTime} (local) · 14 jobs are waiting on the hold`,
      fix: 'Release the hold in Fleet ▸ Lanes, or wait for the hold to expire',
    });
    expect(rows[1]?.detail).toBe('1 lane held: codex-personal (autobackoff: usage exhausted)');
  });

  it('uses an inclusive finite usage threshold', () => {
    for (const [usedPct, expected] of [[RESET_IGNORED_USED_PCT_MAX, true], [26, false], [97, false], [NaN, false], [Infinity, false], [null, false]] as const) {
      expect(hasResetIncident({ ...resetState(), codexPersonal: { usedPct, resetsAt: null, asOf: at } })).toBe(expected);
    }
  });

  it('requires a parseable reading that is not in the future', () => {
    for (const asOf of [null, 'invalid', new Date(now + 1).toISOString()]) {
      expect(hasResetIncident({ ...resetState(), codexPersonal: { usedPct: 0, resetsAt: null, asOf } })).toBe(false);
    }
  });

  it('requires the personal lane to be held for usage', () => {
    for (const heldLane of [
      { ...lane('codex-personal'), heldReason: 'Mason t1221u pause' },
      { ...lane('codex-personal'), heldReason: null },
      { ...lane('codex-personal'), held: false },
      lane('codex-other'),
    ]) {
      expect(hasResetIncident({ ...resetState(), lanes: [heldLane] })).toBe(false);
    }
    for (const heldReason of ['AUTOBACKOFF', 'usage', 'LIMIT', 'exhausted']) {
      expect(hasResetIncident({ ...resetState(), lanes: [{ ...lane('codex-personal'), heldReason }] })).toBe(true);
    }
  });

  it('retains the held warning even when the personal lane target is zero', () => {
    const rows = incidents({ ...resetState(), lanes: [{ ...lane('codex-personal'), target: 0 }], switches: ['HOLD'] }, now);
    expect(rows.map(row => row.id)).toEqual(['reset-ignored', 'hold', 'held-lanes']);
    expect(rows[2]?.detail).toContain('codex-personal');
  });
});
