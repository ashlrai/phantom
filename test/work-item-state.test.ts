import { expect, it } from 'vitest';
import { classifyWorkItem, type WorkItemEvidence } from '../src/core/comms/work-item-state.js';

const NOW = '2026-11-13T12:00:00.000Z';
const ago = (min: number) => new Date(Date.parse(NOW) - min * 60_000).toISOString();
const base: WorkItemEvidence = { id: 'RQ-FAKE-1', receivedAt: ago(120) };

it('RECEIVED with only a receipt time', () => {
  expect(classifyWorkItem(base, NOW)).toEqual({ state: 'RECEIVED', asOf: ago(120), source: 'receivedAt', missing: ['named owner', 'durable claim receipt'] });
});

it('ASSIGNED needs owner and claim receipt', () => {
  const r = classifyWorkItem({ ...base, owner: 'owner-a', claimReceipt: 'claim-1' }, NOW);
  expect(r).toMatchObject({ state: 'ASSIGNED', source: 'claim:claim-1', missing: [] });
});

it('owner without receipt stays RECEIVED', () => {
  const r = classifyWorkItem({ ...base, owner: 'owner-a' }, NOW);
  expect(r.state).toBe('RECEIVED');
  expect(r.missing).toEqual(['durable claim receipt']);
});

it('RUNNING with fresh evidence; 31-minute-old evidence falls back to ASSIGNED', () => {
  const e = { ...base, owner: 'owner-a', claimReceipt: 'claim-1' };
  expect(classifyWorkItem({ ...e, runningEvidence: { source: 'heartbeat', at: ago(5) } }, NOW)).toEqual({ state: 'RUNNING', asOf: ago(5), source: 'heartbeat', missing: [] });
  const stale = classifyWorkItem({ ...e, runningEvidence: { source: 'heartbeat', at: ago(31) } }, NOW);
  expect(stale.state).toBe('ASSIGNED');
  expect(stale.missing).toEqual(['fresh running evidence']);
});

it('future-dated running evidence is not trusted', () => {
  expect(classifyWorkItem({ ...base, runningEvidence: { source: 'heartbeat', at: ago(-60) } }, NOW).state).toBe('RECEIVED');
});

it('BLOCKED needs a named dependency', () => {
  const blocker = { dependency: 'dep-x', source: 'ledger', at: ago(2) };
  expect(classifyWorkItem({ ...base, blocker }, NOW)).toEqual({ state: 'BLOCKED', asOf: ago(2), source: 'ledger', missing: [] });
  for (const dependency of ['', '  ', 'unknown', 'Unknown']) {
    expect(classifyWorkItem({ ...base, blocker: { ...blocker, dependency } }, NOW).state).toBe('RECEIVED');
  }
});

it('VERIFIED needs a source and pr+head, tests or artifact', () => {
  const verified = { pr: 1, head: 'abc123', source: 'gh', at: ago(1) };
  expect(classifyWorkItem({ ...base, verified }, NOW)).toEqual({ state: 'VERIFIED', asOf: ago(1), source: 'gh', missing: [] });
  expect(classifyWorkItem({ ...base, verified: { tests: '3 passed', source: 'vitest', at: ago(1) } }, NOW).state).toBe('VERIFIED');
  expect(classifyWorkItem({ ...base, verified: { artifact: 'out.txt', source: 'fs', at: ago(1) } }, NOW).state).toBe('VERIFIED');
  expect(classifyWorkItem({ ...base, verified: { ...verified, source: '' } }, NOW).state).toBe('RECEIVED');
  expect(classifyWorkItem({ ...base, verified: { pr: 1, source: 'gh', at: ago(1) } }, NOW).state).toBe('RECEIVED');
});

it('prose such as "routed to devin" never raises state', () => {
  const e = { id: 'RQ-FAKE-2 routed to devin', owner: 'routed to devin', receivedAt: ago(10), runningEvidence: undefined } as WorkItemEvidence;
  const r = classifyWorkItem({ ...e, claimReceipt: undefined, blocker: { dependency: 'dispatched', source: '', at: '' } }, NOW);
  expect(r.state).toBe('RECEIVED');
});

it('asOf is never invented', () => {
  expect(classifyWorkItem({ id: 'RQ-FAKE-3' }, NOW)).toEqual({ state: 'RECEIVED', asOf: 'unknown', source: 'unknown', missing: ['named owner', 'durable claim receipt'] });
  expect(classifyWorkItem({ id: 'RQ-FAKE-3', owner: 'owner-a', claimReceipt: 'c' }, NOW).asOf).toBe('unknown');
  expect(classifyWorkItem({ id: 'RQ-FAKE-3', receivedAt: 'not a date' }, NOW).asOf).toBe('unknown');
});
