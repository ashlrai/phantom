import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { classifyWorkItem } from '../src/core/comms/work-item-state.js';

let root: string;
let now: number;
const id = 'request';
function post(name: string, from: string, to: string, body: Record<string, unknown>) {
  expect(appendBusInbox({ id: name, from, to, priority: 'P1', ttl: 10_000_000, body },
    { root, now: () => now++ }).status).toBe('posted');
}
function observe() {
  const result = collectBusWorkItemEvidence(id, { root, now });
  return { ...result, classification: classifyWorkItem(result.evidence, new Date(now).toISOString()) };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trace-participants-'));
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  post(id, 'requester', 'worker', { kind: 'work' });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it.each([
  ['blocked', { blocked: { dependency: 'dependency' } }, 'BLOCKED'],
  ['verified', { verified: { tests: 'passed' } }, 'VERIFIED'],
])('accepts a reverse-addressed %s reply and ignores later unrelated results', (_kind, result, state) => {
  post('valid', 'worker', 'requester', { inReplyTo: id, ...result });
  post('wrong-sender', 'stranger', 'requester', { inReplyTo: id, ...result });
  post('wrong-recipient', 'worker', 'other', { inReplyTo: id, ...result });
  const observed = observe();
  expect(observed.sources.inbox).toBe('found');
  expect(observed.classification).toMatchObject({ state, source: 'bus-reply:valid' });
});

it('rejects wrong participants while preserving claim evidence', () => {
  expect(mutateBusWorkClaim({ action: 'acquire', id, owner: 'worker', leaseMs: 600_000, root }).status).toBe('acquired');
  post('wrong-sender', 'stranger', 'requester', { inReplyTo: id, verified: { tests: 'passed' } });
  post('wrong-recipient', 'worker', 'other', { inReplyTo: id, blocked: { dependency: 'dependency' } });
  const { evidence, classification } = observe();
  expect(evidence.verified).toBeUndefined();
  expect(evidence.blocker).toBeUndefined();
  expect(evidence.owner).toBe('worker');
  expect(evidence.claimReceipt).toMatch(/^bus-claim:request:/);
  expect(classification.state).toBe('RUNNING');
  expect(classification.source).toMatch(/^bus-work-claims lease-until /);
});

it('honors both request identity aliases and rejects conflicting aliases', () => {
  post('snake', 'worker', 'requester', { in_reply_to: id, verified: { artifact: 'report' } });
  post('conflict', 'worker', 'requester', { inReplyTo: id, in_reply_to: 'other', verified: { tests: 'passed' } });
  const { evidence, classification } = observe();
  expect(evidence.verified).toMatchObject({ artifact: 'report', source: 'bus-reply:snake' });
  expect(classification).toMatchObject({ state: 'VERIFIED', source: 'bus-reply:snake' });
});
