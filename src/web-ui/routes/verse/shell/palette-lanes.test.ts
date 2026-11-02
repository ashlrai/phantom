import { expect, it } from 'vitest';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { laneItemTitle, paletteLanes } from './palette-lanes.js';

it('maps all three fleet lanes and tolerates a missing snapshot', () => {
  const runs = fleetRunsFixture();
  runs.lanes.push({ ...runs.lanes[0]!, lane: 'fake-third', target: 0, held: true });
  const lanes = paletteLanes(runs, {});
  expect(lanes).toHaveLength(3);
  expect(lanes[0]).toEqual({ lane: 'codex-personal', running: 3, target: 4, held: false, paused: false });
  expect(laneItemTitle(lanes[0]!)).toBe('Lane codex-personal: 3/4 running · pause');
  expect(laneItemTitle(lanes[2]!)).toBe('Lane fake-third: 3/0 running · paused · resume · held, resume target only');
  expect(paletteLanes(null, {})).toEqual([]);
  expect(paletteLanes(undefined, {})).toEqual([]);
});
it('shows resume when the pause record remembers the target', () => {
  const lanes = paletteLanes(fleetRunsFixture(), { 'codex-personal': 4 });
  expect(laneItemTitle(lanes[0]!)).toBe('Lane codex-personal: 3/4 running · paused · resume');
});
