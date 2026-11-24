import { describe, expect, it } from 'vitest';
import {
  RECORDED_SLOT_PROJECTION_PROVENANCE as P,
  projectRecordedSlots,
  type RecordedSlotCandidate,
} from '../src/core/providers/coding-cli/recorded-slot-projection.js';

const row = (jobId: string, backend: string, accountId?: string | null): RecordedSlotCandidate =>
  accountId === undefined ? { jobId, backend } : { jobId, backend, accountId };

describe('recorded slot projection (PR #5952 planWorker slot accounting)', () => {
  it('reports PR, head, path and a non-dispatch evidence basis', () => {
    expect(P).toMatchObject({
      sourcePr: 5952,
      sourceHead: '3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886',
      sourcePath: 'src/core/providers/coding-cli/worker-plan.ts',
      basis: 'historical-offline',
      dispatchPermission: false,
      liveAvailability: false,
      billingEligibility: false,
    });
    expect(projectRecordedSlots({ candidates: [] })).toEqual({ provenance: P, observations: [], finalCounts: [] });
  });

  it('makes duplicate backend jobs on one account contend for the shared slot, in order', () => {
    const out = projectRecordedSlots({
      candidates: [row('job-1', 'codex', 'acct-a'), row('job-2', 'codex', 'acct-a'), row('job-3', 'codex', 'acct-a')],
      concurrency: { codex: 1 },
      inFlight: { 'acct-a': 0 },
    });
    expect(out.observations).toEqual([
      { index: 0, jobId: 'job-1', backend: 'codex', slotKind: 'account', slot: 'acct-a', cap: 1, countBefore: 0, countAfter: 1, status: 'fits', incremented: true },
      { index: 1, jobId: 'job-2', backend: 'codex', slotKind: 'account', slot: 'acct-a', cap: 1, countBefore: 1, countAfter: 1, status: 'full', incremented: false },
      { index: 2, jobId: 'job-3', backend: 'codex', slotKind: 'account', slot: 'acct-a', cap: 1, countBefore: 1, countAfter: 1, status: 'full', incremented: false },
    ]);
    expect(out.finalCounts).toEqual([{ slot: 'acct-a', count: 1 }]);
  });

  it('keeps distinct accounts on separate slots so both fit', () => {
    const out = projectRecordedSlots({
      candidates: [row('job-1', 'codex', 'acct-a'), row('job-2', 'codex', 'acct-b')],
      concurrency: { codex: 1 },
      inFlight: { 'acct-a': 0, 'acct-b': 0 },
    });
    expect(out.observations.map((o) => [o.slot, o.status])).toEqual([
      ['acct-a', 'fits'],
      ['acct-b', 'fits'],
    ]);
    expect(out.finalCounts).toEqual([
      { slot: 'acct-a', count: 1 },
      { slot: 'acct-b', count: 1 },
    ]);
  });

  it('falls back to the backend slot without a recorded account, never sharing it with accounts', () => {
    const out = projectRecordedSlots({
      candidates: [row('job-1', 'codex'), row('job-2', 'codex', null), row('job-3', 'codex', 'acct-a'), row('job-4', 'codex')],
      concurrency: { codex: 2 },
      inFlight: { codex: 0, 'acct-a': 0 },
    });
    expect(out.observations.map((o) => [o.slotKind, o.slot, o.status])).toEqual([
      ['backend', 'codex', 'fits'],
      ['backend', 'codex', 'fits'],
      ['account', 'acct-a', 'fits'],
      ['backend', 'codex', 'full'],
    ]);
    expect(out.finalCounts).toEqual([
      { slot: 'codex', count: 2 },
      { slot: 'acct-a', count: 1 },
    ]);
  });

  it('does not increment a full row, so a later row on another slot is unaffected', () => {
    const out = projectRecordedSlots({
      candidates: [row('job-1', 'codex', 'acct-a'), row('job-2', 'codex', 'acct-a'), row('job-3', 'codex', 'acct-b')],
      concurrency: { codex: 1 },
      inFlight: { 'acct-a': 1, 'acct-b': 0 },
    });
    expect(out.observations.map((o) => [o.status, o.countBefore, o.countAfter])).toEqual([
      ['full', 1, 1],
      ['full', 1, 1],
      ['fits', 0, 1],
    ]);
    expect(out.finalCounts).toEqual([
      { slot: 'acct-a', count: 1 },
      { slot: 'acct-b', count: 1 },
    ]);
  });

  it('keeps an unknown cap or count unknown and never assumes the source defaults', () => {
    const noCap = projectRecordedSlots({
      candidates: [row('job-1', 'codex', 'acct-a'), row('job-2', 'codex', 'acct-a')],
      concurrency: {},
      inFlight: { 'acct-a': 0 },
    });
    expect(noCap.observations.map((o) => [o.cap, o.countBefore, o.countAfter, o.status])).toEqual([
      [null, 0, null, 'unknown'],
      [null, null, null, 'unknown'],
    ]);
    expect(noCap.finalCounts).toEqual([{ slot: 'acct-a', count: null }]);

    const noCount = projectRecordedSlots({ candidates: [row('job-1', 'codex', 'acct-a')], concurrency: { codex: 2 } });
    expect(noCount.observations[0]).toMatchObject({ cap: 2, countBefore: null, countAfter: null, status: 'unknown', incremented: false });

    const nulls = projectRecordedSlots({ candidates: [row('job-1', 'codex')], concurrency: { codex: null }, inFlight: { codex: null } });
    expect(nulls.observations[0]).toMatchObject({ cap: null, status: 'unknown' });
  });

  it('marks a zero cap full with no increment, even when the count is unknown', () => {
    const known = projectRecordedSlots({
      candidates: [row('job-1', 'codex', 'acct-a'), row('job-2', 'codex', 'acct-a')],
      concurrency: { codex: 0 },
      inFlight: { 'acct-a': 0 },
    });
    expect(known.observations.map((o) => [o.cap, o.countAfter, o.status, o.incremented])).toEqual([
      [0, 0, 'full', false],
      [0, 0, 'full', false],
    ]);
    const unknownCount = projectRecordedSlots({ candidates: [row('job-1', 'codex')], concurrency: { codex: 0 } });
    expect(unknownCount.observations[0]).toMatchObject({ cap: 0, status: 'full', countBefore: null, countAfter: null });
  });

  it('does not let inherited object keys act as caps or counts', () => {
    const out = projectRecordedSlots({ candidates: [row('job-1', 'constructor'), row('job-2', 'toString', 'hasOwnProperty')], concurrency: {} });
    expect(out.observations.map((o) => [o.cap, o.status])).toEqual([
      [null, 'unknown'],
      [null, 'unknown'],
    ]);
  });

  it('rejects malformed counts, caps, identifiers and shapes', () => {
    const bad: Array<[string, () => unknown]> = [
      ['fractional cap', () => projectRecordedSlots({ candidates: [], concurrency: { codex: 1.5 } })],
      ['negative cap', () => projectRecordedSlots({ candidates: [], concurrency: { codex: -1 } })],
      ['NaN cap', () => projectRecordedSlots({ candidates: [], concurrency: { codex: Number.NaN } })],
      ['infinite count', () => projectRecordedSlots({ candidates: [], inFlight: { 'acct-a': Number.POSITIVE_INFINITY } })],
      ['string count', () => projectRecordedSlots({ candidates: [], inFlight: { 'acct-a': '1' as unknown as number } })],
      ['blank jobId', () => projectRecordedSlots({ candidates: [row('   ', 'codex')] })],
      ['blank backend', () => projectRecordedSlots({ candidates: [row('job-1', '')] })],
      ['blank accountId', () => projectRecordedSlots({ candidates: [row('job-1', 'codex', '  ')] })],
      ['blank map key', () => projectRecordedSlots({ candidates: [], concurrency: { '': 1 } })],
      ['non-array candidates', () => projectRecordedSlots({ candidates: {} as never })],
      ['null candidate', () => projectRecordedSlots({ candidates: [null as never] })],
      ['null input', () => projectRecordedSlots(null as never)],
    ];
    for (const [label, call] of bad) expect(call, label).toThrow(/recorded slot projection/);
    expect(() => projectRecordedSlots({ candidates: [], concurrency: { codex: 1.5 } })).toThrow(RangeError);
    expect(() => projectRecordedSlots({ candidates: {} as never })).toThrow(TypeError);
  });

  it('does not echo arbitrary caller values in error messages', () => {
    const leak = 'LEAK-MARKER-FAKE-683';
    expect(() => projectRecordedSlots({ candidates: [row('job-1', 'codex', { leak } as never)] }))
      .toThrow(/candidate 0 accountId/);
    try {
      projectRecordedSlots({ candidates: [row('job-1', 'codex', { leak } as never)] });
    } catch (error) {
      expect((error as Error).message).not.toContain(leak);
    }
  });

  it('leaves every input object unchanged', () => {
    const freeze = <T>(value: T): T => {
      if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
      return value;
    };
    const input = freeze({
      candidates: [row('job-1', 'codex', 'acct-a'), row('job-2', 'codex'), row('job-3', 'codex', 'acct-a')],
      concurrency: { codex: 1 },
      inFlight: { 'acct-a': 0 },
    });
    const before = JSON.stringify(input);
    expect(projectRecordedSlots(input).observations).toHaveLength(3);
    expect(JSON.stringify(input)).toBe(before);
  });
});
