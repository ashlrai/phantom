import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { appendBusInbox, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { collectBusWorkItemEvidence, deriveBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { classifyWorkItem } from '../src/core/comms/work-item-state.js';

const now = Date.parse('2026-11-22T12:00:00Z');
const request: BusInboxReceipt = { cursor: 1, receivedAt: now - 1000,
  envelope: { id: 'fake-request', from: 'fake-peer', to: 'fake-lane', priority: 'P1', ttl: 10_000_000, body: {} } };
const reply = (cursor: number, from: string, to: string, kind: 'verified' | 'blocked'): BusInboxReceipt => ({
  cursor, receivedAt: now - 1000 + cursor,
  envelope: { ...request.envelope, id: `fake-reply-${cursor}`, from, to,
    body: { inReplyTo: request.envelope.id, [kind]: kind === 'verified' ? { tests: 'passed' } : { dependency: 'fake-dependency' } } },
});
const classify = (rows: BusInboxReceipt[]) => classifyWorkItem(
  deriveBusWorkItemEvidence(request.envelope.id, rows, [], now).evidence, new Date(now).toISOString());

it.each(['verified', 'blocked'] as const)('accepts reversed endpoints for %s evidence', kind => {
  const row = reply(2, 'fake-lane', 'fake-peer', kind);
  expect(classify([request, row])).toMatchObject({ state: kind === 'verified' ? 'VERIFIED' : 'BLOCKED', source: 'bus-reply:fake-reply-2' });
});

it.each(['verified', 'blocked'] as const)('rejects copied IDs on wrong or inexact routes for %s', kind => {
  for (const [from, to] of [
    ['other-lane', 'fake-peer'], ['fake-lane', 'other-peer'], ['fake-peer', 'fake-lane'],
    ['Fake-lane', 'fake-peer'], ['fake-lane', 'fake-peer '],
  ]) {
    const result = deriveBusWorkItemEvidence(request.envelope.id, [request, reply(2, from, to, kind)], [], now);
    expect(result.evidence.verified).toBeUndefined();
    expect(result.evidence.blocker).toBeUndefined();
    expect(classifyWorkItem(result.evidence, new Date(now).toISOString())).toMatchObject({ state: 'RECEIVED', source: 'receivedAt' });
  }
});

it.each(['verified', 'blocked'] as const)('keeps earlier valid %s evidence when a later route differs', kind => {
  const rows = [request, reply(2, 'fake-lane', 'fake-peer', kind), reply(3, 'other-lane', 'fake-peer', kind)];
  expect(classify(rows)).toMatchObject({ state: kind === 'verified' ? 'VERIFIED' : 'BLOCKED', source: 'bus-reply:fake-reply-2' });
});

it('applies route binding to a temporary durable inbox', () => {
  const root = mkdtempSync(join(tmpdir(), 'reply-route-'));
  try {
    for (const row of [request, reply(2, 'fake-lane', 'fake-peer', 'blocked'), reply(3, 'fake-lane', 'other-peer', 'verified')]) {
      expect(appendBusInbox(row.envelope, { root, now: () => row.receivedAt }).status).toBe('posted');
    }
    const result = collectBusWorkItemEvidence(request.envelope.id, { root, now });
    expect(result.sources.inbox).toBe('found');
    expect(result.evidence.verified).toBeUndefined();
    expect(classifyWorkItem(result.evidence, new Date(now).toISOString())).toMatchObject({ state: 'BLOCKED', source: 'bus-reply:fake-reply-2' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
