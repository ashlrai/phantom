import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { hostView } from './fleet-host-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const runs: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [], workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

describe('hostView', () => {
  it.each([[9.99, 'bad'], [10, 'warn'], [24.99, 'warn'], [25, 'ok']] as const)('classifies %s percent memory as %s', (pct, tone) => {
    expect(hostView({ ...runs, memFreePct: pct }, now).memory).toEqual({ pct, tone });
  });
  it.each([[4.99, 'bad'], [5, 'warn'], [19.99, 'warn'], [20, 'ok']] as const)('classifies %s GB disk as %s', (gb, tone) => {
    expect(hostView({ ...runs, diskFreeGb: gb }, now).disk).toEqual({ gb, text: `${gb} GB`, tone });
  });
  it.each([[300, 'ok'], [301, 'warn'], [1200, 'warn'], [1201, 'bad']] as const)('classifies a %s second tick as %s', (seconds, tone) => {
    const lastTick = new Date(now - seconds * 1000).toISOString();
    expect(hostView({ ...runs, lastTick }, now).tick).toMatchObject({ ageSeconds: seconds, tone });
  });
  it('represents missing and invalid readings as unknown', () => {
    expect(hostView(null, now)).toEqual({
      memory: { pct: null, tone: 'ok' }, disk: { gb: null, text: '—', tone: 'ok' }, tick: { ageSeconds: null, text: '—', tone: 'ok' },
      paused: null, switches: [], claudeLane: { text: 'Unknown', down: false }, orchestratorAgents: null,
    });
    expect(hostView({ ...runs, lastTick: 'invalid' }, now).tick.ageSeconds).toBeNull();
    expect(hostView({ ...runs, lastTick: new Date(now + 1000).toISOString() }, now).tick.ageSeconds).toBe(0);
  });
  it.each([['down: offline', true], ['DOWN for repair', true], ['degraded', false], ['not down', false], ['', false]] as const)('detects lane %j as down: %s', (claudeLane, down) => {
    expect(hostView({ ...runs, claudeLane }, now).claudeLane).toEqual({ text: claudeLane, down });
  });
});
