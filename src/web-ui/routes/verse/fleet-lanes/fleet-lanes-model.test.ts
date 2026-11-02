import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { headline, laneBars, workerRows } from './fleet-lanes-model.js';

const lane = { lane: 'codex', running: 2, target: 4, queued: 3, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null };
const runs: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: '2026-10-31T11:59:20Z', paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [lane], workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 2, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

describe('fleet lanes model', () => {
  it('clamps lane fills, handles zero targets and mutes held lanes', () => {
    const bars = laneBars({ ...runs, lanes: [lane, { ...lane, lane: 'held', running: 8, held: true, heldReason: 'Budget' }, { ...lane, lane: 'zero', target: 0 }, { ...lane, lane: 'negative', running: -1 }] });
    expect(bars.map(({ fillPct, tone }) => [fillPct, tone])).toEqual([[50, 'running'], [100, 'held'], [null, 'running'], [0, 'running']]);
    expect(bars[1]).toMatchObject({ held: true, heldReason: 'Budget', queued: 3 });
  });
  it('sorts known worker ages oldest first and formats ages, leaving unknown last', () => {
    const worker = { job: 'a', repo: 'example/repo', lane: 'codex', tier: 'frontier', ageSeconds: 10 };
    const rows = workerRows({ ...runs, workers: [worker, { ...worker, job: 'unknown', ageSeconds: null }, { ...worker, job: 'old', ageSeconds: 120 }] });
    expect(rows.map(({ job, age }) => [job, age])).toEqual([['old', '02:00'], ['a', '00:10'], ['unknown', '—']]);
  });
  it('summarizes totals and preserves unknown readings', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    expect(headline(runs, now)).toBe('2 running · 4 target · 2 merged last hour · tick 40 s ago');
    expect(headline({ ...runs, lastTick: null, mergesLastHour: { count: null, items: [] } }, now)).toBe('2 running · 4 target · — merged last hour · tick —');
    expect(headline(null, now)).toBe('— running · — target · — merged last hour · tick —');
    expect(headline({ ...runs, lastTick: '2026-10-31T11:58:00Z' }, now)).toContain('tick 2 minutes ago');
  });
});
