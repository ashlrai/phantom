import { describe, expect, it } from 'vitest';
import { classifyWorkItem, formatWorkItemStatusLine, type WorkItemEvidence } from '../src/core/comms/work-item-state.js';

const now = '2026-11-12T22:29:00.000Z';
const receipt = '2026-11-12T22:28:00.000Z';
const before = '2026-11-12T22:27:59.999Z';
const boundary = '2026-11-12T22:34:00.000Z';
const beyond = '2026-11-12T22:34:00.001Z';
const base: WorkItemEvidence = { id: 'fixture', receivedAt: receipt, owner: 'worker', claimReceipt: 'claim' };
const verified = (at: string) => ({ tests: 'passed', source: 'tests', at });
const blocker = (at: string) => ({ dependency: 'dependency', source: 'ledger', at });
const running = (at: string) => ({ source: 'heartbeat', at });
const result = (state: string, asOf: string, source: string, missing: string[] = []) => ({ state, asOf, source, missing });

describe('work item evidence relative to the request', () => {
  it('rejects each kind of pre-request evidence', () => {
    expect(classifyWorkItem({ ...base, verified: verified(before) }, now)).toEqual(result('ASSIGNED', receipt, 'claim:claim'));
    expect(classifyWorkItem({ ...base, blocker: blocker(before) }, now)).toEqual(result('ASSIGNED', receipt, 'claim:claim'));
    const heartbeat = classifyWorkItem({ ...base, runningEvidence: running(before) }, now);
    expect(heartbeat).toEqual(result('ASSIGNED', receipt, 'claim:claim', ['running evidence at or after request']));
    expect(formatWorkItemStatusLine(heartbeat)).toContain('missing: running evidence at or after request');
  });

  it('falls through old evidence to eligible evidence in precedence order', () => {
    expect(classifyWorkItem({ ...base, verified: verified(before), blocker: blocker(receipt) }, now))
      .toEqual(result('BLOCKED', receipt, 'ledger'));
    expect(classifyWorkItem({ ...base, blocker: blocker(before), runningEvidence: running(receipt) }, now))
      .toEqual(result('RUNNING', receipt, 'heartbeat'));
    expect(classifyWorkItem({ ...base, verified: verified(before), blocker: blocker(before), runningEvidence: running(before) }, now))
      .toEqual(result('ASSIGNED', receipt, 'claim:claim', ['running evidence at or after request']));
    expect(classifyWorkItem({ id: 'fixture', receivedAt: receipt, verified: verified(before), blocker: blocker(before) }, now))
      .toEqual(result('RECEIVED', receipt, 'receivedAt', ['named owner', 'durable claim receipt']));
  });

  it('accepts equality and rejects one millisecond before for every evidence kind', () => {
    expect(classifyWorkItem({ ...base, verified: verified(receipt) }, now)).toEqual(result('VERIFIED', receipt, 'tests'));
    expect(classifyWorkItem({ ...base, blocker: blocker(receipt) }, now)).toEqual(result('BLOCKED', receipt, 'ledger'));
    expect(classifyWorkItem({ ...base, runningEvidence: running(receipt) }, now)).toEqual(result('RUNNING', receipt, 'heartbeat'));
  });

  it('preserves future skew boundaries', () => {
    for (const evidence of [
      { verified: verified(boundary) }, { blocker: blocker(boundary) }, { runningEvidence: running(boundary) },
    ]) expect(classifyWorkItem({ ...base, ...evidence }, now).asOf).toBe(boundary);
    expect(classifyWorkItem({ ...base, verified: verified(beyond), blocker: blocker(receipt) }, now))
      .toEqual(result('BLOCKED', receipt, 'ledger'));
    expect(classifyWorkItem({ ...base, blocker: blocker(beyond), runningEvidence: running(receipt) }, now))
      .toEqual(result('RUNNING', receipt, 'heartbeat'));
    expect(classifyWorkItem({ ...base, runningEvidence: running(beyond) }, now))
      .toEqual(result('ASSIGNED', receipt, 'claim:claim', ['fresh running evidence']));
  });

  it('keeps historical verification without a TTL', () => {
    expect(classifyWorkItem({ ...base, receivedAt: '2020-01-01T00:00:00.000Z', verified: verified('2020-01-02T00:00:00.000Z') }, now))
      .toEqual(result('VERIFIED', '2020-01-02T00:00:00.000Z', 'tests'));
  });

  it('retains compatibility when the receipt time is absent or invalid', () => {
    for (const receivedAt of [undefined, 'invalid']) {
      expect(classifyWorkItem({ ...base, receivedAt, verified: verified(before) }, now)).toEqual(result('VERIFIED', before, 'tests'));
      expect(classifyWorkItem({ ...base, receivedAt, blocker: blocker(before) }, now)).toEqual(result('BLOCKED', before, 'ledger'));
      expect(classifyWorkItem({ ...base, receivedAt, runningEvidence: running(before) }, now)).toEqual(result('RUNNING', before, 'heartbeat'));
    }
  });
});
