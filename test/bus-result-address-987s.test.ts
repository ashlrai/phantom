import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { collectBusWorkItemEvidence, deriveBusWorkItemEvidence, readBusInboxEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { classifyWorkItem, RUNNING_FRESH_MS } from '../src/core/comms/work-item-state.js';

const id = 'RQ-FAKE-ADDRESS';
let root: string, now: number;
const state = () => classifyWorkItem(collectBusWorkItemEvidence(id, { root, now }).evidence, new Date(now).toISOString());
function post(messageId: string, from: string, to: string, body: unknown) {
  expect(appendBusInbox({ id: messageId, from, to, priority: 'P1', ttl: 10_000_000, body },
    { root, now: () => now++ }).status).toBe('posted');
}
function reply(messageId: string, from: string, to: string, result: object) {
  post(messageId, from, to, { inReplyTo: id, ...result });
}
function derived() {
  const read = readBusInboxEvidence(root);
  expect(read.status).toBe('ok');
  return deriveBusWorkItemEvidence(id, read.receipts, [], now).evidence;
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bus-address-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  post(id, 'fake-requester', 'fake-worker', { kind: 'work' });
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('structured result addresses', () => {
  it('accepts reversed participants for verified artifact and tests', () => {
    reply('fake-good', 'fake-worker', 'fake-requester', { verified: { artifact: 'fake-artifact', tests: 'fake-tests' } });
    expect(derived().verified).toMatchObject({ artifact: 'fake-artifact', tests: 'fake-tests' });
    expect(state().state).toBe('VERIFIED');
  });
  it('accepts a reversed blocker', () => {
    reply('fake-good', 'fake-worker', 'fake-requester', { blocked: { dependency: 'fake-dependency' } });
    expect(derived().blocker).toMatchObject({ dependency: 'fake-dependency' });
    expect(state().state).toBe('BLOCKED');
  });
  it.each([
    ['wrong sender', 'fake-other', 'fake-requester'],
    ['wrong recipient', 'fake-worker', 'fake-other'],
    ['forward direction', 'fake-requester', 'fake-worker'],
  ])('rejects both results with %s while retaining the inbox message', (_label, from, to) => {
    reply('fake-bad', from, to, { verified: { tests: 'fake-tests' }, blocked: { dependency: 'fake-dependency' } });
    expect(readBusInboxEvidence(root).receipts).toHaveLength(2);
    expect(derived()).not.toHaveProperty('verified');
    expect(derived()).not.toHaveProperty('blocker');
    expect(state().state).toBe('RECEIVED');
  });
  it('does not let later unrelated results mask valid evidence', () => {
    reply('fake-good', 'fake-worker', 'fake-requester', { verified: { tests: 'good-tests' }, blocked: { dependency: 'good-dep' } });
    reply('fake-bad', 'fake-other', 'fake-requester', { verified: { tests: 'bad-tests' }, blocked: { dependency: 'bad-dep' } });
    expect(derived().verified).toMatchObject({ tests: 'good-tests', source: 'bus-reply:fake-good' });
    expect(derived().blocker).toMatchObject({ dependency: 'good-dep', source: 'bus-reply:fake-good' });
    expect(state().state).toBe('VERIFIED');
  });
  it('preserves claim owner and assigned state when an unrelated result arrives', () => {
    expect(state().state).toBe('RECEIVED');
    expect(mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-owner', leaseMs: 600_000, root }).status).toBe('acquired');
    reply('fake-bad', 'fake-other', 'fake-requester', { verified: { tests: 'fake-tests' }, blocked: { dependency: 'fake-dep' } });
    now += 600_000 + RUNNING_FRESH_MS + 1;
    const { evidence } = collectBusWorkItemEvidence(id, { root, now });
    expect(evidence.owner).toBe('fake-owner');
    expect(evidence.claimReceipt).toMatch(/^bus-claim:/);
    expect(state().state).toBe('ASSIGNED');
  });
});
