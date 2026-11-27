import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { OWNER_LIVE_NOTICE_TEXT, sendOwnerLiveNotices } from '../src/core/comms/owner-live-notice.js';
import {
  acceptOwnerInbound,
  isOwnerLiveNoticeKey,
  readOwnerCommsStatus,
  readOwnerThread,
  readOwnerUndeliveredReplies,
  sendOwnerReply,
  type OwnerThreadOptions,
} from '../src/core/comms/owner-thread.js';
import { readOwnerThreadHistory } from '../src/core/comms/owner-thread-archive.js';
import type { OwnerChannelTransport, OwnerThreadSettings } from '../src/core/comms/owner-channel.js';

// A Slack request answered only by the generated "Leader is live here" notice
// must stay awaiting. Only an ordinary reply identity clears it. Fake
// transports and temp dirs only: no network, credentials or account data.

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

const settings: OwnerThreadSettings = {
  owners: { desktop: 'fake-desktop', slack: 'fake-slack' },
  secretHandles: { slack: 'phm_SLACK_BOT_TOKEN' }, imessageBridge: 'off', confirmed: true,
  team: [{ channel: 'bus', id: 'fake-desktop' }, { channel: 'slack', id: 'fake-slack' }],
};
const REQUEST = 'fake-request-0001';
const REPLY = 'fake-reply-00001';

function fixture() {
  const runsDir = mkdtempSync(join(tmpdir(), 'notice-awaiting-'));
  roots.push(runsDir);
  const calls: string[] = [];
  const failures = new Set<string>();
  const transport = (channel: string): OwnerChannelTransport => ({
    async pull() { return []; },
    async deliver() { calls.push(channel); return { status: failures.has(channel) ? 'refused' : 'sent', reason: 'fake' }; },
  });
  const options: OwnerThreadOptions = {
    runsDir, busRoot: join(runsDir, 'bus'), settings, halted: false, paused: false,
    transports: { slack: transport('slack'), desktop: transport('desktop') },
    mailbox: { async accept() { return { status: 'accepted', requestId: 'fake-request' }; } },
  };
  return { options, calls, failures };
}

async function requestFromSlack(options: OwnerThreadOptions): Promise<void> {
  const accepted = await acceptOwnerInbound({
    channel: 'slack', senderId: 'fake-slack', text: 'Can you check the deploy?', idempotencyKey: REQUEST, at: Date.now(),
  }, options);
  expect(accepted.status).toBe('accepted');
}

function messageId(options: OwnerThreadOptions, key: string): string {
  const message = readOwnerThread(options).messages.find(row => row.idempotencyKey === key);
  expect(message).toBeDefined();
  return message!.id;
}

function awaiting(options: OwnerThreadOptions): string[] | null {
  return readOwnerThread(options).awaitingReply;
}

function undelivered(options: OwnerThreadOptions) {
  const read = readOwnerUndeliveredReplies({ runsDir: options.runsDir });
  if (read.status !== 'ok') throw new Error('undelivered read unavailable');
  return read.items;
}

it('keeps a Slack request awaiting after the live notice is delivered', async () => {
  const { options, calls } = fixture();
  await requestFromSlack(options);
  const request = messageId(options, REQUEST);

  const report = await sendOwnerLiveNotices(options, { apply: true });
  expect(report.sent).toEqual(['slack']);
  const notice = readOwnerThread(options).messages.find(row => row.idempotencyKey === 'leader-live-slack');
  expect(notice).toMatchObject({ direction: 'outbound', text: OWNER_LIVE_NOTICE_TEXT, replyTo: REQUEST });

  expect(readOwnerThread(options).awaitingReply).toEqual([request]);
  expect(readOwnerCommsStatus(options).awaitingReply).toBe(1);
  expect(readOwnerThread(options, 200, { awaiting: true }).messages.map(row => row.idempotencyKey)).toEqual([REQUEST]);
  // History reads archives only; its awaiting slice is honestly empty by contract.
  expect(readOwnerThreadHistory({ runsDir: options.runsDir }, { awaiting: true }).messages).toEqual([]);
  expect(undelivered(options)).toEqual([]);
  expect(readOwnerCommsStatus(options).undeliveredReplies).toBe(0);
  expect(calls.filter(channel => channel === 'slack')).toHaveLength(1);
});

it('does not report a failed live notice as an undelivered reply, and retries it', async () => {
  const { options, calls, failures } = fixture();
  await requestFromSlack(options);
  failures.add('slack');

  const first = await sendOwnerLiveNotices(options, { apply: true });
  expect(first.failed).toMatchObject([{ channel: 'slack', reason: 'refused' }]);
  const noticeId = messageId(options, 'leader-live-slack');
  expect(readOwnerThread(options).receipts[noticeId]?.slack?.state).toBe('failed');
  expect(undelivered(options)).toEqual([]);
  expect(readOwnerCommsStatus(options).undeliveredReplies).toBe(0);
  expect(awaiting(options)).toEqual([messageId(options, REQUEST)]);

  failures.clear();
  expect((await sendOwnerLiveNotices(options, { apply: true })).sent).toEqual(['slack']);
  expect(readOwnerThread(options).receipts[noticeId]?.slack?.state).toBe('delivered');
  expect(calls.filter(channel => channel === 'slack')).toHaveLength(2);
  expect(messageId(options, 'leader-live-slack')).toBe(noticeId);
  expect(awaiting(options)).toEqual([messageId(options, REQUEST)]);
});

it('sends the live notice once across repeated ticks', async () => {
  const { options, calls } = fixture();
  await requestFromSlack(options);
  await sendOwnerLiveNotices(options, { apply: true });
  const before = calls.length;

  expect((await sendOwnerLiveNotices(options, { apply: true })).planned).toEqual([]);
  expect((await sendOwnerLiveNotices(options, { apply: true })).planned).toEqual([]);
  expect(calls).toHaveLength(before);
  expect(readOwnerThread(options).messages.filter(row => row.idempotencyKey === 'leader-live-slack')).toHaveLength(1);
});

it.each([false, true])('clears the request on a substantive reply (delivery fails: %s)', async deliveryFails => {
  const { options, failures } = fixture();
  await requestFromSlack(options);
  await sendOwnerLiveNotices(options, { apply: true });
  expect(awaiting(options)).toEqual([messageId(options, REQUEST)]);

  if (deliveryFails) { failures.add('slack'); failures.add('desktop'); }
  const reply = await sendOwnerReply({ text: 'The deploy is green.', replyTo: REQUEST, idempotencyKey: REPLY }, options);
  expect(reply.status).toBe(deliveryFails ? 'refused' : 'sent');

  expect(awaiting(options)).toEqual([]);
  expect(readOwnerCommsStatus(options).awaitingReply).toBe(0);
  const items = undelivered(options);
  if (deliveryFails) {
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ idempotencyKey: REPLY, replyTo: REQUEST });
    expect(items[0]!.destinations.every(row => row.state === 'failed')).toBe(true);
    expect(readOwnerCommsStatus(options).undeliveredReplies).toBe(1);
  } else {
    expect(items).toEqual([]);
    expect(readOwnerCommsStatus(options).undeliveredReplies).toBe(0);
  }
});

it('counts an ordinary reply that repeats the notice wording as a reply', async () => {
  const { options, failures } = fixture();
  await requestFromSlack(options);
  failures.add('slack');
  failures.add('desktop');

  await sendOwnerReply({ text: OWNER_LIVE_NOTICE_TEXT, replyTo: REQUEST, idempotencyKey: REPLY }, options);

  expect(awaiting(options)).toEqual([]);
  expect(undelivered(options).map(row => row.idempotencyKey)).toEqual([REPLY]);
});

it('classifies only the generated notice identity, never an ordinary key', () => {
  expect(isOwnerLiveNoticeKey('leader-live-slack')).toBe(true);
  expect(isOwnerLiveNoticeKey('leader-live-desktop')).toBe(true);
  for (const key of ['leader-live-', 'leader-live-pigeon', 'leader-live-slack-2', 'Leader-live-slack', 'reply-leader-live-slack', REPLY]) {
    expect(isOwnerLiveNoticeKey(key)).toBe(false);
  }
});

it('counts a reply under a non-notice identity that starts with the notice prefix', async () => {
  const { options } = fixture();
  await requestFromSlack(options);
  await sendOwnerReply({ text: 'Looking now.', replyTo: REQUEST, idempotencyKey: 'leader-live-pigeon' }, options);

  expect(awaiting(options)).toEqual([]);
});
