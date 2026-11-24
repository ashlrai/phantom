import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { appendBusInbox, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { collectBusWorkItemEvidence, deriveBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { classifyWorkItem } from '../src/core/comms/work-item-state.js';

const now = Date.parse('2026-11-22T12:00:00Z');
const request = (id: string, cursor: number): BusInboxReceipt => ({ cursor, receivedAt: now - 1000,
  envelope: { id, from: 'fake-peer', to: 'fake-lane', priority: 'P1', ttl: 10_000_000, body: {} } });
const reply = (cursor: number, target: Record<string, unknown>): BusInboxReceipt => ({
  cursor, receivedAt: now - 100, envelope: { ...request('reply', 1).envelope, id: `reply-${cursor}`,
    body: { ...target, blocked: { dependency: 'dependency' }, verified: { tests: 'passed' } } },
});
const evidence = (id: string, rows: BusInboxReceipt[]) => deriveBusWorkItemEvidence(id, rows, [], now).evidence;
const expectNoStateEvidence = (id: string, rows: BusInboxReceipt[]) => {
  expect(evidence(id, rows)).not.toHaveProperty('verified');
  expect(evidence(id, rows)).not.toHaveProperty('blocker');
};

it('accepts either alias alone or both agreeing, for both evidence kinds', () => {
  for (const target of [{ inReplyTo: 'a' }, { in_reply_to: 'a' }, { inReplyTo: 'a', in_reply_to: 'a' }]) {
    const result = evidence('a', [request('a', 1), reply(2, target)]);
    expect(result.verified).toMatchObject({ tests: 'passed' });
    expect(result.blocker).toMatchObject({ dependency: 'dependency' });
  }
  expectNoStateEvidence('a', [request('a', 1), { ...reply(2, {}), envelope: { ...reply(2, {}).envelope, body: { inReplyTo: 'a' } } }]);
});

it('rejects conflicting targets for both requests in either receipt order', () => {
  const rows = [request('a', 1), request('b', 2), reply(3, { inReplyTo: 'a', in_reply_to: 'b' })];
  for (const order of [rows, [...rows].reverse()]) for (const id of ['a', 'b']) expectNoStateEvidence(id, order);
});

it('rejects malformed secondary aliases in either direction', () => {
  for (const value of [null, 42, [], '']) {
    for (const target of [{ inReplyTo: 'a', in_reply_to: value }, { in_reply_to: 'a', inReplyTo: value }]) {
      expectNoStateEvidence('a', [request('a', 1), reply(2, target)]);
    }
  }
});

it('preserves earlier valid evidence after an ambiguous reply', () => {
  const rows = [request('a', 1), reply(2, { inReplyTo: 'a' }), reply(3, { inReplyTo: 'a', in_reply_to: 'b' })];
  expect(evidence('a', rows).verified).toMatchObject({ source: 'bus-reply:reply-2' });
  expect(evidence('a', rows).blocker).toMatchObject({ source: 'bus-reply:reply-2' });
});

it('does not classify conflicting durable replies as verified or blocked or mutate the inbox', () => {
  const root = mkdtempSync(join(tmpdir(), 'reply-target-'));
  try {
    for (const row of [request('a', 1), request('b', 2), reply(3, { inReplyTo: 'a', in_reply_to: 'b' })]) {
      expect(appendBusInbox(row.envelope, { root, now: () => row.receivedAt }).status).toBe('posted');
    }
    const file = join(root, 'bus-inbox/messages.json');
    const before = readFileSync(file);
    for (const id of ['a', 'b']) {
      const result = collectBusWorkItemEvidence(id, { root, now });
      expect(result.sources.inbox).toBe('found');
      expect(result.evidence.verified).toBeUndefined();
      expect(result.evidence.blocker).toBeUndefined();
      expect(['VERIFIED', 'BLOCKED']).not.toContain(classifyWorkItem(result.evidence, new Date(now).toISOString()).state);
    }
    expect(readFileSync(file)).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
