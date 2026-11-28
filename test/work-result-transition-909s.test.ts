import { expect, it } from 'vitest';
import { deriveBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { classifyWorkItem } from '../src/core/comms/work-item-state.js';
import type { BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';

const now = Date.parse('2026-11-22T12:00:00Z');
const id = 'fake-request';
const request: BusInboxReceipt = { cursor: 10, receivedAt: now - 1000,
  envelope: { id, from: 'fake-peer', to: 'fake-lane', priority: 'P1', ttl: 10_000_000, body: {} } };
const reply = (cursor: number, body: Record<string, unknown>, receivedAt = now - 1000 + cursor): BusInboxReceipt => ({
  cursor, receivedAt, envelope: { ...request.envelope, id: `fake-reply-${cursor}`, body: { inReplyTo: id, ...body } },
});
const verified = (cursor: number) => reply(cursor, { verified: { tests: 'passed' } });
const blocked = (cursor: number) => reply(cursor, { blocked: { dependency: 'fake-dependency' } });
const claim = { id, cursor: request.cursor, receivedAt: request.receivedAt, owner: 'fake-owner',
  leaseUntil: now + 1000, completedAt: null };

function assertResult(rows: BusInboxReceipt[], state: 'VERIFIED' | 'BLOCKED', active: BusInboxReceipt) {
  for (const order of [rows, [...rows].reverse()]) {
    const { evidence } = deriveBusWorkItemEvidence(id, order, [claim], now);
    expect(classifyWorkItem(evidence, new Date(now).toISOString())).toEqual({
      state, source: `bus-reply:${active.envelope.id}`, asOf: new Date(active.receivedAt).toISOString(), missing: [],
    });
    expect(evidence[state === 'VERIFIED' ? 'blocker' : 'verified']).toBeUndefined();
    expect(evidence).toMatchObject({ owner: 'fake-owner', claimReceipt: `bus-claim:${id}:10:${request.receivedAt}`,
      receivedAt: new Date(request.receivedAt).toISOString(), runningEvidence: { at: new Date(now).toISOString() } });
  }
}

it('transitions between durable result kinds by cursor in either persisted order', () => {
  const first = verified(20), second = blocked(30), third = verified(40);
  assertResult([request, first], 'VERIFIED', first);
  assertResult([request, first, second], 'BLOCKED', second);
  assertResult([request, first, second, third], 'VERIFIED', third);
});

it('ignores later non-results, unrelated replies, invalid times and old generations', () => {
  const active = blocked(30);
  const rows = [request, verified(20), active,
    reply(31, { text: 'done' }), reply(32, { verified: { pr: 7 }, blocked: { dependency: 'unknown' } }),
    reply(33, { inReplyTo: 'another-request', verified: { tests: 'passed' } }),
    reply(34, { in_reply_to: 'another-request', verified: { tests: 'passed' } }),
    reply(35, { verified: { tests: 'future' } }, now + 300_001),
    reply(36, { verified: { tests: 'invalid' } }, NaN),
    reply(37, { verified: { tests: 'old generation' } }, request.receivedAt - 1),
    verified(5)];
  assertResult(rows, 'BLOCKED', active);
});

it('gives verification precedence when both valid forms share one receipt', () => {
  const both = reply(40, { verified: { artifact: 'fake-artifact' }, blocked: { dependency: 'fake-dependency' } });
  assertResult([request, blocked(30), both], 'VERIFIED', both);
});
