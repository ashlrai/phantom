import { describe, expect, it } from 'vitest';
import { explainReason, explainSkip, isFleetQueue, laneRows, queueTiles, type FleetQueueV1 } from './ops-queue-model.js';

const fixture: FleetQueueV1 = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { ready: 'healthy', skips: 'healthy' },
  total: 5, ready: 2, parked: 3, malformed: 1,
  byLane: [{ lane: 'one', ready: 2, parked: 1 }, { lane: 'two', ready: 0, parked: 2 }],
  groups: [], skips: [], skipsLast24h: null,
};

describe('queue model', () => {
  it.each([
    ['MERGERATE', 'Merge rate gate', "This lane's recent merge rate fell under the gate. Jobs wait until it recovers or a leader unparks them."],
    ['INVALID', 'Invalid job line', 'The queue line failed validation (lane, tier or prompt path). Fix the line or drop the job.'],
    ['SPLIT', 'Needs splitting', 'The job touches too many files for one worker. Split it into one-concern jobs.'],
    ['BYHAND', 'Parked by hand', 'A human or leader parked it on purpose.'],
    ['OTHER', 'OTHER', 'Parked by dispatchd; reason code OTHER.'],
    ['constructor', 'constructor', 'Parked by dispatchd; reason code constructor.'],
  ])('explains %s', (code, title, detail) => {
    expect(explainReason(code)).toEqual({ title, detail });
  });
  it('explains known precheck codes and preserves unknown reasons', () => {
    const explanation = 'Already done: every named file and test exists on master. Precheck dropped it before launch.';
    expect(explainSkip('13', 'ignored')).toBe(explanation);
    expect(explainSkip('files_and_tests_exist', 'ignored')).toBe(explanation);
    expect(explainSkip('other', 'A specific reason')).toBe('A specific reason');
  });
  it('formats tiles and sorts a copy of lanes by parked count', () => {
    expect(queueTiles(fixture)).toEqual([['Ready', 2], ['Parked', 3], ['Dropped by precheck 24h', '—'], ['Malformed lines', 1]]);
    expect(laneRows(fixture).map((lane) => lane.lane)).toEqual(['two', 'one']);
    expect(fixture.byLane[0].lane).toBe('one');
  });
  it('guards the full wire shape including nested values and source states', () => {
    expect(isFleetQueue(fixture)).toBe(true);
    expect(isFleetQueue({ ...fixture, v: 2 })).toBe(false);
    expect(isFleetQueue({ ...fixture, sources: { ready: 'unknown', skips: 'healthy' } })).toBe(false);
    expect(isFleetQueue({ ...fixture, groups: [{ reason: 'INVALID', lane: null, count: 1, jobs: [7] }] })).toBe(false);
    expect(isFleetQueue({ ...fixture, skipsLast24h: NaN })).toBe(false);
  });
});
