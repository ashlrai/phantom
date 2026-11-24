import { describe, expect, it } from 'vitest';
import { classifyWorkItem, type WorkItemEvidence } from '../src/core/comms/work-item-state.js';

const now = '2026-11-12T22:29:00.000Z';
const boundary = '2026-11-12T22:34:00.000Z';
const beyond = '2026-11-12T22:34:00.001Z';
const tomorrow = '2026-11-13T22:29:00.000Z';
const historical = '2020-01-01T00:00:00.000Z';
const base: WorkItemEvidence = { id: 'fixture', receivedAt: historical, owner: 'worker', claimReceipt: 'claim' };
const blocker = (at: string) => ({ dependency: 'fixture dependency', source: 'blocker ledger', at });
const verified = (at: string) => ({ tests: 'passed', source: 'test receipt', at });
const result = (state: string, asOf: string, source: string) => ({ state, asOf, source, missing: [] });

describe('work item evidence at the observation time', () => {
  it('falls from tomorrow verification to a valid blocker', () => {
    expect(classifyWorkItem({ ...base, verified: verified(tomorrow), blocker: blocker(now) }, now))
      .toEqual(result('BLOCKED', now, 'blocker ledger'));
  });

  it('falls from tomorrow blocker to valid running evidence', () => {
    expect(classifyWorkItem({ ...base, blocker: blocker(tomorrow), runningEvidence: { source: 'heartbeat', at: now } }, now))
      .toEqual(result('RUNNING', now, 'heartbeat'));
  });

  it('accepts the skew boundary and rejects one millisecond beyond it', () => {
    expect(classifyWorkItem({ ...base, verified: verified(boundary) }, now)).toEqual(result('VERIFIED', boundary, 'test receipt'));
    expect(classifyWorkItem({ ...base, blocker: blocker(boundary) }, now)).toEqual(result('BLOCKED', boundary, 'blocker ledger'));
    expect(classifyWorkItem({ ...base, verified: verified(beyond), blocker: blocker(now) }, now))
      .toEqual(result('BLOCKED', now, 'blocker ledger'));
    expect(classifyWorkItem({ ...base, blocker: blocker(beyond) }, now)).toEqual(result('ASSIGNED', historical, 'claim:claim'));
  });

  it('retains historical verification and blocker evidence without a TTL', () => {
    expect(classifyWorkItem({ ...base, verified: verified(historical), blocker: blocker(now) }, now))
      .toEqual(result('VERIFIED', historical, 'test receipt'));
    expect(classifyWorkItem({ ...base, blocker: blocker(historical) }, now)).toEqual(result('BLOCKED', historical, 'blocker ledger'));
  });

  it('falls back to assignment or receipt when the observation time is invalid', () => {
    const evidence = { ...base, verified: verified(now), blocker: blocker(now), runningEvidence: { source: 'heartbeat', at: now } };
    expect(classifyWorkItem(evidence, 'invalid')).toEqual(result('ASSIGNED', historical, 'claim:claim'));
    expect(classifyWorkItem({ ...evidence, owner: undefined, claimReceipt: undefined }, 'invalid'))
      .toEqual({ state: 'RECEIVED', asOf: historical, source: 'receivedAt', missing: ['named owner', 'durable claim receipt'] });
  });
});
