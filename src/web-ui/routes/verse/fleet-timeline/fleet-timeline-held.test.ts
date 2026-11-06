import { describe, expect, it } from 'vitest';
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { laneLabel, timelineLanes } from './fleet-timeline-model.js';

const now = Date.parse('2026-10-31T12:30:00Z');
const lane = (name: string, extra: Partial<FleetRunsV1['lanes'][number]> = {}) => ({
  lane: name, running: 0, target: 2, queued: 0, held: false, heldReason: null,
  tokensLastHour: null, merged24h: null, mergeRate24h: null, ...extra,
});
const worker = (job: string, ageSeconds: number | null, laneName = 'codex') => ({ job, lane: laneName, ageSeconds, tier: 'work', repo: 'example/repo' });
const runs: FleetRunsV1 = {
  v: 1, generatedAt: '2026-10-31T12:30:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, host: null,
  lanes: [lane('codex'), lane('devin')], workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [],
  mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

describe('laneLabel', () => {
  it('keeps the running/target label for a lane that is not held', () => {
    expect(laneLabel({ lane: 'codex', running: 1, target: 2, held: false, heldReason: null }, now)).toBe('codex 1/2');
    expect(laneLabel({ lane: 'codex', running: 0, target: 2, held: false, heldReason: 'out of usage until 2026-11-01 01:22' }, now)).toBe('codex 0/2');
  });

  it('appends the parsed reason and a future reset as until', () => {
    const label = laneLabel({ lane: 'codex-cmp', running: 0, target: 30, held: true, heldReason: 'out of usage until 2026-11-01 01:22' }, now);
    expect(label).toContain('held: out of usage until');
    expect(label).toContain('codex-cmp 0/30 · ');
  });

  it('appends a past or non-until timestamp as since', () => {
    const label = laneLabel({ lane: 'claude', running: 0, target: 2, held: true, heldReason: 'token rejected 2026-10-31 02:11:29' }, now);
    expect(label).toContain('held: token rejected since');
    expect(laneLabel({ lane: 'claude', running: 0, target: 2, held: true, heldReason: 'out of usage until 2026-10-31 02:11' }, now)).toContain(' since ');
  });

  it('ends with held when the lane carries no reason', () => {
    expect(laneLabel({ lane: 'codex', running: 0, target: 2, held: true, heldReason: null }, now)).toBe('codex 0/2 · held');
    expect(laneLabel({ lane: 'codex', running: 0, target: 2, held: true, heldReason: '   ' }, now)).toBe('codex 0/2 · held');
  });

  it('shows a reason without a timestamp as a bare label', () => {
    expect(laneLabel({ lane: 'codex', running: 0, target: 2, held: true, heldReason: 'maintenance window' }, now)).toBe('codex 0/2 · held: maintenance window');
  });

  it('caps the label at 80 characters with an ellipsis', () => {
    const label = laneLabel({ lane: `lane-${'x'.repeat(70)}`, running: 0, target: 2, held: true, heldReason: 'out of usage until 2026-11-01 01:22' }, now);
    expect(label).toHaveLength(80);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('timelineLanes held lanes', () => {
  it('labels the held lane and leaves item placement unchanged', () => {
    const result = timelineLanes({
      ...runs, claimed: [],
      lanes: [lane('codex', { held: true, heldReason: 'out of usage until 2026-11-01 01:22' }), lane('devin')],
      workers: [worker('a', 100), worker('b', 200, 'devin'), worker('c', null)],
    }, now);
    expect(result.lanes[0]!.label).toContain('held: out of usage until');
    expect(result.lanes[1]!.label).toBe('devin 0/2');
    expect(result.lanes.map((swimlane) => swimlane.items.length)).toEqual([1, 1]);
    expect(result.lanes[0]!.items[0]!.id).toBe('a');
    expect(result.lanes[1]!.items[0]!.id).toBe('b');
    expect(result.unknownAge).toBe(1);
  });
});
