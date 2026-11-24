import { describe, expect, it } from 'vitest';
import { classifyWorkState, type WorkEvidence } from '../src/core/comms/work-state-contract.js';
import { decideWorkStatePublish } from '../src/core/comms/work-state-publish.js';

const now = new Date('2026-11-24T12:00:00Z');
const base: WorkEvidence = {
  receivedAt: '2026-11-24T11:00:00Z', source: 'test', owner: 'fake-owner-a', claimReceipt: 'fake-claim-a',
};
const verdict = (changes: Partial<WorkEvidence> = {}) => classifyWorkState({ ...base, ...changes }, now);

describe('assignment publication', () => {
  for (const liveEvidenceAt of [undefined, '2026-11-24T11:59:00Z']) {
    const state = liveEvidenceAt ? 'RUNNING' : 'ASSIGNED';
    for (const changes of [
      { owner: 'fake-owner-b' }, { claimReceipt: 'fake-claim-b' },
      { owner: 'fake-owner-b', claimReceipt: 'fake-claim-b' },
    ]) {
      it(`publishes ${state} reassignment ${JSON.stringify(changes)}`, () => {
        const previous = verdict({ liveEvidenceAt });
        const next = verdict({ liveEvidenceAt, ...changes });
        const copies = structuredClone([previous, next]);
        expect(previous.state).toBe(state);
        expect(next.state).toBe(state);
        expect(decideWorkStatePublish(previous, next)).toEqual({ publish: true, reason: 'assignment changed' });
        expect([previous, next]).toEqual(copies);
      });
    }
  }

  it('normalizes whitespace and ignores heartbeat, reason order and unrelated diagnostics', () => {
    const previous = verdict({ liveEvidenceAt: '2026-11-24T11:58:00Z', artifact: { pr: 1 } });
    const next = verdict({ owner: '  fake-owner-a ', claimReceipt: ' fake-claim-a  ', liveEvidenceAt: '2026-11-24T11:59:00Z', artifact: { pr: 2 } });
    next.reasons.reverse();
    next.reasons.push('unrelated diagnostic changed');
    const copies = structuredClone([previous, next]);
    expect(decideWorkStatePublish(previous, next)).toEqual({ publish: false, reason: 'no meaningful change (RUNNING)' });
    expect([previous, next]).toEqual(copies);
  });

  it('does not infer reassignment when either assignment is missing or ambiguous', () => {
    const original = verdict();
    const changed = verdict({ owner: 'fake-owner-b' });
    const missing = { ...original, reasons: ['owner named, no durable claim'] };
    const ambiguous = { ...original, reasons: [...original.reasons, 'owner fake-owner-c, claim fake-claim-c'] };
    for (const [a, b] of [[missing, changed], [changed, missing], [ambiguous, changed]]) {
      expect(decideWorkStatePublish(a, b)).toEqual({ publish: false, reason: 'no meaningful change (ASSIGNED)' });
    }
  });

  it('retains blocker, artifact and staleness precedence', () => {
    expect(decideWorkStatePublish(verdict({ blocker: 'first' }), verdict({ blocker: 'second', owner: 'fake-owner-b' })).reason).toBe('blocker changed');
    expect(decideWorkStatePublish(verdict({ artifact: { pr: 1, head: 'fake-head-a', testsPassed: true } }), verdict({ artifact: { pr: 2, head: 'fake-head-b', testsPassed: true } })).reason).toBe('artifact changed');
    expect(decideWorkStatePublish(verdict(), verdict({ owner: 'fake-owner-b', liveEvidenceAt: '2026-11-24T10:00:00Z' })).reason).toBe('live evidence went stale');
  });
});
