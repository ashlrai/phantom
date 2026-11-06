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
    const active = { ...healthy, lanes: [lane('claude', false)] };
    const [card] = fleetAttention({ ...active, claudeLane: 'DOWN: quota' }, now);
    expect(card).toMatchObject({ id: 'claude-lane-down', severity: 'high', title: 'Claude lane is down: 1 slots idle', next: 'runs claude setup-token, saves the token silently; the fleet rechecks within 5 minutes' });
    expect(fleetAttention({ ...active, claudeLane: 'not down' }, now).some((item) => item.id === 'claude-lane-down')).toBe(false);
    expect(fleetAttention({ ...healthy, claudeLane: 'down' }, now)).toEqual([]);
    expect(fleetAttention({ ...healthy, claudeLane: 'up' }, now)).toEqual([]);
  });
  it('reports active switches and held lanes with stable identifiers and next steps', () => {
    const runs: FleetRuns = { ...healthy, switches: ['STOP', 'HOLD'], lanes: [lane('codex', true), lane('other', false)] };
    const cards = fleetAttention(runs, now);
    expect(cards.map(({ id, severity, title }) => ({ id, severity, title }))).toEqual([
      { id: 'switches-on', severity: 'high', title: 'Dispatch is paused by STOP, HOLD' },
      { id: 'lane-held:codex', severity: 'medium', title: 'Lane codex is held' },
      { id: 'lane-idle:other', severity: 'medium', title: 'Lane other is idle' },
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
    const cards = fleetAttention({ ...healthy, lastTick: null, claudeLane: 'down', switches: ['Z', 'A'], lanes: [lane('beta', true), { ...lane('claude', false), queued: 0 }] }, now);
    expect(cards.map((card) => card.title)).toEqual(['Claude lane is down: 1 slots idle', 'Dispatch is paused by Z, A', 'Orchestrator tick stale', 'Lane beta is held']);
  });
});
