import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { CLAUDE_LANE_FIX_COMMAND, deriveClaudeLaneNeedsYou } from './claude-lane-needs-you.js';

const at = new Date(2026, 10, 1, 1, 31, 50);
const now = at.getTime() + 3 * 3_600_000;
const lane: FleetRuns['lanes'][number] = { lane: 'claude', target: 12, running: 2, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null };
const runs = (claudeLane: string, target = 12): FleetRuns => ({
  v: 1, generatedAt: at.toISOString(), sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane, lanes: [{ ...lane, target }],
  workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] },
  events: [], codexPersonal: null, inbox: [], drop: null,
});

describe('Claude lane Needs-you', () => {
  it('reports idle slots, local outage age, cost and the copyable fix', () => {
    const [item] = deriveClaudeLaneNeedsYou(runs('down token rejected 2026-11-01 01:31:50'), now);
    expect(item).toMatchObject({ id: 'claude-lane-down', title: 'Claude lane is down: 10 slots idle',
      detail: 'token rejected · since 01:31, 3 h ago · every hour idle is 12 worker-hours unused',
      nextStep: 'runs claude setup-token, saves the token silently; the fleet rechecks within 5 minutes',
      open: { kind: 'terminal', command: CLAUDE_LANE_FIX_COMMAND } });
    expect(CLAUDE_LANE_FIX_COMMAND).toBe('~/.ashlr-runs/bin/fix-claude-lane.sh');
  });
  it('handles a down status without a timestamp', () => {
    expect(deriveClaudeLaneNeedsYou(runs('DOWN: token rejected'), now)[0]?.detail)
      .toBe('token rejected · every hour idle is 12 worker-hours unused');
  });
  it('returns nothing for healthy, null, absent or disabled lanes', () => {
    expect(deriveClaudeLaneNeedsYou(runs('healthy'), now)).toEqual([]);
    expect(deriveClaudeLaneNeedsYou(runs('not down'), now)).toEqual([]);
    expect(deriveClaudeLaneNeedsYou(null, now)).toEqual([]);
    expect(deriveClaudeLaneNeedsYou(runs('down', 0), now)).toEqual([]);
    expect(deriveClaudeLaneNeedsYou({ ...runs('down'), lanes: [] }, now)).toEqual([]);
  });
  it('never displays an unsafe reason or negative idle slots', () => {
    const unsafe = { ...runs('down /fake/private'), lanes: [{ ...lane, running: 13 }] };
    expect(deriveClaudeLaneNeedsYou(unsafe, now)[0]).toMatchObject({ title: 'Claude lane is down: 0 slots idle',
      detail: 'The lane reported itself down · every hour idle is 12 worker-hours unused' });
  });
});
