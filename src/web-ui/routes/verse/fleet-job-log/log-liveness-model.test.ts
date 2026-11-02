import { expect, it } from 'vitest';
import { livenessText, livenessTone, newLinesLabel, trackGrowth } from './log-liveness-model.js';

it('tracks growth across readings, clears on follow, and handles rolling tails', () => {
  const detail = (tail: string[], bytes: number, follow = false) => ({ schema: 'fleet.job.v1' as const, follow, log: { tail, bytes } });
  const first = trackGrowth(null, detail(['a', 'b', 'c'], 6), 1000);
  expect(first).toMatchObject({ lastGrowthAt: 1000, unseenLines: 0 });
  const second = trackGrowth(first, detail(['a', 'b', 'c', 'd'], 8), 2000);
  expect(second).toMatchObject({ lastGrowthAt: 2000, unseenLines: 1 });
  const third = trackGrowth(second, detail(['c', 'd', 'e', 'f'], 12), 3000);
  expect(third).toMatchObject({ lastGrowthAt: 3000, unseenLines: 3 });
  expect(trackGrowth(third, detail(['c', 'd', 'e', 'f'], 12, true), 4000)).toMatchObject({ lastGrowthAt: 3000, unseenLines: 0 });
  expect(trackGrowth(third, detail(['c', 'd', 'e', 'finished'], 18), 4000).unseenLines).toBe(3);
  expect(trackGrowth(null, detail([], 0), 1000).lastGrowthAt).toBeNull();
});

it('formats output age and applies quiet thresholds only to running jobs', () => {
  expect(livenessText(null, 'running', 0)).toBe('No output yet');
  expect(livenessText(0, 'running', 12_000)).toBe('Output 12 s ago');
  expect(livenessText(0, 'running', 180_000)).toBe('Output 3 min ago');
  expect(livenessText(0, 'published', 180_000)).toBe('Finished');
  expect(livenessText(null, 'archived', 180_000)).toBe('Finished');
  expect(livenessTone(0, 'running', 119_999)).toBe('running');
  expect(livenessTone(0, 'running', 120_000)).toBe('neutral');
  expect(livenessTone(0, 'running', 600_000)).toBe('neutral');
  expect(livenessTone(0, 'running', 600_001)).toBe('warning');
  expect(livenessTone(0, 'archived', 900_000)).toBe('neutral');
  expect(livenessTone(null, 'running', 900_000)).toBe('neutral');
  expect(newLinesLabel(1)).toBe('1 new line');
  expect(newLinesLabel(3)).toBe('3 new lines');
});
