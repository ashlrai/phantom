import { describe, expect, it } from 'vitest';
import { classifyWorkState, type WorkStateVerdict } from '../src/core/comms/work-state-contract.js';
import { decideWorkStatePublish } from '../src/core/comms/work-state-publish.js';

const NOW = new Date('2026-11-19T12:00:00Z');
const LATER = new Date('2026-11-19T12:00:05Z');
const RECEIVED_AT = '2026-11-19T11:00:00Z';
const LIVE_FRESH = '2026-11-19T11:50:00Z';
const LIVE_STALE = '2026-11-19T10:00:00Z';

function assigned(now: Date = NOW): WorkStateVerdict {
  return classifyWorkState(
    { receivedAt: RECEIVED_AT, source: 'slack', owner: 'owner-test', claimReceipt: 'claim-0001' },
    now,
  );
}

function running(now: Date = NOW): WorkStateVerdict {
  return classifyWorkState(
    {
      receivedAt: RECEIVED_AT,
      source: 'slack',
      owner: 'owner-test',
      claimReceipt: 'claim-0001',
      liveEvidenceAt: LIVE_FRESH,
    },
    now,
  );
}

function assignedStale(now: Date = NOW): WorkStateVerdict {
  return classifyWorkState(
    {
      receivedAt: RECEIVED_AT,
      source: 'slack',
      owner: 'owner-test',
      claimReceipt: 'claim-0001',
      liveEvidenceAt: LIVE_STALE,
    },
    now,
  );
}

function blocked(blocker: string, now: Date = NOW): WorkStateVerdict {
  return classifyWorkState(
    { receivedAt: RECEIVED_AT, source: 'slack', owner: 'owner-test', claimReceipt: 'claim-0001', blocker },
    now,
  );
}

function verified(pr: number, head: string, now: Date = NOW): WorkStateVerdict {
  return classifyWorkState(
    {
      receivedAt: RECEIVED_AT,
      source: 'slack',
      owner: 'owner-test',
      claimReceipt: 'claim-0001',
      artifact: { pr, head, testsPassed: true },
    },
    now,
  );
}

describe('decideWorkStatePublish', () => {
  it('rule 1: publishes the first verdict for any state', () => {
    expect(decideWorkStatePublish(undefined, running())).toEqual({ publish: true, reason: 'first state RUNNING' });
    expect(decideWorkStatePublish(undefined, blocked('db down'))).toEqual({
      publish: true,
      reason: 'first state BLOCKED',
    });
    expect(decideWorkStatePublish(undefined, assigned())).toEqual({ publish: true, reason: 'first state ASSIGNED' });
  });

  it('rule 2: publishes state transitions, including ASSIGNED to RUNNING', () => {
    expect(decideWorkStatePublish(assigned(), running())).toEqual({ publish: true, reason: 'ASSIGNED -> RUNNING' });
  });

  it('rule 2: publishes backwards moves like RUNNING to ASSIGNED', () => {
    expect(decideWorkStatePublish(running(), assigned())).toEqual({ publish: true, reason: 'RUNNING -> ASSIGNED' });
  });

  it('rule 2: publishes every forward transition pair', () => {
    expect(decideWorkStatePublish(running(), blocked('db down')).reason).toBe('RUNNING -> BLOCKED');
    expect(decideWorkStatePublish(blocked('db down'), verified(1, 'head-aaaa')).reason).toBe('BLOCKED -> VERIFIED');
  });

  it('rule 3: publishes when the blocker text changes in the same BLOCKED state', () => {
    expect(decideWorkStatePublish(blocked('db down'), blocked('waiting on review'))).toEqual({
      publish: true,
      reason: 'blocker changed',
    });
  });

  it('rule 3: stays quiet when the blocker text matches after trimming', () => {
    expect(decideWorkStatePublish(blocked('db down'), blocked('  db down  '))).toEqual({
      publish: false,
      reason: 'no meaningful change (BLOCKED)',
    });
  });

  it('rule 4: publishes when the VERIFIED artifact moves to another PR', () => {
    expect(decideWorkStatePublish(verified(1, 'head-aaaa'), verified(2, 'head-aaaa'))).toEqual({
      publish: true,
      reason: 'artifact changed',
    });
  });

  it('rule 4: publishes when the VERIFIED artifact moves to another head', () => {
    expect(decideWorkStatePublish(verified(1, 'head-aaaa'), verified(1, 'head-bbbb'))).toEqual({
      publish: true,
      reason: 'artifact changed',
    });
  });

  it('rule 4: stays quiet when the same VERIFIED verdict repeats', () => {
    expect(decideWorkStatePublish(verified(1, 'head-aaaa'), verified(1, 'head-aaaa'))).toEqual({
      publish: false,
      reason: 'no meaningful change (VERIFIED)',
    });
  });

  it('rule 5: publishes when live evidence goes stale within the same state', () => {
    expect(decideWorkStatePublish(assigned(), assignedStale())).toEqual({
      publish: true,
      reason: 'live evidence went stale',
    });
  });

  it('rule 5: stays quiet when staleness recovers with the same state', () => {
    expect(decideWorkStatePublish(assignedStale(), assigned())).toEqual({
      publish: false,
      reason: 'no meaningful change (ASSIGNED)',
    });
  });

  it('rule 6: stays quiet for identical RUNNING verdicts that differ only in asOf', () => {
    expect(decideWorkStatePublish(running(NOW), running(LATER))).toEqual({
      publish: false,
      reason: 'no meaningful change (RUNNING)',
    });
  });

  it('rule 6: stays quiet when the same verdict repeats verbatim', () => {
    expect(decideWorkStatePublish(assigned(), assigned())).toEqual({
      publish: false,
      reason: 'no meaningful change (ASSIGNED)',
    });
  });

  it('rule 2 outranks rule 5 when a stale verdict also changes state', () => {
    expect(decideWorkStatePublish(running(), assignedStale())).toEqual({ publish: true, reason: 'RUNNING -> ASSIGNED' });
  });

  it('does not mutate its inputs', () => {
    const previous = blocked('db down');
    const next = verified(1, 'head-aaaa');
    const previousClone = structuredClone(previous);
    const nextClone = structuredClone(next);
    decideWorkStatePublish(previous, next);
    expect(previous).toEqual(previousClone);
    expect(next).toEqual(nextClone);
  });

  it('does not mutate its inputs when quiet', () => {
    const previous = running(NOW);
    const next = running(LATER);
    const previousClone = structuredClone(previous);
    const nextClone = structuredClone(next);
    const decision = decideWorkStatePublish(previous, next);
    expect(decision.publish).toBe(false);
    expect(previous).toEqual(previousClone);
    expect(next).toEqual(nextClone);
  });
});
