import { describe, expect, it } from 'vitest';
import type { FleetQueueV1 } from '../ops/ops-queue-model.js';
import { groupRows, laneRows, queueHeadline, queueTone, skipRows } from './queue-model.js';

const queue: FleetQueueV1 = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { ready: 'healthy', skips: 'healthy' },
  total: 6, ready: 1, parked: 5, malformed: 0, skipsLast24h: 2,
  byLane: [{ lane: 'z', ready: 1, parked: 1 }, { lane: 'b', ready: 0, parked: 2 }, { lane: 'a', ready: 0, parked: 2 }],
  groups: [{ reason: 'BYHAND', lane: null, count: 10, jobs: ['a', 'b', 'c', 'd', 'e'] }],
  skips: [
    { at: '2026-10-30T12:00:00Z', job: 'old', code: '1', reason: 'old' },
    { at: '2026-10-31T13:00:00+02:00', job: 'middle', code: '2', reason: 'middle' },
    { at: '2026-10-31T12:00:00Z', job: 'new', code: '3', reason: 'new' },
  ],
};

describe('mobile queue model', () => {
  it('describes the counts and optional skip total', () => {
    expect(queueHeadline(queue)).toBe('1 ready · 5 parked · 2 skips/24 h');
    expect(queueHeadline({ ...queue, skipsLast24h: null })).toBe('1 ready · 5 parked');
    expect(queueHeadline({ ...queue, skipsLast24h: 0 })).toContain('0 skips/24 h');
  });

  it.each([
    [0, 0, 'neutral'], [1, 0, 'ok'], [1, 5, 'warn'], [0, 5, 'danger'],
  ] as const)('assigns a tone for %i ready and %i parked', (ready, parked, tone) => {
    expect(queueTone({ ...queue, total: ready + parked, ready, parked })).toBe(tone);
  });

  it('sorts lanes by parked count, then name without mutating the response', () => {
    expect(laneRows(queue).map((row) => row.lane)).toEqual(['a', 'b', 'z']);
    expect(queue.byLane.map((row) => row.lane)).toEqual(['z', 'b', 'a']);
  });

  it('caps group jobs and counts all remaining jobs, including those omitted by the API', () => {
    expect(groupRows(queue)).toEqual([{ reason: 'BYHAND', lane: 'any lane', count: 10, jobs: ['a', 'b', 'c', 'd'], more: 6 }]);
    expect(groupRows(queue, 2)[0]).toMatchObject({ jobs: ['a', 'b'], more: 8 });
  });

  it('sorts skips by actual timestamp, newest first, and limits the result', () => {
    expect(skipRows(queue, 2).map((row) => row.job)).toEqual(['new', 'middle']);
    expect(queue.skips[0]?.job).toBe('old');
  });
});
