import { describe, expect, it } from 'vitest';
import { classifyWorkItem, RUNNING_FRESH_MS, type WorkItemEvidence } from '../src/core/comms/work-item-state.js';

const now = '2026-11-17T12:00:00.000Z';
const evidenceAt = (offset: number): WorkItemEvidence => ({
  id: 'recut-c536-fixture',
  receivedAt: '2026-11-17T11:00:00.000Z',
  owner: 'fixture-worker',
  claimReceipt: 'fixture-receipt',
  runningEvidence: {
    source: 'fixture-worker-observation',
    at: new Date(Date.parse(now) + offset).toISOString(),
  },
});

describe('C536 recut work-state qualification', () => {
  it.each([
    [-RUNNING_FRESH_MS, 'RUNNING'],
    [-RUNNING_FRESH_MS - 1, 'ASSIGNED'],
    [5 * 60 * 1000, 'RUNNING'],
    [5 * 60 * 1000 + 1, 'ASSIGNED'],
  ] as const)('qualifies evidence offset %i as %s without changing it', (offset, state) => {
    const evidence = evidenceAt(offset);
    const before = structuredClone(evidence);
    Object.freeze(evidence.runningEvidence);
    Object.freeze(evidence);

    const result = classifyWorkItem(evidence, now);

    expect(result.state).toBe(state);
    expect(result.missing).toEqual(state === 'RUNNING' ? [] : ['fresh running evidence']);
    expect(result.asOf).toBe(state === 'RUNNING' ? evidence.runningEvidence?.at : evidence.receivedAt);
    expect(result.source).toBe(state === 'RUNNING' ? 'fixture-worker-observation' : 'claim:fixture-receipt');
    expect(evidence).toEqual(before);
  });

  it.each(['owner', 'claimReceipt'] as const)('requires a nonblank %s even with fresh running evidence', (field) => {
    const result = classifyWorkItem({ ...evidenceAt(0), [field]: '   ' }, now);
    expect(result.state).toBe('RECEIVED');
    expect(result.missing).toEqual([field === 'owner' ? 'named owner' : 'durable claim receipt']);
    expect(result.source).toBe('receivedAt');
  });
});
