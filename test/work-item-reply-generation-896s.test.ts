import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { deriveBusWorkItemEvidence, readBusInboxEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { readSlackStatusReceipt } from '../src/core/comms/slack-status-receipt.js';

const ID = 'fake-request';
const START = Date.parse('2026-11-22T12:00:00Z');
let root: string, now: number;
const envelope = (id: string, ttl: number, body: Record<string, unknown>): BusEnvelope =>
  ({ id, from: 'fake-peer', to: 'fake-lane', priority: 'P1', ttl, body });
const post = (id: string, ttl: number, body: Record<string, unknown>) =>
  expect(appendBusInbox(envelope(id, ttl, body), { root, now: () => now }).status).toBe('posted');
const read = () => readSlackStatusReceipt(ID, { root, now });

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'reply-generation-')); now = START; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

it.each([
  [{ verified: { pr: 42, head: 'fake-head' } }, 'VERIFIED'],
  [{ blocked: { dependency: 'fake-dependency' } }, 'BLOCKED'],
])('does not attach an old %s reply to a replacement request', (body, oldState) => {
  post(ID, 100, { kind: 'work' });
  post('fake-old-reply', 60_000, { inReplyTo: ID, ...body });
  expect(read().state).toBe(oldState);
  now += 101;
  post('fake-unrelated', 60_000, { kind: 'note' });
  post(ID, 60_000, { kind: 'work' });
  const file = join(root, 'bus-inbox/messages.json');
  const before = readFileSync(file, 'utf8');
  const mtime = statSync(file).mtimeMs;
  expect(read().state).toBe('RECEIVED');
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect(statSync(file).mtimeMs).toBe(mtime);
  post('fake-new-reply', 60_000, { inReplyTo: ID, ...body });
  const result = read();
  expect(result.state).toBe(oldState);
  expect(result.source).toContain('fake-new-reply');
});

it('requires a request and rejects a later cursor with an earlier receipt time', () => {
  post(ID, 60_000, { kind: 'work' });
  post('fake-reply', 60_000, { inReplyTo: ID, verified: { pr: 1, head: 'fake-head' },
    blocked: { dependency: 'fake-dependency' } });
  const [request, reply] = readBusInboxEvidence(root).receipts;
  expect(deriveBusWorkItemEvidence(ID, [reply], [], now)).toEqual({ evidence: { id: ID }, inbox: 'missing' });
  const earlierReply = { ...reply, receivedAt: request.receivedAt - 1 };
  expect(deriveBusWorkItemEvidence(ID, [request, earlierReply], [], now).evidence).toEqual({
    id: ID, receivedAt: new Date(now).toISOString(),
  });
});
