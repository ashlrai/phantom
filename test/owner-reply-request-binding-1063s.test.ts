import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type OwnerChannelTransport, type OwnerDelivery, type OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, postOwnerNotice, readOwnerThread, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

function fixture() {
  const runsDir = mkdtempSync(join(tmpdir(), 'owner-binding-'));
  roots.push(runsDir);
  const calls: { channel: string; input: OwnerDelivery }[] = [];
  let failSlack = false;
  const transport = (channel: string): OwnerChannelTransport => ({
    async pull() { return []; },
    async deliver(input) {
      calls.push({ channel, input });
      return failSlack && channel === 'slack' ? { status: 'refused' } : { status: 'sent' };
    },
  });
  const settings: OwnerThreadSettings = {
    owners: { desktop: 'local-owner', slack: 'U0123456789', imessage: 'owner@example.com' },
    secretHandles: { slack: 'phm_SLACK_BOT_TOKEN' }, imessageBridge: 'loopback', confirmed: true,
    team: [{ channel: 'bus', id: 'local-owner' }, { channel: 'slack', id: 'U0123456789' }, { channel: 'imessage', id: 'owner@example.com' }],
  };
  const options: OwnerThreadOptions = {
    runsDir, busRoot: join(runsDir, 'bus'), settings, halted: false, paused: false,
    transports: { desktop: transport('desktop'), slack: transport('slack'), imessage: transport('imessage') },
    mailbox: { async accept() { return { status: 'accepted', requestId: 'fake' }; } },
  };
  return { options, calls, setFailSlack: (value: boolean) => { failSlack = value; } };
}

async function ingest(options: OwnerThreadOptions, channel: 'slack' | 'imessage', key: string, channelRef?: string) {
  expect((await acceptOwnerInbound({ channel, senderId: channel === 'slack' ? 'U0123456789' : 'owner@example.com',
    text: 'request', idempotencyKey: key, at: 1_700_000_000_000, ...(channelRef ? { channelRef } : {}) }, options)).status).toBe('accepted');
}

describe('owner reply request binding', () => {
  it.each(['slack', 'imessage'] as const)('refuses reuse for a different %s request without changing receipts', async channel => {
    const { options, calls } = fixture();
    await ingest(options, 'slack', 'request-first', 'T123/C123/1.1');
    await ingest(options, channel, 'request-second', channel === 'slack' ? 'T123/C123/2.2' : undefined);
    const reply = { text: 'answer', idempotencyKey: 'reply-key', replyTo: 'request-first' };
    expect((await sendOwnerReply(reply, options)).status).toBe('sent');
    const before = readOwnerThread(options);
    const callCount = calls.length;
    expect(calls[0].input.channelRef).toBe('T123/C123/1.1');
    expect(await sendOwnerReply({ ...reply, replyTo: 'request-second' }, options)).toEqual({ status: 'refused', reason: 'This reply identity belongs to a different owner request.' });
    expect((await sendOwnerReply({ ...reply, text: 'different', replyTo: 'request-second' }, options)).reason).toBe('A different reply already owns this identity.');
    expect(calls).toHaveLength(callCount);
    const after = readOwnerThread(options);
    expect(after.messages).toEqual(before.messages);
    expect(after.receipts).toEqual(before.receipts);
    expect(after.messages.find(message => message.direction === 'outbound')?.replyTo).toBe('request-first');
    const second = after.messages.find(message => message.idempotencyKey === 'request-second')!;
    expect(after.receipts[second.id]).toBeUndefined();
    expect(after.awaitingReply).toContain(second.id);
  });

  it('deduplicates successful destinations and retries a failed destination for the same request', async () => {
    const { options, calls, setFailSlack } = fixture();
    await ingest(options, 'slack', 'request-first', 'T123/C123/1.1');
    const reply = { text: 'answer', idempotencyKey: 'reply-key', replyTo: 'request-first' };
    setFailSlack(true);
    expect((await sendOwnerReply(reply, options)).status).toBe('partial');
    setFailSlack(false);
    expect((await sendOwnerReply(reply, options)).status).toBe('sent');
    expect((await sendOwnerReply(reply, options)).status).toBe('duplicate');
    expect(calls.map(call => call.channel)).toEqual(['slack', 'desktop', 'slack']);
    expect(calls[2].input.channelRef).toBe('T123/C123/1.1');
    const view = readOwnerThread(options);
    const outbound = view.messages.find(message => message.direction === 'outbound')!;
    expect(outbound.replyTo).toBe('request-first');
    expect(view.receipts[outbound.id]).toEqual({ slack: { state: 'delivered' }, desktop: { state: 'delivered' } });
  });

  it('refuses an existing outbound identity with no recorded request', async () => {
    const { options, calls } = fixture();
    await ingest(options, 'slack', 'request-first', 'T123/C123/1.1');
    expect((await postOwnerNotice({ text: 'answer', idempotencyKey: 'reply-key' }, options)).status).toBe('accepted');
    const before = readOwnerThread(options);
    expect((await sendOwnerReply({ text: 'answer', idempotencyKey: 'reply-key', replyTo: 'request-first' }, options)).status).toBe('refused');
    expect(calls).toHaveLength(0);
    expect(readOwnerThread(options)).toEqual(before);
  });
});
