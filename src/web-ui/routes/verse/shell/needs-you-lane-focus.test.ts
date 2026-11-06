/** Every per-lane Needs-you row carries its lane so Open lands on that lane in the Lanes pane. */
import { describe, expect, it } from 'vitest';
import type { AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { deriveFleetNeedsYou } from './fleet-needs-you.js';
import { deriveLaneStallNeedsYou } from './lane-stall-needs-you.js';
import { deriveLaneStreakNeedsYou } from './lane-streak-needs-you.js';
import type { LaneStreak, LaneStreaksRead } from './lane-streak-query.js';
import { deriveMeterFlatNeedsYou } from './meter-flat-needs-you.js';
import { deriveWasteHighNeedsYou } from './waste-high-needs-you.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const iso = new Date(NOW).toISOString();
const laneRow = (lane: string, over: Record<string, unknown> = {}) => ({ lane, running: 0, target: 2, queued: 5, held: false,
  heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null, ...over });
const runs = (lanes: ReturnType<typeof laneRow>[], over: Partial<FleetRuns> = {}): FleetRuns => ({
  v: 1, generatedAt: iso, sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: iso, paused: false, memFreePct: 50, diskFreeGb: 80, switches: [], claudeLane: null, lanes,
  workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] },
  events: [], codexPersonal: null, inbox: [], drop: null, ...over,
});
const receipt = (body: Record<string, unknown>): AgentBusReceipt => ({ cursor: 1, receivedAt: NOW - 1000,
  envelope: { id: 'fake-1', from: 'fleet', to: 'all', priority: 'P1', ttl: 60_000, body } });
const streak = (lane: string): LaneStreaksRead => ({ kind: 'available', data: { v: 1, generatedAt: iso, source: 'ok', windowMinutes: 60,
  lanes: [{ lane, launches: 3, ended: 3, empties: 3, published: 0, running: 0, medianMinutes: 10, verdict: 'burning',
    lastEmptyJob: null, lastEmptyAt: null } satisfies LaneStreak] } });

describe('Needs-you lane focus', () => {
  it('waste-high opens the Lanes pane focused on its lane', () => {
    const [item] = deriveWasteHighNeedsYou([receipt({ kind: 'waste-high', lane: 'devin', projectedUnusedPct: 40, hoursToReset: 9, text: 'devin waste' })], NOW);
    expect(item?.open).toEqual({ kind: 'pane', paneId: 'fleet-lanes', lane: 'devin' });
    expect(item?.nextStep).toBe("Raise this lane's target or add jobs for it");
  });

  it('lane stall carries its lane', () => {
    const [item] = deriveLaneStallNeedsYou(runs([laneRow('devin')]), NOW);
    expect(item?.open).toEqual({ kind: 'pane', paneId: 'fleet-lanes', lane: 'devin' });
  });

  it('lane streak carries its lane on a non-claude lane and stays a terminal row on claude', () => {
    const [item] = deriveLaneStreakNeedsYou(streak('devin'), null, NOW);
    expect(item?.open).toEqual({ kind: 'pane', paneId: 'fleet-lanes', lane: 'devin' });
    const [claude] = deriveLaneStreakNeedsYou(streak('claude-api'), null, NOW);
    expect(claude?.open?.kind).toBe('terminal');
  });

  it('meter flat carries its lane', () => {
    const [item] = deriveMeterFlatNeedsYou([receipt({ kind: 'meter-flat', provider: 'devin', observedMinutes: 30, text: 'devin flat' })], NOW);
    expect(item?.open).toEqual({ kind: 'pane', paneId: 'fleet-lanes', lane: 'devin' });
  });

  it('held and idle lane rows carry their lane; a non-lane row does not', () => {
    const { items } = deriveFleetNeedsYou(runs([laneRow('held-one', { held: true, heldReason: 'x' }), laneRow('idle-one')],
      { diskFreeGb: 1 }), NOW);
    const open = (id: string) => items.find(item => item.id === id)?.open;
    expect(open('lane-held:held-one')).toEqual({ kind: 'pane', paneId: 'fleet-lanes', lane: 'held-one' });
    expect(open('lane-idle:idle-one')).toEqual({ kind: 'pane', paneId: 'fleet-lanes', lane: 'idle-one' });
    expect(open('host-pressure')).toEqual({ kind: 'pane', paneId: 'fleet-host' });
  });
});
