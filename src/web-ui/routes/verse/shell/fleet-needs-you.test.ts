/**
 * fleet-needs-you — the drawer's local fleet producer (unit C1): the items
 * the browser derives from GET /api/verse/fleet/runs, and the `answered`
 * half of the "All clear" coverage rule. Fixtures are fake wire snapshots
 * (ops-runs-model isFleetRuns), never real data.
 */
import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { deriveFleetNeedsYou } from './fleet-needs-you.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');

/** A healthy snapshot: dispatcher ticking, a lane working, sources green. */
function snapshot(over: Partial<FleetRuns> = {}): FleetRuns {
  return {
    v: 1,
    generatedAt: '2026-10-31T12:00:00Z',
    sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: '2026-10-31T11:59:00Z',
    paused: false,
    memFreePct: 50,
    diskFreeGb: 80,
    switches: [],
    claudeLane: null,
    lanes: [{ lane: 'codex-cmp', running: 1, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: 100, merged24h: 2, mergeRate24h: 50 }],
    workers: [{ job: 'job-one', repo: 'phantom', lane: 'codex-cmp', tier: 'frontier', ageSeconds: 120 }],
    leaders: [{ label: 'leader', ageSeconds: 30 }],
    orchestratorAgents: 1,
    publishesLastHour: [],
    mergesLastHour: { count: 1, items: [{ repo: 'phantom', number: 12, title: 'Fleet view' }] },
    events: [{ at: '2026-10-31T11:55:00Z', kind: 'worker-start', text: 'started job-one' }],
    codexPersonal: null,
    inbox: [],
    drop: null,
    ...over,
  };
}

const ids = (result: { items: Array<{ id: string }> }) => result.items.map((i) => i.id);

describe('deriveFleetNeedsYou', () => {
  it('the incident snapshot: lane down, a held lane, a switch, low disk — four items', () => {
    const result = deriveFleetNeedsYou(snapshot({
      claudeLane: 'down token rejected 2026-10-31 01:03:35',
      lanes: [{ lane: 'codex-cmp', running: 0, target: 2, queued: 4, held: true, heldReason: 'credit exhausted', tokensLastHour: 0, merged24h: 0, mergeRate24h: 0 }],
      switches: ['HOLD'],
      diskFreeGb: 4,
    }), NOW);
    expect(result.answered).toBe(true);
    expect(ids(result)).toEqual(['claude-lane-down', 'switches-on', 'lane-held:codex-cmp', 'host-pressure']);
    const byId = new Map(result.items.map((i) => [i.id, i]));
    expect(byId.get('claude-lane-down')).toMatchObject({
      severity: 'urgent',
      detail: 'Claude lane: down token rejected 2026-10-31 01:03:35',
      nextStep: "Run the Claude lane fix script from the runs directory's bin folder, then check Fleet",
      target: 'fleet',
    });
    expect(byId.get('switches-on')).toMatchObject({
      severity: 'urgent',
      title: 'Dispatch is paused by HOLD',
      nextStep: 'Clear them in Fleet ▸ Switches',
      target: 'fleet',
    });
    expect(byId.get('lane-held:codex-cmp')).toMatchObject({ severity: 'attention', detail: 'credit exhausted' });
    expect(byId.get('host-pressure')).toMatchObject({ severity: 'attention', detail: 'disk free 4 GB' });
    for (const item of result.items) expect(item.nextStep.length).toBeGreaterThan(0);
  });

  it('a healthy snapshot has nothing for you and still answers', () => {
    expect(deriveFleetNeedsYou(snapshot(), NOW)).toEqual({ answered: true, items: [] });
  });

  it('runsDir missing is both an item and silence — never "All clear"', () => {
    const result = deriveFleetNeedsYou(snapshot({
      sources: { runsDir: 'missing', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    }), NOW);
    expect(result.answered).toBe(false);
    expect(ids(result)).toContain('runs-dir-missing');
    expect(result.items.find((i) => i.id === 'runs-dir-missing')).toMatchObject({ severity: 'urgent', target: 'settings' });
  });

  it('a not-landed or absent runsDir source is silence without an item', () => {
    const notLanded = deriveFleetNeedsYou(snapshot({
      sources: { runsDir: 'not-landed', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    }), NOW);
    expect(notLanded.answered).toBe(false);
    expect(notLanded.items).toEqual([]);
    // Degraded still answers (with caveats) — only missing/not-landed veto.
    expect(deriveFleetNeedsYou(snapshot({
      sources: { runsDir: 'degraded', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    }), NOW).answered).toBe(true);
  });

  it('a missing or malformed snapshot answers nothing', () => {
    for (const bad of [undefined, null, 42, 'snapshot', [], {}, { ...snapshot(), v: 2 }, { ...snapshot(), lanes: [{ lane: 'x' }] }]) {
      expect(deriveFleetNeedsYou(bad, NOW)).toEqual({ answered: false, items: [] });
    }
  });

  it('fires the shared stall rule when nothing started and nothing merged', () => {
    const stalled = snapshot({
      workers: [],
      mergesLastHour: { count: 0, items: [] },
      events: [],
      claudeLane: 'claude-cli',
    });
    const result = deriveFleetNeedsYou(stalled, NOW);
    expect(ids(result)).toContain('stall-incident');
    expect(result.items.find((i) => i.id === 'stall-incident')).toMatchObject({ severity: 'urgent', target: 'ops' });
    // A start inside 30 minutes calms the same empty fleet.
    expect(ids(deriveFleetNeedsYou({
      ...stalled,
      events: [{ at: '2026-10-31T11:50:00Z', kind: 'worker-start', text: 'job-two' }],
    }, NOW))).not.toContain('stall-incident');
  });

  it('lists every held lane with its reason; a missing reason says so', () => {
    const result = deriveFleetNeedsYou(snapshot({
      lanes: [
        { lane: 'codex-cmp', running: 0, target: 2, queued: 4, held: true, heldReason: 'credit exhausted', tokensLastHour: 0, merged24h: 0, mergeRate24h: 0 },
        { lane: 'claude-max', running: 1, target: 1, queued: 0, held: true, heldReason: null, tokensLastHour: 5, merged24h: 1, mergeRate24h: 10 },
        { lane: 'local-qwen', running: 1, target: 1, queued: 0, held: false, heldReason: null, tokensLastHour: 9, merged24h: 3, mergeRate24h: 40 },
      ],
    }), NOW);
    expect(ids(result)).toEqual(['lane-held:codex-cmp', 'lane-held:claude-max']);
    expect(result.items[1]).toMatchObject({ id: 'lane-held:claude-max', detail: 'No reason recorded' });
  });

  it('flags either host reading under 10 and leaves unknown readings out of it', () => {
    expect(ids(deriveFleetNeedsYou(snapshot({ memFreePct: 8 }), NOW))).toContain('host-pressure');
    expect(deriveFleetNeedsYou(snapshot({ memFreePct: 8 }), NOW).items[0]).toMatchObject({ detail: 'memory free 8 %' });
    // null is unknown, never evidence of pressure (the honesty rule).
    expect(ids(deriveFleetNeedsYou(snapshot({ diskFreeGb: null, memFreePct: null }), NOW))).toEqual([]);
    expect(ids(deriveFleetNeedsYou(snapshot({ diskFreeGb: 10, memFreePct: 10 }), NOW))).toEqual([]);
  });

  it('reads a lane-down only from "down", and never prints a path', () => {
    expect(ids(deriveFleetNeedsYou(snapshot({ claudeLane: 'claude-cli' }), NOW))).toEqual([]);
    expect(ids(deriveFleetNeedsYou(snapshot({ claudeLane: 'down: quota' }), NOW))).toContain('claude-lane-down');
    const unsafe = deriveFleetNeedsYou(snapshot({ claudeLane: 'down /Users/mason/runs state' }), NOW);
    expect(unsafe.items[0]!.detail).toBe('The lane reported itself down.');
    expect(unsafe.items[0]!.detail).not.toContain('/Users');
  });
});
