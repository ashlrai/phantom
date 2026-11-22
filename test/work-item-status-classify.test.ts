import { expect, it } from 'vitest';
import { classifyWorkItem, formatWorkItemStatusLine, type WorkItemEvidence } from '../src/core/comms/work-item-state.js';

const now = '2026-11-21T12:00:00.000Z';
const ago = (minutes: number) => new Date(Date.parse(now) - minutes * 60_000).toISOString();
const ingress: WorkItemEvidence = { id: 'fake-request', receivedAt: ago(60), receivedSource: 'slack journal' };
const claim = { owner: 'fake-worker', claimReceipt: 'fake-claim' };

it.each<[string, Partial<WorkItemEvidence>, string]>([
  ['receipt', {}, 'RECEIVED'],
  ['claim', claim, 'ASSIGNED'],
  ['observation', { ...claim, runningEvidence: { source: 'heartbeat', at: ago(1) } }, 'RUNNING'],
  ['dependency', { blocker: { dependency: 'review PR 7', source: 'bus reply', at: ago(2) } }, 'BLOCKED'],
  ['PR/head', { verified: { pr: 7, head: 'a'.repeat(40), source: 'bus reply', at: ago(3) } }, 'VERIFIED'],
  ['artifact', { verified: { artifact: 'fake-report.xml', source: 'bus reply', at: ago(3) } }, 'VERIFIED'],
])('classifies %s evidence', (_name, evidence, state) => {
  expect(classifyWorkItem({ ...ingress, ...evidence }, now).state).toBe(state);
});

it('requires a claim receipt, a specific blocker and a named verification artifact', () => {
  expect(classifyWorkItem({ ...ingress, owner: claim.owner }, now)).toMatchObject({ state: 'RECEIVED', missing: ['durable claim receipt'] });
  for (const dependency of ['', ' ', 'unknown']) {
    expect(classifyWorkItem({ ...ingress, blocker: { dependency, source: 'bus', at: now } }, now).state).toBe('RECEIVED');
  }
  for (const verified of [{ pr: 7 }, { head: 'a'.repeat(40) }, { tests: 'all passed' }]) {
    expect(classifyWorkItem({ ...ingress, verified: { ...verified, source: 'bus', at: now } }, now).state).toBe('RECEIVED');
  }
});

it('drops stale RUNNING evidence to ASSIGNED and preserves its evidence timestamp', () => {
  const evidence = { ...ingress, ...claim, runningEvidence: { source: 'heartbeat', at: ago(30) } };
  expect(classifyWorkItem(evidence, now).state).toBe('RUNNING');
  const stale = classifyWorkItem({ ...evidence, runningEvidence: { source: 'heartbeat', at: ago(31) } }, now);
  expect(stale).toMatchObject({ state: 'ASSIGNED', asOf: ingress.receivedAt, missing: ['fresh running evidence'] });
});

it('ignores prose and labels while retaining ingress provenance', () => {
  const evidence = { ...ingress, text: 'routed to fake-worker; RUNNING; VERIFIED', state: 'VERIFIED', intent: 'assigned' };
  expect(classifyWorkItem(evidence, now)).toMatchObject({ state: 'RECEIVED', source: 'slack journal', asOf: ingress.receivedAt });
});

it('formats every free-text field through the shared scrubber onto one line', () => {
  const fake = `ghp_${'FAKEONLY'.repeat(5)}`;
  const result = { state: 'ASSIGNED' as const, owner: `${fake}\nworker`, asOf: fake, source: fake, missing: [fake] };
  const line = formatWorkItemStatusLine(result);
  expect(line).not.toContain(fake);
  expect(line).not.toMatch(/[\r\n]/);
  expect(line.match(/\[REDACTED\]/g)).toHaveLength(4);
  expect(formatWorkItemStatusLine({ state: 'ASSIGNED', owner: 'fake-worker', asOf: now, source: 'claim:fake-claim', missing: [] }))
    .toBe(`ASSIGNED · fake-worker · as of ${now} · source claim:fake-claim`);
});
