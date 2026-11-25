import { expect, it } from 'vitest';
import { classifyWorkItem, formatWorkItemStatusLine, type WorkItemEvidence } from '../src/core/comms/work-item-state.js';

const now = '2026-11-13T12:00:00.000Z';
const base: WorkItemEvidence = { id: 'fake', owner: 'agent-a', claimReceipt: 'claim-1' };
const running = { source: 'heartbeat', at: '2026-11-13T11:55:00.000Z' };
const blocker = { dependency: 'dep', source: 'ledger', at: now };
const verified = { tests: 'passed', source: 'test', at: now };

it('formats receipt-backed ownership across states and stale running fallback', () => {
  const cases: [WorkItemEvidence, string][] = [
    [base, 'ASSIGNED'],
    [{ ...base, runningEvidence: running }, 'RUNNING'],
    [{ ...base, blocker }, 'BLOCKED'],
    [{ ...base, verified, blocker }, 'VERIFIED'],
    [{ ...base, runningEvidence: { ...running, at: '2026-11-13T11:00:00.000Z' } }, 'ASSIGNED'],
  ];
  for (const [evidence, state] of cases) {
    const result = classifyWorkItem(evidence, now);
    expect(result.state).toBe(state);
    expect(result.owner).toBe('agent-a');
    expect(formatWorkItemStatusLine(result)).toContain(`${state} · agent-a ·`);
  }
});

it('does not project incomplete ownership, including for blocked and verified items', () => {
  for (const ownership of [{ owner: '', claimReceipt: 'claim' }, { owner: '  ', claimReceipt: 'claim' },
    { owner: 'agent-a', claimReceipt: '' }, { owner: 'agent-a', claimReceipt: '  ' },
    { owner: 'agent-a' }, { claimReceipt: 'claim' }]) {
    for (const [evidence, state] of [[{}, 'RECEIVED'], [{ blocker }, 'BLOCKED'], [{ verified }, 'VERIFIED']] as const) {
      const result = classifyWorkItem({ id: 'fake', ...ownership, ...evidence }, now);
      expect(result.state).toBe(state);
      expect(result.owner).toBeUndefined();
      expect(formatWorkItemStatusLine(result)).toContain('owner unknown');
    }
  }
});

it('scrubs untrusted owner text in the formatted line', () => {
  const fakeSecret = `sk-${'a'.repeat(48)}`;
  const result = classifyWorkItem({ ...base, owner: `agent\n${fakeSecret}` }, now);
  const line = formatWorkItemStatusLine(result);
  expect(line).not.toContain('\n');
  expect(line).not.toContain(fakeSecret);
  expect(line).toContain('agent');
});
