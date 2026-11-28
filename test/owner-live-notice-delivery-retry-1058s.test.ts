import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sendOwnerLiveNotices } from '../src/core/comms/owner-live-notice.js';
import { acceptOwnerInbound, readOwnerThread, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import type { OwnerChannelTransport, OwnerThreadSettings } from '../src/core/comms/owner-channel.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const settings: OwnerThreadSettings = {
  owners: { desktop: 'fake-desktop', slack: 'fake-slack' },
  secretHandles: { slack: 'phm_SLACK_BOT_TOKEN' }, imessageBridge: 'off', confirmed: true,
  team: [{ channel: 'bus', id: 'fake-desktop' }, { channel: 'slack', id: 'fake-slack' }],
};
function fixture() {
  const runsDir = mkdtempSync(join(tmpdir(), 'notice-retry-'));
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
async function inbound(options: OwnerThreadOptions) {
  expect((await acceptOwnerInbound({ channel: 'slack', senderId: 'fake-slack', text: 'hello', idempotencyKey: 'fake-inbound-0001', at: Date.now() }, options)).status).toBe('accepted');
}
function receipt(options: OwnerThreadOptions) {
  const thread = readOwnerThread(options);
  const message = thread.messages.find(row => row.idempotencyKey === 'leader-live-slack');
  return { message, channels: message && thread.receipts[message.id] };
}

it.each([false, true])('retries the target after refusal (all destinations fail: %s)', async allFail => {
  const { options, calls, failures } = fixture();
  await inbound(options);
  failures.add('slack');
  if (allFail) failures.add('desktop');
  const first = await sendOwnerLiveNotices(options, { apply: true });
  expect(first.sent).toEqual([]);
  expect(first.failed).toMatchObject([{ channel: 'slack', reason: 'refused' }]);
  expect(receipt(options).channels?.slack?.state).toBe('failed');
  if (!allFail) expect(receipt(options).channels?.desktop?.state).toBe('delivered');
  failures.clear();
  const second = await sendOwnerLiveNotices(options, { apply: true });
  expect(second.sent).toEqual(['slack']);
  expect(receipt(options).message?.replyTo).toBe('fake-inbound-0001');
  expect(receipt(options).channels?.slack?.state).toBe('delivered');
  expect(calls.filter(c => c === 'desktop')).toHaveLength(allFail ? 2 : 1);
  expect((await sendOwnerLiveNotices(options, { apply: true })).planned).toEqual([]);
  expect(calls.filter(c => c === 'slack')).toHaveLength(2);
});

it('suppresses a notice after a genuine delivered reply', async () => {
  const { options, calls } = fixture();
  await inbound(options);
  await sendOwnerReply({ text: 'earlier', replyTo: 'fake-inbound-0001', idempotencyKey: 'fake-reply-00001' }, options);
  const before = calls.length;
  expect((await sendOwnerLiveNotices(options, { apply: true })).planned).toEqual([]);
  expect(calls).toHaveLength(before);
});

it('does not send or write on dry runs and respects holds', async () => {
  const { options, calls } = fixture();
  await inbound(options);
  const before = readOwnerThread(options);
  expect((await sendOwnerLiveNotices(options, { apply: false })).planned).toEqual(['slack']);
  expect(readOwnerThread(options)).toEqual(before);
  for (const hold of [{ paused: true }, { halted: true }]) {
    const report = await sendOwnerLiveNotices({ ...options, ...hold }, { apply: true });
    expect(report.halted).toBe(true);
    expect(report.planned).toEqual([]);
  }
  expect(calls).toEqual([]);
});
