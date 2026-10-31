import { expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { hubTiles } from './fleet-hub-model.js';

const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'degraded', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [{ lane: 'codex', running: 1, target: 2, queued: 3, held: true, heldReason: 'Budget hold', tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: Array.from({ length: 13 }, (_, i) => ({ job: `job-${i}`, repo: 'example/repo', lane: 'codex', tier: 'frontier', ageSeconds: i })),
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 2, items: [{ repo: 'example/repo', number: 12, title: 'Fleet view' }, { repo: 'unknown', number: 13, title: 'No owner' }] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

it('computes live counts and availability without requiring registrations', () => {
  const tiles = hubTiles({ ...fixture, events: [{ at: 'fake', kind: 'tick', text: 'fake' }], inbox: [{ at: 'fake', source: 'fake', text: 'fake' }] }, [{ id: 'fleet-lanes', title: 'Lanes' }, { id: 'fleet-events', title: 'Fleet events' }]);
  expect(tiles.map(({ id, count }) => [id, count])).toEqual([
    ['fleet-lanes', '1/2 · 1 held'], ['fleet-events', '1'], ['fleet-inbox', '1'], ['fleet-bus', '—'],
    ['fleet-merges', '2'], ['fleet-usage', '—'], ['fleet-supply', '13'], ['fleet-host', '—'], ['fleet-timeline', '—'],
  ]);
  expect(tiles.filter((tile) => tile.present).map((tile) => tile.id)).toEqual(['fleet-lanes', 'fleet-events']);
});

it('preserves unknown readings and sums all lanes', () => {
  expect(hubTiles(null, []).every((tile) => tile.count === '—' && !tile.present)).toBe(true);
  const tiles = hubTiles({ ...fixture, lanes: [...fixture.lanes, ...fixture.lanes], mergesLastHour: { count: null, items: [] } }, []);
  expect(tiles[0]?.count).toBe('2/4 · 2 held');
  expect(tiles.find((tile) => tile.id === 'fleet-merges')?.count).toBe('—');
});
