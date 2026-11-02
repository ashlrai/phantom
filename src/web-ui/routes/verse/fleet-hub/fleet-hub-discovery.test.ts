import { expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { curatedWorkspace, hubTiles } from './fleet-hub-model.js';

const legacy = ['fleet-lanes', 'fleet-events', 'fleet-inbox', 'fleet-bus', 'fleet-merges', 'fleet-usage', 'fleet-supply', 'fleet-host', 'fleet-timeline'];
const runs: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'degraded', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [], workers: [{ job: 'job-1', repo: 'example/repo', lane: 'codex', tier: 'frontier', ageSeconds: 1 }],
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null,
  inbox: [{ at: '1', source: 'alpha', text: '' }, { at: '2', source: 'beta', text: '' }, { at: '3', source: 'alpha', text: '' }], drop: null,
};

it('discovers registered fleet and leader panes after the stable legacy tiles', () => {
  const tiles = hubTiles(runs, [
    { id: 'leader-journal', title: 'Journal', order: 10 },
    { id: 'fleet-lanes', title: 'Registered lanes' },
    { id: 'fleet-new', title: 'New pane', order: 10 },
    { id: 'terminal', title: 'Terminal', order: 1 },
    { id: 'fleet-lanes', title: 'Latest lanes' },
    { id: 'fleet-channels', title: 'Channels' },
    { id: 'worker-log', title: 'Worker log' },
    { id: 'fleet-job-log', title: 'Job log' },
    { id: 'leader-thread', title: 'Leaders' },
    { id: 'fleet-releases', title: 'Releases' },
  ]);
  expect(tiles.slice(0, 9).map(({ id }) => id)).toEqual(legacy);
  expect(tiles[0]).toMatchObject({ title: 'Latest lanes', present: true });
  expect(tiles[1]?.present).toBe(false);
  expect(tiles.slice(9, 11).map(({ id }) => id)).toEqual(['leader-journal', 'fleet-new']);
  expect(tiles.find(({ id }) => id === 'fleet-new')?.count).toBe('—');
  expect(tiles.find(({ id }) => id === 'fleet-channels')?.count).toBe('2');
  expect(tiles.find(({ id }) => id === 'worker-log')?.count).toBe('1');
  expect(tiles.find(({ id }) => id === 'fleet-job-log')?.count).toBe('1');
  expect(tiles.find(({ id }) => id === 'leader-thread')?.count).toBe('0');
  expect(tiles.find(({ id }) => id === 'fleet-releases')?.count).toBe('—');
  expect(tiles.some(({ id }) => id === 'terminal')).toBe(false);
  expect(new Set(tiles.map(({ id }) => id)).size).toBe(tiles.length);
});

it('keeps only present curated panes in workspace order', () => {
  expect(curatedWorkspace(['fleet-usage', 'fleet-releases', 'fleet-events', 'fleet-inbox', 'fleet-lanes']))
    .toEqual(['fleet-lanes', 'fleet-inbox', 'fleet-releases', 'fleet-usage']);
  expect(curatedWorkspace([])).toEqual([]);
});
