import { describe, expect, it } from 'vitest';
import { classifyWorkState, formatWorkStateLine, type WorkEvidence } from '../src/core/comms/work-state-contract.js';

const now = new Date('2026-11-24T12:00:00.000Z');
const request: WorkEvidence = {
  receivedAt: '2026-11-24T11:55:00.000Z',
  source: 'slack',
  owner: 'worker',
  claimReceipt: 'receipt-1',
};

describe('live work evidence chronology', () => {
  it('leaves a recent heartbeat from before the request assigned with a diagnostic', () => {
    const verdict = classifyWorkState({ ...request, liveEvidenceAt: '2026-11-24T11:54:59.999Z' }, now);
    expect(verdict.state).toBe('ASSIGNED');
    expect(verdict.stale).toBe(false);
    expect(formatWorkStateLine(verdict)).toContain('live evidence predates request, ignored');
  });

  it.each(['2026-11-24T11:55:00.000Z', '2026-11-24T11:55:00.001Z'])(
    'accepts current evidence at or after the request: %s', (liveEvidenceAt) => {
      const verdict = classifyWorkState({ ...request, liveEvidenceAt }, now);
      expect(verdict.state).toBe('RUNNING');
      expect(formatWorkStateLine(verdict)).toContain('live evidence current');
    },
  );

  it.each([
    ['2026-11-24T12:00:00.001Z', 'liveEvidenceAt is in the future, ignored'],
    ['invalid', 'liveEvidenceAt invalid, ignored'],
  ])('rejects future or invalid evidence: %s', (liveEvidenceAt, reason) => {
    const verdict = classifyWorkState({ ...request, liveEvidenceAt }, now);
    expect(verdict.state).toBe('ASSIGNED');
    expect(verdict.stale).toBe(false);
    expect(formatWorkStateLine(verdict)).toContain(reason);
  });

  it('retains stale handling for old evidence within the request chronology', () => {
    const verdict = classifyWorkState({ ...request, receivedAt: '2026-11-24T11:00:00Z', liveEvidenceAt: '2026-11-24T11:20:00Z' }, now);
    expect(verdict.state).toBe('ASSIGNED');
    expect(verdict.stale).toBe(true);
    expect(formatWorkStateLine(verdict)).toContain('[STALE]');
  });

  it('keeps BLOCKED and VERIFIED precedence over pre-request evidence', () => {
    const evidence = { ...request, liveEvidenceAt: '2026-11-24T11:54:59.999Z', blocker: 'dependency' };
    expect(formatWorkStateLine(classifyWorkState(evidence, now))).toContain('BLOCKED as of');
    expect(formatWorkStateLine(classifyWorkState({ ...evidence, artifact: { pr: 1, head: 'abc', testsPassed: true } }, now))).toContain('VERIFIED as of');
  });
});
