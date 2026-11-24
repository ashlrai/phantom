import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { appendBusInbox, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { collectBusWorkItemEvidence, deriveBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { classifyWorkItem } from '../src/core/comms/work-item-state.js';

const now = Date.parse('2026-11-22T12:00:00Z');
const id = 'fake-request';
const request: BusInboxReceipt = { cursor: 2, receivedAt: now - 1000,
  envelope: { id, from: 'fake-peer', to: 'fake-lane', priority: 'P1', ttl: 10_000_000, body: {} } };
const claim = { id, cursor: request.cursor, receivedAt: request.receivedAt, owner: 'fake-owner',
  leaseUntil: now - 1, completedAt: now - 1 };
const reply = (cursor: number, at: number, kind: 'verified' | 'blocked'): BusInboxReceipt => ({
  cursor, receivedAt: at, envelope: { ...request.envelope, id: `fake-reply-${cursor}`,
    body: { inReplyTo: id, [kind]: kind === 'verified' ? { tests: 'passed' } : { dependency: 'fake-dependency' } } },
});
const classify = (rows: BusInboxReceipt[]) => classifyWorkItem(
  deriveBusWorkItemEvidence(id, [request, ...rows], [claim], now).evidence, new Date(now).toISOString());

it.each([['verified', 'VERIFIED'], ['blocked', 'BLOCKED']] as const)(
  'keeps eligible %s evidence when a later reply is future-dated or invalid', (kind, state) => {
    const result = classify([reply(3, now, kind), reply(4, now + 300_001, kind), reply(5, NaN, kind)]);
    expect(result).toMatchObject({ state, source: 'bus-reply:fake-reply-3' });
  });

it.each([['verified', 'VERIFIED'], ['blocked', 'BLOCKED']] as const)(
  'accepts the five-minute boundary and rejects beyond it for %s', (kind, state) => {
    expect(classify([reply(3, now + 300_000, kind), reply(4, now + 300_001, kind)]))
      .toMatchObject({ state, source: 'bus-reply:fake-reply-3' });
    expect(classify([reply(3, now + 300_001, kind)])).toMatchObject({ state: 'ASSIGNED' });
  });

it.each([['verified', 'VERIFIED'], ['blocked', 'BLOCKED']] as const)(
  'retains cursor order for eligible %s replies, including historical evidence', (kind, state) => {
    expect(classify([reply(3, now - 900, kind), reply(4, now - 950, kind)]))
      .toMatchObject({ state, source: 'bus-reply:fake-reply-4' });
  });

it('excludes earlier generations and preserves verification precedence', () => {
  expect(classify([reply(1, now, 'verified'), reply(3, request.receivedAt - 1, 'blocked')]))
    .toMatchObject({ state: 'ASSIGNED' });
  expect(classify([reply(3, now, 'verified'), reply(4, now, 'blocked')]))
    .toMatchObject({ state: 'VERIFIED', source: 'bus-reply:fake-reply-3' });
});

it('collects a settled durable inbox without changing it', () => {
  const root = mkdtempSync(join(tmpdir(), 'reply-time-selection-'));
  try {
    for (const row of [request, reply(3, now, 'verified'), reply(4, now + 300_001, 'verified')]) {
      expect(appendBusInbox(row.envelope, { root, now: () => row.receivedAt }).status).toBe('posted');
    }
    const file = join(root, 'bus-inbox/messages.json');
    const before = readFileSync(file, 'utf8');
    const result = collectBusWorkItemEvidence(id, { root, now });
    expect(result.sources.inbox).toBe('found');
    expect(classifyWorkItem(result.evidence, new Date(now).toISOString()))
      .toMatchObject({ state: 'VERIFIED', source: 'bus-reply:fake-reply-3' });
    expect(readFileSync(file, 'utf8')).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
