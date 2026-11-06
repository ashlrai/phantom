import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { plannerRows, plannerTell } from './planners-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const runs: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [], workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const lane = { lane: 'codex-personal', running: 0, target: 1, queued: 0, held: true, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null };

describe('plannerRows', () => {
  it.each([[0, 'ok'], [1199, 'ok'], [1200, 'warn'], [2699, 'warn'], [2700, 'bad'], [4000, 'bad'], [null, 'bad']] as const)(
    'classifies age %s as %s', (ageSeconds, tone) => {
      expect(plannerRows({ ...runs, leaders: [{ label: 'any leader', ageSeconds }] }, now)[0]).toMatchObject({ ageSeconds, tone });
    },
  );
  it('preserves every label and displays unknown ages', () => {
    expect(plannerRows({ ...runs, leaders: [{ label: 'fleet-leader', ageSeconds: null }, { label: 'sol', ageSeconds: 4000 }] }, now)).toEqual([
      { label: 'fleet-leader', ageSeconds: null, ageText: 'Unknown', tone: 'bad' },
      { label: 'sol', ageSeconds: 4000, ageText: '1:06 ago', tone: 'bad' },
    ]);
    expect(plannerRows(null, now)).toEqual([]);
  });
});

describe('plannerTell', () => {
  it('explains all stale personal planners when their lane is held', () => {
    const result = plannerTell({ ...runs, lanes: [lane], leaders: [{ label: 'SOL leader', ageSeconds: 4000 }, { label: 'Hourly Executor', ageSeconds: 1200 }] }, now);
    expect(result).toEqual({ text: 'The personal Codex lane is held; planner passes: SOL leader (last pass: 1:06 ago), Hourly Executor (last pass: 20:00 ago).', tone: 'bad' });
  });
  it('reports a usage issue even when the held flag is false', () => {
    const result = plannerTell({ ...runs, lanes: [{ ...lane, held: false, heldReason: 'USAGE limit' }], leaders: [{ label: 'executor', ageSeconds: null }] }, now);
    expect(result).toEqual({ text: 'The personal Codex lane is reporting a usage issue; planner passes: executor (last pass: Unknown).', tone: 'bad' });
  });
  it('points to the existing Claude lane fix for stale Claude planners', () => {
    const result = plannerTell({ ...runs, claudeLane: 'DOWN: offline', leaders: [{ label: 'fleet-CLAUDE', ageSeconds: 1200 }] }, now);
    expect(result).toEqual({ text: 'fleet-CLAUDE (last pass: 20:00 ago): the Claude lane is down. See the fix line in Claude lane.', tone: 'warn' });
  });
  it('includes both lane explanations when both are affected', () => {
    const result = plannerTell({ ...runs, lanes: [lane], claudeLane: 'down', leaders: [{ label: 'sol', ageSeconds: 1200 }, { label: 'claude', ageSeconds: 2700 }] }, now);
    expect(result?.text).toContain('personal Codex lane is held');
    expect(result?.text).toContain('Claude lane is down');
    expect(result?.tone).toBe('bad');
  });
  it('does not report healthy leaders, unrelated labels or unheld lanes', () => {
    expect(plannerTell({ ...runs, lanes: [lane], claudeLane: 'down', leaders: [{ label: 'sol', ageSeconds: 600 }, { label: 'claude', ageSeconds: 600 }] }, now)).toBeNull();
    expect(plannerTell({ ...runs, lanes: [{ ...lane, held: false }], leaders: [{ label: 'sol', ageSeconds: 4000 }] }, now)).toBeNull();
    expect(plannerTell({ ...runs, lanes: [lane], claudeLane: 'not down', leaders: [{ label: 'fleet-leader', ageSeconds: 4000 }, { label: 'claude', ageSeconds: 4000 }] }, now)).toBeNull();
    expect(plannerTell(null, now)).toBeNull();
  });
});
