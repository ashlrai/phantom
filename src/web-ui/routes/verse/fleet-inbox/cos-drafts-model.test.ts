import { expect, it } from 'vitest';
import { approveOutcomeText, inFlightDrafts, pendingDrafts, readCosDrafts } from './cos-drafts-model.js';

const id = (n: number) => `cos-${n.toString(16).padStart(32, '0')}`;
const digest = `sha256:${'a'.repeat(64)}`;
const row = (over: Record<string, unknown> = {}) => ({
  id: id(1), channel: 'telegram', senderId: 'sender-1', text: 'Hello there', digest, delivery: 'pending', draftedAt: '2026-11-01T00:00:00Z', ...over,
});

it('keeps well-formed rows and drops bad ids, digests and shapes', () => {
  const data = { v: 1, malformed: 0, drafts: [
    row(), row({ id: 'cos-xyz' }), row({ id: id(2).toUpperCase() }), row({ digest: 'sha256:abc' }), row({ digest: 'md5:' + 'a'.repeat(64) }),
    row({ delivery: 'weird' }), row({ text: 5 }), row({ threadId: 7 }), null, 'x', row({ id: id(3), threadId: 'thread-1' }),
  ] };
  expect(readCosDrafts(data).map(d => d.id)).toEqual([id(1), id(3)]);
  expect(readCosDrafts(data)[1]!.threadId).toBe('thread-1');
});

it('returns nothing for a wrong envelope', () => {
  expect(readCosDrafts(null)).toEqual([]);
  expect(readCosDrafts({ v: 2, drafts: [row()] })).toEqual([]);
  expect(readCosDrafts({ v: 1, drafts: 'no' })).toEqual([]);
});

it('filters pending newest first and separates in-flight rows', () => {
  const drafts = readCosDrafts({ v: 1, malformed: 0, drafts: [
    row({ id: id(1), draftedAt: '2026-11-01T00:00:00Z' }), row({ id: id(2), draftedAt: '2026-11-01T02:00:00Z' }),
    row({ id: id(3), draftedAt: '2026-11-01T01:00:00Z' }), row({ id: id(4), delivery: 'sent' }),
    row({ id: id(5), delivery: 'uncertain' }), row({ id: id(6), delivery: 'sending' }),
  ] });
  expect(pendingDrafts(drafts).map(d => d.id)).toEqual([id(2), id(3), id(1)]);
  expect(inFlightDrafts(drafts).map(d => d.id)).toEqual([id(5), id(6)]);
});

it.each([
  [200, { id: id(1), delivery: 'sent' }, 'Sent on Telegram.'],
  [409, { code: 'COS_DIGEST_STALE' }, 'The draft changed; review it again.'],
  [409, { code: 'COS_ALREADY_CLAIMED' }, 'Already being sent.'],
  [409, { code: 'COS_NO_TRANSPORT' }, 'No reply route for desktop orders yet.'],
  [403, { code: 'COS_APPROVE_DESKTOP_ONLY' }, 'Approve from the desktop app.'],
  [502, { id: id(1), delivery: 'uncertain' }, 'Send failed; check the channel before retrying.'],
  [502, { code: null }, 'Send failed; check the channel before retrying.'],
  [404, null, 'Reply approval is not in this build.'],
  [500, {}, 'The draft could not be approved. Refresh and try again.'],
  [409, { code: 'OTHER' }, 'The draft could not be approved. Refresh and try again.'],
])('maps %s %j to one sentence', (status, body, sentence) => {
  expect(approveOutcomeText(status, body, 'telegram')).toBe(sentence);
});
