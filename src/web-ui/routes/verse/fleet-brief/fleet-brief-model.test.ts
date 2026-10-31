import { expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { fleetBriefText } from './fleet-brief-model.js';

const runs: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: '2026-10-31T11:59:00Z', paused: false, memFreePct: null, diskFreeGb: null, switches: ['safe'], claudeLane: 'busy',
  lanes: [{ lane: 'codex-personal', running: 18, target: 24, queued: 0, held: true, heldReason: 'budget', tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 1, items: [{ repo: 'fake/repo', number: 12, title: 'A change' }] }, events: [], codexPersonal: null,
  inbox: [{ at: '2026-10-31T11:45:00Z', source: 'test', text: 'Hello' }, { at: '2026-10-31T11:50:00Z', source: 'fake', text: 'Latest' }], drop: null,
};
const now = Date.parse('2026-10-31T12:00:00Z');

it('formats a full brief with the newest inbox entry and held reason', () => {
  expect(fleetBriefText(runs, now)).toBe('Phantom fleet 12:00 UTC\nLanes: codex-personal 18/24 (held: budget)\nMerged last hour: 1\n- fake/repo #12 A change\nClaude lane: busy\nTick: 01:00\nSwitches: safe\nInbox newest: 11:50 fake: Latest');
});
it('handles empty collections and missing values', () => {
  expect(fleetBriefText({ ...runs, lanes: [], mergesLastHour: { count: 0, items: [] }, inbox: [], switches: [], claudeLane: null, lastTick: null }, now)).toBe('Phantom fleet 12:00 UTC\nLanes: none\nMerged last hour: 0\nClaude lane: ok\nTick: —\nSwitches: none');
  expect(fleetBriefText({ ...runs, lanes: [{ ...runs.lanes[0]!, heldReason: null }] }, now)).toContain('(held: unspecified)');
});
it('caps output by removing merges before truncating inbox', () => {
  const text = fleetBriefText({ ...runs, mergesLastHour: { count: 1, items: [{ repo: 'fake/repo', number: 1, title: 'x'.repeat(2000) }] }, inbox: [{ at: runs.generatedAt, source: 'fake', text: 'y'.repeat(200) }] }, now);
  expect(text.length).toBeLessThanOrEqual(2000);
  expect(text).not.toContain('- fake/repo');
  expect(text).toContain('y'.repeat(120));
  expect(fleetBriefText({ ...runs, switches: ['z'.repeat(2100)] }, now).length).toBe(2000);
});
