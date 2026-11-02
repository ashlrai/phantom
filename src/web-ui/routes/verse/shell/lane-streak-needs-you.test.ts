import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { FleetNeedsYouRows, type FleetNeedsYouReport } from './FleetNeedsYouRows.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { CLAUDE_LANE_FIX_COMMAND } from './claude-lane-needs-you.js';
import { deriveLaneStreakNeedsYou } from './lane-streak-needs-you.js';
import type { LaneStreak, LaneStreaksRead } from './lane-streak-query.js';

const at = new Date(2026, 10, 1, 1, 31);
const lane: LaneStreak = { lane: 'claude-api', launches: 3, ended: 3, empties: 3, published: 0, running: 0,
  medianMinutes: 10, verdict: 'burning', lastEmptyJob: 'RQ-PS10A103123Q8', lastEmptyAt: at.toISOString() };
const read = (item: LaneStreak): LaneStreaksRead => ({ kind: 'available', data: {
  v: 1, generatedAt: at.toISOString(), source: 'ok', windowMinutes: 60, lanes: [item],
} });
const runs: FleetRuns = {
  v: 1, generatedAt: at.toISOString(), sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: 'down token rejected',
  lanes: [{ lane: 'claude-api', target: 1, running: 0, queued: 12, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] },
  events: [], codexPersonal: null, inbox: [], drop: null,
};

describe('lane streak Needs-you', () => {
  it('reports a burning claude-api lane and opens its fix even when claude is down', () => {
    expect(deriveLaneStreakNeedsYou(read(lane), runs, at.getTime())).toEqual([{
      id: 'lane-burning-claude-api', severity: 'urgent', target: 'fleet',
      title: 'Lane claude-api is burning jobs: 3 of 3 launches ended empty in 60 min',
      detail: 'nothing published · median 10 min per job · last RQ-PS10A103123Q8 at 01:31 · 12 queued behind it',
      nextStep: 'run the Claude lane fix, then release the lane; until then every launch burns about 10 minutes',
      open: { kind: 'terminal', command: CLAUDE_LANE_FIX_COMMAND },
    }]);
  });
  it('directs other burning lanes to Lanes without inventing queue or timestamp data', () => {
    const [item] = deriveLaneStreakNeedsYou(read({ ...lane, lane: 'devin', medianMinutes: null, lastEmptyAt: 'bad' }), runs, at.getTime());
    expect(item).toMatchObject({ id: 'lane-burning-devin', severity: 'urgent', detail: 'nothing published',
      nextStep: "hold the lane and read the last empty job's worker log", open: { kind: 'pane', paneId: 'fleet-lanes' } });
  });
  it('ignores ok lanes, a down claude lane and missing reads', () => {
    expect(deriveLaneStreakNeedsYou(read({ ...lane, verdict: 'ok' }), runs, at.getTime())).toEqual([]);
    expect(deriveLaneStreakNeedsYou(read({ ...lane, lane: 'claude' }), runs, at.getTime())).toEqual([]);
    expect(deriveLaneStreakNeedsYou(undefined, runs, at.getTime())).toEqual([]);
    expect(deriveLaneStreakNeedsYou({ kind: 'notInBuild' }, null, at.getTime())).toEqual([]);
    expect(deriveLaneStreakNeedsYou(read({ ...lane, lane: 'claude' }), null, at.getTime())).toHaveLength(1);
  });
});


it('shows the route result in the drawer and includes it in the fleet report', async () => {
  evictAll();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/verse/fleet/runs') return Response.json(runs);
    if (path === '/api/verse/runs-history/lane-streaks') return Response.json((read(lane) as Extract<LaneStreaksRead, { kind: 'available' }>).data);
    return new Response('', { status: 404 });
  }));
  const reports: FleetNeedsYouReport[] = [];
  render(createElement(FleetNeedsYouRows, { split: 'fleet', nowMs: at.getTime(), onResult: report => reports.push(report) }));
  expect(await screen.findByText('Lane claude-api is burning jobs: 3 of 3 launches ended empty in 60 min')).toBeVisible();
  await waitFor(() => expect(reports.at(-1)?.items.some(item => item.id === 'lane-burning-claude-api')).toBe(true));
});

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });
