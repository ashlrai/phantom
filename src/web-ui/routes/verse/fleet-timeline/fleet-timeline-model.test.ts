import { describe, expect, it } from 'vitest';
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { timelineLanes } from './fleet-timeline-model.js';

const now = Date.parse('2026-10-31T12:30:00Z');
const lane = (name: string) => ({ lane: name, running: 0, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null });
const worker = (job: string, ageSeconds: number | null, laneName = 'codex') => ({ job, lane: laneName, ageSeconds, tier: 'work', repo: 'example/repo' });
const runs: FleetRunsV1 = {
  v: 1, generatedAt: '2026-10-31T12:30:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [lane('codex'), lane('devin')], workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [],
  mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

describe('timelineLanes', () => {
  it('classifies both threshold boundaries and identifies the longest worker', () => {
    const result = timelineLanes({ ...runs, workers: [worker('a', 1200), worker('b', 1201), worker('c', 2700), worker('d', 2701)] }, now);
    expect(result.lanes[0]!.items.map((item) => item.status)).toEqual(['running', 'slow', 'slow', 'stuck']);
    expect(result.lanes[0]!.items[3]).toMatchObject({ id: 'd', start: now - 2701_000, end: null, detail: 'd · work · 45:01' });
    expect(result.longest).toEqual({ job: 'd', lane: 'codex', ageSeconds: 2701 });
    expect(result.from).toBe(Date.parse('2026-10-31T11:00:00Z'));
    expect(result.to).toBe(now);
  });

  it('retains empty lanes, groups unlisted lanes and counts unknown ages', () => {
    const result = timelineLanes({ ...runs, workers: [worker('a', null), worker('b', 40, 'new-lane'), worker('c', null, 'missing')] }, now);
    expect(result.lanes.map(({ label }) => label)).toEqual(['codex 0/2', 'devin 0/2', 'other']);
    expect(result.lanes.map(({ items }) => items.length)).toEqual([0, 0, 1]);
    expect(result.unknownAge).toBe(2);
    expect(result.longest).toEqual({ job: 'b', lane: 'new-lane', ageSeconds: 40 });
  });

  it('clamps the window at two hours while retaining older starts', () => {
    const result = timelineLanes({ ...runs, workers: [worker('old', 4 * 3600)] }, now);
    expect(result.from).toBe(now - 2 * 3600_000);
    expect(result.lanes[0]!.items[0]!.start).toBe(now - 4 * 3600_000);
  });

  it('returns empty lanes and no longest worker for a zero-worker fleet', () => {
    const result = timelineLanes(runs, now);
    expect(result.lanes.map((item) => item.items)).toEqual([[], []]);
    expect(result.longest).toBeNull();
    expect(result.unknownAge).toBe(0);
    expect(result.from).toBe(Date.parse('2026-10-31T12:00:00Z'));
  });
});
