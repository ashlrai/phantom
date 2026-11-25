import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { appendBusInbox, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { collectBusWorkItemEvidence, deriveBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { classifyWorkItem } from '../src/core/comms/work-item-state.js';

const now = Date.parse('2026-11-25T12:00:00Z');
const id = 'fake-request';
const ref = 'slack:T123:C123:00123.4500';
const request: BusInboxReceipt = { cursor: 1, receivedAt: now - 1000,
  envelope: { id, from: 'fake-owner', to: 'fake-agent', priority: 'P1', ttl: 100000,
    channel: 'slack', channel_ref: ref, sender: { agent_id: 'fake-owner', vendor: 'phantom', human: false, team: true }, external: false, body: {} } };
const reply = (cursor: number, channelRef?: string): BusInboxReceipt => ({ cursor, receivedAt: now - 1000 + cursor,
  envelope: { id: `fake-reply-${cursor}`, from: 'fake-agent', to: 'fake-owner', priority: 'P1', ttl: 100000,
    ...(channelRef === undefined ? {} : { channel: 'slack' as const, channel_ref: channelRef, sender: { agent_id: 'fake-agent', vendor: 'phantom', human: false, team: true }, external: false }),
    body: { inReplyTo: id, verified: { tests: 'passed' }, blocked: { dependency: 'waiting' } } } });
const state = (evidence: ReturnType<typeof deriveBusWorkItemEvidence>['evidence']) =>
  classifyWorkItem(evidence, new Date(now).toISOString()).state;

it('rejects both kinds from a different explicit thread, preserving supported evidence', () => {
  const base = deriveBusWorkItemEvidence(id, [request], [], now).evidence;
  const rejected = deriveBusWorkItemEvidence(id, [request, reply(2, 'T123/C123/123.4501')], [], now).evidence;
  expect(rejected).toEqual(base);
  expect(state(rejected)).toBe(state(base));
  const supported = deriveBusWorkItemEvidence(id, [request, reply(2, ref), reply(3, 'T123/C123/123.4501')], [], now).evidence;
  expect(supported.verified?.source).toBe('bus-reply:fake-reply-2');
  expect(supported.blocker?.source).toBe('bus-reply:fake-reply-2');
  expect(state(supported)).toBe('VERIFIED');
});

it('accepts equivalent Slack references and replies without transport metadata', () => {
  for (const thread of [ref, 'T123/C123/123.45', undefined]) {
    const evidence = deriveBusWorkItemEvidence(id, [request, reply(2, thread)], [], now).evidence;
    expect(evidence.verified?.tests).toBe('passed');
    expect(evidence.blocker?.dependency).toBe('waiting');
    expect(state(evidence)).toBe('VERIFIED');
  }
  const otherTeam = deriveBusWorkItemEvidence(id, [request, reply(2, 'T999/C123/123.45')], [], now).evidence;
  expect(otherTeam.verified).toBeUndefined();
  expect(otherTeam.blocker).toBeUndefined();
});

it('keeps a durable inbox request in its supported state after a wrong-thread result', () => {
  const root = mkdtempSync(join(tmpdir(), 'thread-scope-'));
  try {
    for (const row of [request, reply(2, 'T123/C123/123.4501')]) {
      expect(appendBusInbox(row.envelope, { root, now: () => row.receivedAt }).status).toBe('posted');
    }
    const result = collectBusWorkItemEvidence(id, { root, now });
    expect(result.sources.inbox).toBe('found');
    expect(result.evidence.verified).toBeUndefined();
    expect(result.evidence.blocker).toBeUndefined();
    expect(state(result.evidence)).toBe(state(deriveBusWorkItemEvidence(id, [request], [], now).evidence));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
