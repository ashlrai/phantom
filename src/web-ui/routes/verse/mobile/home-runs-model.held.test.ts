import { expect, it } from 'vitest';
import { homeRunsView, isHomeFleetRuns } from './home-runs-model.js';

it('validates and carries lane hold reasons and merge counts', () => {
  const runs = {
    v: 1, lastTick: null, claudeLane: null, switches: [], codexPersonal: null,
    lanes: [{ lane: 'codex', running: 2, target: 4, queued: 0, held: true, heldReason: 'usage_limit', merged24h: 12 }],
    mergesLastHour: { count: 0 },
  };
  expect(isHomeFleetRuns(runs)).toBe(true);
  if (!isHomeFleetRuns(runs)) throw new Error('Invalid fixture');
  expect(homeRunsView(runs, 0).lanes[0]).toMatchObject({ heldReason: 'usage_limit', merged24h: 12, tone: 'danger' });
  expect(isHomeFleetRuns({ ...runs, lanes: [{ ...runs.lanes[0], heldReason: 1 }] })).toBe(false);
  expect(isHomeFleetRuns({ ...runs, lanes: [{ ...runs.lanes[0], merged24h: NaN }] })).toBe(false);
});
