import { describe, expect, it } from 'vitest';
import { classifyWorkItem, type WorkItemEvidence } from '../src/core/comms/work-item-state.js';

const now = '2026-11-12T22:30:00.000Z';
const base: WorkItemEvidence = {
  id: 'fixture', receivedAt: '2026-11-12T22:00:00.000Z',
  runningEvidence: { source: 'live-worker fixture', at: '2026-11-12T22:29:00.000Z' },
};

describe('operational work state owner qualification', () => {
  it.each([
    ['without owner', { claimReceipt: 'claim-1' }, 'named owner'],
    ['without receipt', { owner: 'worker-1' }, 'durable claim receipt'],
  ])('does not report RUNNING %s', (_label, extra, missing) => {
    const result = classifyWorkItem({ ...base, ...extra }, now);
    expect(result.state).toBe('RECEIVED');
    expect(result.missing).toContain(missing);
  });

  it('reports RUNNING with owner, receipt and fresh evidence', () => {
    expect(classifyWorkItem({ ...base, owner: 'worker-1', claimReceipt: 'claim-1' }, now).state).toBe('RUNNING');
  });

  it('reports ASSIGNED when live evidence is stale', () => {
    const result = classifyWorkItem({ ...base, owner: 'worker-1', claimReceipt: 'claim-1',
      runningEvidence: { source: 'live-worker fixture', at: '2026-11-12T21:59:00.000Z' } }, now);
    expect(result.state).toBe('ASSIGNED');
    expect(result.missing).toContain('fresh running evidence');
  });

  it('preserves BLOCKED precedence over fresh running evidence', () => {
    expect(classifyWorkItem({ ...base, blocker: { dependency: 'fixture dependency', source: 'fixture', at: now } }, now).state).toBe('BLOCKED');
  });

  it('preserves VERIFIED precedence over a blocker and running evidence', () => {
    expect(classifyWorkItem({ ...base, blocker: { dependency: 'fixture dependency', source: 'fixture', at: now },
      verified: { artifact: 'fixture artifact', source: 'fixture', at: now } }, now).state).toBe('VERIFIED');
  });
});
