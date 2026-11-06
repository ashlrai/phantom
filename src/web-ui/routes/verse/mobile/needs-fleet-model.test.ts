import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { fleetAttention } from './needs-fleet-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const healthy: FleetRuns = {
  v: 1, generatedAt: new Date(now).toISOString(),
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: new Date(now).toISOString(), paused: false, memFreePct: 50, diskFreeGb: 80,
  claudeLane: 'up', switches: [], lanes: [], workers: [], leaders: [{ label: 'leader', ageSeconds: 30 }],
  orchestratorAgents: 1, publishesLastHour: [], mergesLastHour: { count: 1, items: [] },
  events: [], codexPersonal: null, inbox: [], drop: null,
};
const lane = (name: string, held: boolean): FleetRuns['lanes'][number] => ({
  lane: name, running: 0, target: 1, queued: 2, held, heldReason: null,
  tokensLastHour: null, merged24h: null, mergeRate24h: null,
});

describe('fleetAttention', () => {
  it('returns nothing without runs or with a healthy fleet', () => {
    expect(fleetAttention(null, now)).toEqual([]);
    expect(fleetAttention(healthy, now)).toEqual([]);
  });
  it('recognizes a down Claude lane case insensitively and gives the fix', () => {
    const [card] = fleetAttention({ ...healthy, claudeLane: 'DOWN: quota' }, now);
    expect(card).toMatchObject({ id: 'claude-lane-down', severity: 'high', title: 'The Claude lane is down', next: "Run the Claude lane fix script from the runs directory's bin folder, then check Fleet" });
    expect(fleetAttention({ ...healthy, claudeLane: 'not down' }, now)[0]?.id).toBe('claude-lane-down');
    expect(fleetAttention({ ...healthy, claudeLane: 'up' }, now)).toEqual([]);
  });
  it('reports active switches and held lanes with stable identifiers and next steps', () => {
    const runs: FleetRuns = { ...healthy, switches: ['STOP', 'HOLD'], lanes: [lane('codex', true), lane('other', false)] };
    const cards = fleetAttention(runs, now);
    expect(cards.map(({ id, severity, title }) => ({ id, severity, title }))).toEqual([
      { id: 'switches-on', severity: 'high', title: 'Dispatch is paused by STOP, HOLD' },
      { id: 'lane-held:codex', severity: 'medium', title: 'Lane codex is held' },
    ]);
    expect(cards.every((card) => card.detail && card.next)).toBe(true);
    expect(fleetAttention({ ...runs, switches: [...runs.switches].reverse() }, now).map((card) => card.id)).toEqual(cards.map((card) => card.id));
  });
  it('flags a tick strictly older than 20 minutes, or an unknown tick', () => {
    expect(fleetAttention({ ...healthy, lastTick: new Date(now - 20 * 60_000).toISOString() }, now)).toEqual([]);
    const [stale] = fleetAttention({ ...healthy, lastTick: new Date(now - 20 * 60_000 - 1).toISOString() }, now);
    expect(stale).toMatchObject({ id: 'orchestrator-tick', severity: 'high', title: 'Orchestrator tick stale', detail: 'Last tick: 20 min ago.' });
    expect(stale?.next).toContain('orchestrator');
    expect(fleetAttention({ ...healthy, lastTick: null }, now)[0]?.detail).toBe('Last tick: unknown.');
    expect(fleetAttention({ ...healthy, lastTick: 'invalid' }, now)[0]?.detail).toBe('Last tick: unknown.');
  });
  it('orders high severity first and then by title', () => {
    const cards = fleetAttention({ ...healthy, lastTick: null, claudeLane: 'down', switches: ['Z', 'A'], lanes: [lane('beta', true)] }, now);
    expect(cards.map((card) => card.title)).toEqual(['Dispatch is paused by Z, A', 'Orchestrator tick stale', 'The Claude lane is down', 'Lane beta is held']);
  });
});
