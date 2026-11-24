import { describe, expect, it } from 'vitest';

import {
  RECORDED_GREEDY_PROVENANCE,
  recordedGreedyAssignment,
  type RecordedGreedyInput,
  type RecordedGreedyPair,
  type RecordedGreedyPool,
} from '../src/core/providers/coding-cli/recorded-greedy-assignment.js';

// Plainly fake identifiers only. Expected values are hand-computed from the
// source greedy rules rather than produced by a copied oracle.
const pool = (id: string, patch: Partial<RecordedGreedyPool> = {}): RecordedGreedyPool => ({
  id,
  concurrency: 10,
  inFlight: 0,
  quota: { known: false },
  ...patch,
});

const pair = (poolId: string, patch: Partial<RecordedGreedyPair> = {}): RecordedGreedyPair => ({
  poolId,
  consumer: null,
  coefficient: 1,
  demand: 0,
  ...patch,
});

const input = (patch: Partial<RecordedGreedyInput>): RecordedGreedyInput => ({
  rankedPoolIds: ['fake-pool-a'],
  pools: [pool('fake-pool-a')],
  jobs: [],
  ...patch,
});

const admittedIds = (out: ReturnType<typeof recordedGreedyAssignment>): string[] =>
  out.assignments.map((a) => `${a.jobId}@${a.poolId}`);

describe('recordedGreedyAssignment provenance', () => {
  it('pins the fixed source PR and SHA on every result', () => {
    expect(RECORDED_GREEDY_PROVENANCE).toEqual({
      sourcePr: 5952,
      sourceSha: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
      basis: 'historical-offline',
    });
    expect(recordedGreedyAssignment(input({})).provenance).toBe(RECORDED_GREEDY_PROVENANCE);
  });
});

describe('recordedGreedyAssignment concurrency', () => {
  it('lets two jobs compete for one slot: the earlier job wins, the later is deferred', () => {
    const out = recordedGreedyAssignment(input({
      pools: [pool('fake-pool-a', { concurrency: 1 })],
      jobs: [
        { id: 'fake-job-1', pairs: [pair('fake-pool-a')] },
        { id: 'fake-job-2', pairs: [pair('fake-pool-a')] },
      ],
    }));
    expect(admittedIds(out)).toEqual(['fake-job-1@fake-pool-a']);
    expect(out.unassignedJobIds).toEqual(['fake-job-2']);
    expect(out.deferrals).toEqual([
      { jobId: 'fake-job-2', poolId: 'fake-pool-a', consumer: null, reason: 'concurrency', constraintId: null },
    ]);
  });

  it('counts in-flight admissions against concurrency before any new one', () => {
    const out = recordedGreedyAssignment(input({
      pools: [pool('fake-pool-a', { concurrency: 2, inFlight: 1 })],
      jobs: [
        { id: 'fake-job-1', pairs: [pair('fake-pool-a')] },
        { id: 'fake-job-2', pairs: [pair('fake-pool-a')] },
      ],
    }));
    expect(admittedIds(out)).toEqual(['fake-job-1@fake-pool-a']);
    expect(out.unassignedJobIds).toEqual(['fake-job-2']);
    expect(out.poolUsage).toEqual([{ poolId: 'fake-pool-a', admitted: 1, demand: 0 }]);
  });

  it('defers everything when in-flight already fills concurrency', () => {
    const out = recordedGreedyAssignment(input({
      pools: [pool('fake-pool-a', { concurrency: 1, inFlight: 1 })],
      jobs: [{ id: 'fake-job-1', pairs: [pair('fake-pool-a')] }],
    }));
    expect(out.assignments).toEqual([]);
    expect(out.unassignedJobIds).toEqual(['fake-job-1']);
  });
});

describe('recordedGreedyAssignment quota', () => {
  it('accumulates demand and defers the job that exceeds known room', () => {
    const out = recordedGreedyAssignment(input({
      pools: [pool('fake-pool-a', { quota: { known: true, room: 1 } })],
      jobs: [
        { id: 'fake-job-1', pairs: [pair('fake-pool-a', { demand: 0.6 })] },
        { id: 'fake-job-2', pairs: [pair('fake-pool-a', { demand: 0.6 })] },
        { id: 'fake-job-3', pairs: [pair('fake-pool-a', { demand: 0.4 })] },
      ],
    }));
    // 0.6 admitted; 0.6 + 0.6 = 1.2 > 1 deferred; 0.6 + 0.4 = 1.0 admitted.
    expect(admittedIds(out)).toEqual(['fake-job-1@fake-pool-a', 'fake-job-3@fake-pool-a']);
    expect(out.deferrals).toEqual([
      { jobId: 'fake-job-2', poolId: 'fake-pool-a', consumer: null, reason: 'quota', constraintId: null },
    ]);
    expect(out.poolUsage).toEqual([{ poolId: 'fake-pool-a', admitted: 2, demand: 1 }]);
  });

  it('allows cumulative demand that lands within the 1e-9 tolerance', () => {
    const out = recordedGreedyAssignment(input({
      pools: [pool('fake-pool-a', { quota: { known: true, room: 1 } })],
      jobs: [
        { id: 'fake-job-1', pairs: [pair('fake-pool-a', { demand: 0.6 })] },
        { id: 'fake-job-2', pairs: [pair('fake-pool-a', { demand: 0.4 + 5e-10 })] },
      ],
    }));
    expect(out.unassignedJobIds).toEqual([]);
  });

  it('defers demand that exceeds the tolerance', () => {
    const out = recordedGreedyAssignment(input({
      pools: [pool('fake-pool-a', { quota: { known: true, room: 1 } })],
      jobs: [
        { id: 'fake-job-1', pairs: [pair('fake-pool-a', { demand: 0.6 })] },
        { id: 'fake-job-2', pairs: [pair('fake-pool-a', { demand: 0.4 + 1e-6 })] },
      ],
    }));
    expect(out.unassignedJobIds).toEqual(['fake-job-2']);
    expect(out.deferrals[0]?.reason).toBe('quota');
  });

  it('treats zero known room as a real bound: positive demand defers, zero demand admits', () => {
    const out = recordedGreedyAssignment(input({
      pools: [pool('fake-pool-a', { quota: { known: true, room: 0 } })],
      jobs: [
        { id: 'fake-job-1', pairs: [pair('fake-pool-a', { demand: 0.1 })] },
        { id: 'fake-job-2', pairs: [pair('fake-pool-a', { demand: 0 })] },
      ],
    }));
    expect(admittedIds(out)).toEqual(['fake-job-2@fake-pool-a']);
    expect(out.deferrals.map((d) => d.reason)).toEqual(['quota']);
  });

  it('never treats unknown quota as zero or as a bound, and records it', () => {
    const out = recordedGreedyAssignment(input({
      pools: [pool('fake-pool-a', { quota: { known: false } })],
      jobs: [
        { id: 'fake-job-1', pairs: [pair('fake-pool-a', { demand: 1000 })] },
        { id: 'fake-job-2', pairs: [pair('fake-pool-a', { demand: 1000 })] },
      ],
    }));
    expect(out.assignments.map((a) => a.quota)).toEqual(['unknown', 'unknown']);
    expect(out.unassignedJobIds).toEqual([]);
    expect(out.poolUsage[0]?.demand).toBe(2000);
  });
});

describe('recordedGreedyAssignment ordering', () => {
  it('takes first-fit pool order over higher coefficient on a later-ranked pool', () => {
    const out = recordedGreedyAssignment(input({
      rankedPoolIds: ['fake-pool-a', 'fake-pool-b'],
      pools: [pool('fake-pool-a'), pool('fake-pool-b')],
      jobs: [{
        id: 'fake-job-1',
        pairs: [pair('fake-pool-b', { coefficient: 0.9 }), pair('fake-pool-a', { coefficient: 0.2 })],
      }],
    }));
    expect(out.assignments[0]).toMatchObject({ poolId: 'fake-pool-a', coefficient: 0.2 });
  });

  it('takes the first recorded pair within a pool even when a later pair has a higher coefficient', () => {
    const out = recordedGreedyAssignment(input({
      jobs: [{
        id: 'fake-job-1',
        pairs: [pair('fake-pool-a', { coefficient: 0.2 }), pair('fake-pool-a', { coefficient: 0.9, consumer: 'fake-consumer' })],
      }],
    }));
    expect(out.assignments[0]).toMatchObject({ coefficient: 0.2, consumer: null });
  });

  it('falls through to the next pool when the first ranked pool is at capacity', () => {
    const out = recordedGreedyAssignment(input({
      rankedPoolIds: ['fake-pool-a', 'fake-pool-b'],
      pools: [pool('fake-pool-a', { concurrency: 1 }), pool('fake-pool-b')],
      jobs: [
        { id: 'fake-job-1', pairs: [pair('fake-pool-a')] },
        { id: 'fake-job-2', pairs: [pair('fake-pool-a'), pair('fake-pool-b')] },
      ],
    }));
    expect(admittedIds(out)).toEqual(['fake-job-1@fake-pool-a', 'fake-job-2@fake-pool-b']);
    expect(out.deferrals).toEqual([
      { jobId: 'fake-job-2', poolId: 'fake-pool-a', consumer: null, reason: 'concurrency', constraintId: null },
    ]);
  });
});

describe('recordedGreedyAssignment shared constraints', () => {
  it('caps cumulative demand for a consumer across pools', () => {
    const jobs = ['fake-job-1', 'fake-job-2', 'fake-job-3'].map((id) => ({
      id,
      pairs: [pair('fake-pool-a', { consumer: 'fake-cloud', demand: 0.4 })],
    }));
    const out = recordedGreedyAssignment(input({
      jobs,
      sharedConstraints: [{ id: 'fake-cloud-cap', consumer: 'fake-cloud', limit: 1 }],
    }));
    // 0.4 + 0.4 = 0.8 admitted; 0.8 + 0.4 = 1.2 > 1 deferred.
    expect(out.unassignedJobIds).toEqual(['fake-job-3']);
    expect(out.deferrals[0]).toEqual({
      jobId: 'fake-job-3', poolId: 'fake-pool-a', consumer: 'fake-cloud', reason: 'shared-constraint', constraintId: 'fake-cloud-cap',
    });
  });

  it('caps every consumer on one pool while leaving other pools unconstrained', () => {
    const out = recordedGreedyAssignment(input({
      rankedPoolIds: ['fake-pool-a', 'fake-pool-b'],
      pools: [pool('fake-pool-a'), pool('fake-pool-b')],
      jobs: [
        { id: 'fake-job-1', pairs: [pair('fake-pool-a', { demand: 0.5 })] },
        { id: 'fake-job-2', pairs: [pair('fake-pool-a', { demand: 0.5 }), pair('fake-pool-b', { demand: 5 })] },
      ],
      sharedConstraints: [{ id: 'fake-pool-a-cap', poolId: 'fake-pool-a', limit: 0.5 }],
    }));
    expect(admittedIds(out)).toEqual(['fake-job-1@fake-pool-a', 'fake-job-2@fake-pool-b']);
    expect(out.deferrals[0]?.constraintId).toBe('fake-pool-a-cap');
  });

  it('applies every matching constraint, reporting the first binding one', () => {
    const out = recordedGreedyAssignment(input({
      pools: [pool('fake-pool-a')],
      jobs: [{ id: 'fake-job-1', pairs: [pair('fake-pool-a', { consumer: 'fake-cloud', demand: 2 })] }],
      sharedConstraints: [
        { id: 'fake-loose', poolId: 'fake-pool-a', limit: 10 },
        { id: 'fake-tight', consumer: 'fake-cloud', limit: 1 },
      ],
    }));
    expect(out.assignments).toEqual([]);
    expect(out.deferrals[0]?.constraintId).toBe('fake-tight');
  });
});

describe('recordedGreedyAssignment validation and empty inputs', () => {
  it('returns an empty result for empty jobs', () => {
    expect(recordedGreedyAssignment(input({ jobs: [] }))).toMatchObject({
      assignments: [],
      unassignedJobIds: [],
      deferrals: [],
      poolUsage: [{ poolId: 'fake-pool-a', admitted: 0, demand: 0 }],
    });
  });

  it('leaves a job with no candidates unassigned without a deferral', () => {
    const out = recordedGreedyAssignment(input({ jobs: [{ id: 'fake-job-1', pairs: [] }] }));
    expect(out.unassignedJobIds).toEqual(['fake-job-1']);
    expect(out.deferrals).toEqual([]);
  });

  it('accepts empty pools when no job references one', () => {
    const out = recordedGreedyAssignment({ rankedPoolIds: [], pools: [], jobs: [{ id: 'fake-job-1', pairs: [] }] });
    expect(out.unassignedJobIds).toEqual(['fake-job-1']);
    expect(out.poolUsage).toEqual([]);
  });

  it('is deterministic and does not mutate its input', () => {
    const value = input({
      pools: [pool('fake-pool-a', { concurrency: 1, quota: { known: true, room: 1 } })],
      jobs: [
        { id: 'fake-job-1', pairs: [pair('fake-pool-a', { demand: 0.5 })] },
        { id: 'fake-job-2', pairs: [pair('fake-pool-a', { demand: 0.5 })] },
      ],
    });
    const snapshot = JSON.stringify(value);
    expect(recordedGreedyAssignment(value)).toEqual(recordedGreedyAssignment(value));
    expect(JSON.stringify(value)).toBe(snapshot);
  });

  it.each([
    ['zero coefficient', { coefficient: 0 }],
    ['negative coefficient', { coefficient: -0.5 }],
  ])('rejects %s', (_label, patch) => {
    expect(() => recordedGreedyAssignment(input({
      jobs: [{ id: 'fake-job-1', pairs: [pair('fake-pool-a', patch)] }],
    }))).toThrow(/coefficient must be positive/);
  });

  it.each([
    ['NaN demand', { demand: Number.NaN }, /must be finite/],
    ['infinite demand', { demand: Number.POSITIVE_INFINITY }, /must be finite/],
    ['negative demand', { demand: -1 }, /must be non-negative/],
    ['non-number coefficient', { coefficient: '1' as unknown as number }, /must be a number/],
    ['NaN coefficient', { coefficient: Number.NaN }, /must be finite/],
    ['unknown consumer type', { consumer: 7 as unknown as string }, /consumer must be a string or null/],
  ])('rejects malformed pair input: %s', (_label, patch, message) => {
    expect(() => recordedGreedyAssignment(input({
      jobs: [{ id: 'fake-job-1', pairs: [pair('fake-pool-a', patch)] }],
    }))).toThrow(message);
  });

  it.each([
    ['NaN room', { quota: { known: true as const, room: Number.NaN } }, /must be finite/],
    ['negative room', { quota: { known: true as const, room: -1 } }, /must be non-negative/],
    ['fractional concurrency', { concurrency: 1.5 }, /non-negative integer/],
    ['negative in-flight', { inFlight: -1 }, /non-negative integer/],
    ['infinite concurrency', { concurrency: Number.POSITIVE_INFINITY }, /must be finite/],
  ])('rejects malformed pool input: %s', (_label, patch, message) => {
    expect(() => recordedGreedyAssignment(input({ pools: [pool('fake-pool-a', patch)] }))).toThrow(message);
  });

  it('rejects duplicate identities explicitly', () => {
    expect(() => recordedGreedyAssignment(input({ pools: [pool('fake-pool-a'), pool('fake-pool-a')] })))
      .toThrow(/duplicate pool id/);
    expect(() => recordedGreedyAssignment(input({ rankedPoolIds: ['fake-pool-a', 'fake-pool-a'] })))
      .toThrow(/duplicate ranked pool id/);
    expect(() => recordedGreedyAssignment(input({
      jobs: [{ id: 'fake-job-1', pairs: [] }, { id: 'fake-job-1', pairs: [] }],
    }))).toThrow(/duplicate job id/);
    expect(() => recordedGreedyAssignment(input({
      jobs: [{ id: 'fake-job-1', pairs: [pair('fake-pool-a'), pair('fake-pool-a')] }],
    }))).toThrow(/duplicate pair/);
    expect(() => recordedGreedyAssignment(input({
      sharedConstraints: [{ id: 'fake-cap', poolId: 'fake-pool-a', limit: 1 }, { id: 'fake-cap', poolId: 'fake-pool-a', limit: 1 }],
    }))).toThrow(/duplicate shared constraint id/);
  });

  it('rejects references to unknown pools and ranking mismatches', () => {
    expect(() => recordedGreedyAssignment(input({
      jobs: [{ id: 'fake-job-1', pairs: [pair('fake-pool-missing')] }],
    }))).toThrow(/unknown pool fake-pool-missing/);
    expect(() => recordedGreedyAssignment(input({ rankedPoolIds: ['fake-pool-z'] })))
      .toThrow(/has no pool state/);
    expect(() => recordedGreedyAssignment(input({ rankedPoolIds: [] })))
      .toThrow(/rank every pool exactly once/);
    expect(() => recordedGreedyAssignment(input({
      sharedConstraints: [{ id: 'fake-cap', poolId: 'fake-pool-missing', limit: 1 }],
    }))).toThrow(/unknown pool/);
  });

  it('rejects shared constraints without a selector or with an invalid limit', () => {
    expect(() => recordedGreedyAssignment(input({
      sharedConstraints: [{ id: 'fake-cap', limit: 1 }],
    }))).toThrow(/needs poolId or consumer/);
    expect(() => recordedGreedyAssignment(input({
      sharedConstraints: [{ id: 'fake-cap', poolId: 'fake-pool-a', limit: Number.NaN }],
    }))).toThrow(/must be finite/);
  });
});
