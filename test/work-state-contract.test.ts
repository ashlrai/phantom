import { describe, expect, it } from 'vitest';
import {
  classifyWorkState,
  formatWorkStateLine,
  type WorkEvidence,
} from '../src/core/comms/work-state-contract.js';

const now = new Date('2026-11-12T22:30:00.000Z');
const base: WorkEvidence = { receivedAt: '2026-11-12T22:00:00.000Z', source: 'slack' };
const assigned: WorkEvidence = { ...base, owner: 'owner-test', claimReceipt: 'claim-0001' };
const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();

describe('classifyWorkState', () => {
  it('RECEIVED with no owner or claim', () => {
    const v = classifyWorkState(base, now);
    expect(v.state).toBe('RECEIVED');
    expect(v.asOf).toBe(now.toISOString());
    expect(v.source).toBe('slack');
  });

  it('ASSIGNED with owner and claim but no live evidence', () => {
    const v = classifyWorkState(assigned, now);
    expect(v.state).toBe('ASSIGNED');
    expect(v.stale).toBe(false);
  });

  it('RUNNING with fresh live evidence', () => {
    expect(classifyWorkState({ ...assigned, liveEvidenceAt: minsAgo(5) }, now).state).toBe('RUNNING');
  });

  it('BLOCKED with a blocker', () => {
    const v = classifyWorkState({ ...assigned, blocker: 'waiting on dep-test' }, now);
    expect(v.state).toBe('BLOCKED');
    expect(v.reasons.join(' ')).toContain('waiting on dep-test');
  });

  it('VERIFIED with pr, head and passed tests', () => {
    const v = classifyWorkState({ ...assigned, artifact: { pr: 1, head: 'abc1234', testsPassed: true } }, now);
    expect(v.state).toBe('VERIFIED');
  });

  it('owner without receipt stays RECEIVED', () => {
    const v = classifyWorkState({ ...base, owner: 'owner-test', liveEvidenceAt: minsAgo(1) }, now);
    expect(v.state).toBe('RECEIVED');
    expect(v.reasons).toContain('owner named, no durable claim');
  });

  it('receipt without owner stays RECEIVED', () => {
    expect(classifyWorkState({ ...base, claimReceipt: 'claim-0001' }, now).state).toBe('RECEIVED');
  });

  it('stale live evidence downgrades to ASSIGNED and names the age', () => {
    const v = classifyWorkState({ ...assigned, liveEvidenceAt: minsAgo(45) }, now);
    expect(v.state).toBe('ASSIGNED');
    expect(v.stale).toBe(true);
    expect(v.reasons.join(' ')).toContain('45m');
  });

  it('respects a custom liveStaleMs', () => {
    const e = { ...assigned, liveEvidenceAt: minsAgo(10) };
    expect(classifyWorkState(e, now, { liveStaleMs: 5 * 60_000 }).state).toBe('ASSIGNED');
    expect(classifyWorkState(e, now, { liveStaleMs: 15 * 60_000 }).state).toBe('RUNNING');
  });

  it('ignores future or invalid live evidence', () => {
    expect(classifyWorkState({ ...assigned, liveEvidenceAt: minsAgo(-5) }, now).state).toBe('ASSIGNED');
    expect(classifyWorkState({ ...assigned, liveEvidenceAt: 'nope' }, now).state).toBe('ASSIGNED');
  });

  it('blocker beats RUNNING', () => {
    const v = classifyWorkState({ ...assigned, liveEvidenceAt: minsAgo(1), blocker: 'needs key' }, now);
    expect(v.state).toBe('BLOCKED');
  });

  it('whitespace-only blocker does not block', () => {
    expect(classifyWorkState({ ...assigned, blocker: '   ' }, now).state).toBe('ASSIGNED');
  });

  it('VERIFIED outranks a blocker', () => {
    const v = classifyWorkState(
      { ...assigned, blocker: 'old', artifact: { pr: 2, head: 'def5678', testsPassed: true } },
      now,
    );
    expect(v.state).toBe('VERIFIED');
  });

  it('PR without testsPassed is not VERIFIED', () => {
    const v = classifyWorkState({ ...assigned, artifact: { pr: 3, head: 'abc1234' } }, now);
    expect(v.state).toBe('ASSIGNED');
    expect(v.reasons.join(' ')).toContain('tests not passed');
    const f = classifyWorkState({ ...assigned, artifact: { pr: 3, head: 'abc1234', testsPassed: false } }, now);
    expect(f.state).toBe('ASSIGNED');
  });

  it('PR without head is not VERIFIED', () => {
    const v = classifyWorkState({ ...assigned, artifact: { pr: 3, testsPassed: true } }, now);
    expect(v.state).toBe('ASSIGNED');
    expect(v.reasons.join(' ')).toContain('no head');
  });

  it('passed tests without a PR is not VERIFIED', () => {
    expect(classifyWorkState({ ...base, artifact: { head: 'abc1234', testsPassed: true } }, now).state).toBe('RECEIVED');
  });

  it('throws TypeError on invalid or missing receivedAt', () => {
    expect(() => classifyWorkState({ ...base, receivedAt: 'not-a-date' }, now)).toThrow(TypeError);
    expect(() => classifyWorkState({ ...base, receivedAt: '' }, now)).toThrow(TypeError);
    expect(() => classifyWorkState({ source: 'slack' } as WorkEvidence, now)).toThrow(TypeError);
  });
});

describe('formatWorkStateLine', () => {
  it('includes state, asOf and source', () => {
    const line = formatWorkStateLine(classifyWorkState(assigned, now));
    expect(line).toContain('ASSIGNED');
    expect(line).toContain(now.toISOString());
    expect(line).toContain('(slack)');
    expect(line).toContain('owner-test');
    expect(line).toContain('claim-0001');
  });

  it('marks stale verdicts', () => {
    const line = formatWorkStateLine(classifyWorkState({ ...assigned, liveEvidenceAt: minsAgo(90) }, now));
    expect(line).toContain('[STALE]');
  });
});
