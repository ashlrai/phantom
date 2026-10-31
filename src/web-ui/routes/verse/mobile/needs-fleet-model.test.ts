import { describe, expect, it } from 'vitest';
import type { FleetRuns } from './home-runs-model.js';
import { fleetAttention } from './needs-fleet-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const healthy: FleetRuns = {
  lastTick: new Date(now).toISOString(), claudeLane: 'up', switches: [], lanes: [],
  mergesLastHour: { count: 0 }, codexPersonal: null,
};

describe('fleetAttention', () => {
  it('returns nothing without runs or with a healthy fleet', () => {
    expect(fleetAttention(null, now)).toEqual([]);
    expect(fleetAttention(healthy, now)).toEqual([]);
  });
  it('recognizes a down Claude lane case insensitively and gives the fix', () => {
    const [card] = fleetAttention({ ...healthy, claudeLane: 'DOWN: quota' }, now);
    expect(card).toMatchObject({ id: 'claude-lane', severity: 'high', title: 'Claude lane down', next: 'On the Mac run ~/.ashlr-runs/bin/fix-claude-lane.sh' });
    expect(fleetAttention({ ...healthy, claudeLane: 'not down' }, now)).toEqual([]);
  });
  it('reports each active switch and held lane with stable identifiers and next steps', () => {
    const runs: FleetRuns = { ...healthy, switches: ['STOP', 'HOLD'], lanes: [
      { lane: 'codex', running: 0, target: 1, queued: 2, held: true },
      { lane: 'other', running: 1, target: 1, queued: 0, held: false },
    ] };
    const cards = fleetAttention(runs, now);
    expect(cards.map(({ id, severity, title }) => ({ id, severity, title }))).toEqual([
      { id: 'switch:HOLD', severity: 'medium', title: 'HOLD is on' },
      { id: 'lane:codex', severity: 'medium', title: 'Lane codex held' },
      { id: 'switch:STOP', severity: 'medium', title: 'STOP is on' },
    ]);
    expect(cards.every((card) => card.detail && card.next.includes('Mac'))).toBe(true);
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
    const cards = fleetAttention({ ...healthy, lastTick: null, claudeLane: 'down', switches: ['Z', 'A'], lanes: [
      { lane: 'beta', running: null, target: null, queued: null, held: true },
    ] }, now);
    expect(cards.map((card) => card.title)).toEqual(['Claude lane down', 'Orchestrator tick stale', 'A is on', 'Lane beta held', 'Z is on']);
  });
});
