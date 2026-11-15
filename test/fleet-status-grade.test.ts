import { describe, expect, it } from 'vitest';
import { classifyWorkItem } from '../src/core/comms/work-item-state.js';
import { gradeWorkStatus, type WorkStatusEvidence } from '../src/core/fleet/status-grade.js';

const now = '2026-11-15T12:00:00.000Z';
const ago = (min: number): string => new Date(Date.parse(now) - min * 60_000).toISOString();
const g = (e: Partial<WorkStatusEvidence>) => gradeWorkStatus({ now, ...e });

describe('gradeWorkStatus', () => {
  it('VERIFIED needs pr, head and tests === true', () => {
    expect(g({ prNumber: 7, headSha: 'abc123', testsPassed: true, ingressReceiptId: 'i' }).word).toBe('VERIFIED');
    expect(g({ prNumber: 7, headSha: 'abc123', testsPassed: false, ingressReceiptId: 'i' }).word).toBe('RECEIVED');
    expect(g({ prNumber: 7, testsPassed: true }).word).toBe('UNKNOWN');
  });
  it('RUNNING from claim + live process or fresh progress', () => {
    expect(g({ claimId: 'c', processAlive: true }).word).toBe('RUNNING');
    expect(g({ claimId: 'c', lastProgressAt: ago(14) }).word).toBe('RUNNING');
    expect(g({ processAlive: true, lastProgressAt: ago(1) }).word).not.toBe('RUNNING');
  });
  it('stale RUNNING evidence falls back to ASSIGNED / RECEIVED', () => {
    expect(g({ owner: 'o', claimId: 'c', lastProgressAt: ago(16) }).word).toBe('ASSIGNED');
    expect(g({ claimId: 'c', lastProgressAt: ago(16), ingressReceiptId: 'i' }).word).toBe('RECEIVED');
    expect(g({ owner: 'o', claimId: 'c', lastProgressAt: ago(-30) }).word).toBe('ASSIGNED');
  });
  it('ASSIGNED needs owner and claimId; owner alone is not ASSIGNED', () => {
    expect(g({ owner: 'o', claimId: 'c' }).word).toBe('ASSIGNED');
    const noClaim = g({ owner: 'o', ingressReceiptId: 'i' });
    expect(noClaim.word).toBe('RECEIVED');
    expect(g({ owner: 'o' }).word).toBe('UNKNOWN');
    expect(g({ claimId: 'c', ingressReceiptId: 'i' }).word).toBe('RECEIVED');
  });
  it('expired claim downgrades to RECEIVED', () => {
    const r = g({ owner: 'o', claimId: 'c', claimExpiresAt: ago(1), processAlive: true, ingressReceiptId: 'i' });
    expect(r).toMatchObject({ word: 'RECEIVED', reason: 'claim expired' });
    expect(g({ owner: 'o', claimId: 'c', claimExpiresAt: 'garbage' }).reason).toBe('claim expired');
    expect(g({ owner: 'o', claimId: 'c', claimExpiresAt: ago(-5) }).word).toBe('ASSIGNED');
  });
  it('BLOCKED needs a non-empty blockedBy', () => {
    expect(g({ blockedBy: 'lane claude held', claimId: 'c', processAlive: true }).word).toBe('BLOCKED');
    expect(g({ blockedBy: '  ', ingressReceiptId: 'i' }).word).toBe('RECEIVED');
  });
  it('RECEIVED from ingress, else UNKNOWN', () => {
    expect(g({ ingressReceiptId: 'i' }).word).toBe('RECEIVED');
    expect(g({}).word).toBe('UNKNOWN');
  });
  it('asOf and source are always present', () => {
    const cases: Partial<WorkStatusEvidence>[] = [
      {}, { ingressReceiptId: 'i' }, { owner: 'o', claimId: 'c' }, { claimId: 'c', processAlive: true },
      { blockedBy: 'x' }, { prNumber: 1, headSha: 'h', testsPassed: true }, { claimId: 'c', claimExpiresAt: ago(1) },
    ];
    for (const c of cases) {
      const r = g(c);
      expect(r.asOf).toBe(now);
      expect(r.source.length).toBeGreaterThan(0);
      expect(r.reason.length).toBeGreaterThan(0);
    }
    expect(gradeWorkStatus({ now: 'nope' })).toMatchObject({ word: 'UNKNOWN', asOf: 'unknown' });
  });
});

// The Slack orders reply labels through classifyWorkItem. These cases must agree.
describe('parity with comms/work-item-state classifyWorkItem', () => {
  const stamp = ago(5);
  const cases: Array<[string, Parameters<typeof classifyWorkItem>[0], Partial<WorkStatusEvidence>]> = [
    ['received', { id: 'x', receivedAt: stamp }, { ingressReceiptId: 'x' }],
    ['assigned', { id: 'x', receivedAt: stamp, owner: 'o', claimReceipt: 'c' }, { ingressReceiptId: 'x', owner: 'o', claimId: 'c' }],
    ['owner without claim', { id: 'x', receivedAt: stamp, owner: 'o' }, { ingressReceiptId: 'x', owner: 'o' }],
    ['running', { id: 'x', receivedAt: stamp, owner: 'o', claimReceipt: 'c', runningEvidence: { source: 's', at: stamp } },
      { ingressReceiptId: 'x', owner: 'o', claimId: 'c', lastProgressAt: stamp }],
    ['blocked', { id: 'x', receivedAt: stamp, blocker: { dependency: 'lane held', source: 's', at: stamp } },
      { ingressReceiptId: 'x', blockedBy: 'lane held' }],
    ['verified', { id: 'x', receivedAt: stamp, verified: { pr: 3, head: 'abc', tests: 'pass', source: 's', at: stamp } },
      { ingressReceiptId: 'x', prNumber: 3, headSha: 'abc', testsPassed: true }],
  ];
  for (const [name, item, ev] of cases) {
    it(name, () => expect(g(ev).word).toBe(classifyWorkItem(item, now).state));
  }
});
