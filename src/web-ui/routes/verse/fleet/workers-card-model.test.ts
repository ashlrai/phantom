import { expect, it } from 'vitest';
import { ageText, describeWorkers, narrowWorkers, narrowJob, publishFor, sortWorkers, validJob } from './workers-card-model.js';
export const fixture = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { workers: 'healthy' }, workers: [
  { job: 'job-one', repo: 'example/repo', lane: 'work', tier: 'mid', ageSeconds: 59 },
  { job: 'job-two', repo: 'example/repo', lane: 'frontier', tier: 'frontier', ageSeconds: 3661 },
], publishesLastHour: [
  { job: 'job-one', lane: 'work', url: 'https://github.com/example/repo/pull/1', at: '2026-10-31T12:00:00Z' },
  { job: 'job-two', lane: null, url: 'http://example.com/unsafe', at: '2026-10-31T12:00:00Z' },
] };
it('narrows the allowed snapshot and rejects malformed workers', () => {
  expect(narrowWorkers(fixture)).toEqual({ ...fixture, switches: [], paused: null, runsDir: 'not-landed' });
  expect(narrowWorkers({ ...fixture, workers: {} })).toBeNull();
  expect(narrowWorkers({ ...fixture, workers: [{ ...fixture.workers[0], ageSeconds: '59' }] })).toBeNull();
  expect(validJob('job/one')).toBe(false);
  expect(narrowWorkers({ ...fixture, workers: [{ ...fixture.workers[0], job: 'job/one' }] })).toBeNull();
  expect(narrowJob({ schema: 'wrong' })).toBeNull();
});
it('formats ages, orders lanes then oldest first, and describes counts', () => {
  expect(ageText(59)).toBe('0:59'); expect(ageText(3661)).toBe('1:01');
  const workers = narrowWorkers(fixture)!.workers;
  expect(sortWorkers([...workers, { ...workers[0]!, job: 'job-old', ageSeconds: 100 }]).map(w => w.job)).toEqual(['job-two', 'job-old', 'job-one']);
  expect(publishFor('job-one', fixture.publishesLastHour)).toBe(fixture.publishesLastHour[0]!.url);
  expect(publishFor('job-two', fixture.publishesLastHour)).toBeNull();
  expect(publishFor('absent', fixture.publishesLastHour)).toBeNull();
  expect([0, 1, 3].map(describeWorkers)).toEqual(['No workers running', '1 worker running', '3 workers running']);
});
