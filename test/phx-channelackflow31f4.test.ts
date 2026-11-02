import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChannelReceiver, type ChannelAck } from '../src/core/fleet/channel-envelope.js';
import { readInboxEntries } from '../src/core/fleet/mason-inbox.js';

let runsDir: string;
const sender = 'fake-canonical-mason';
const when = new Date('2026-10-31T04:13:00.000Z');
const now = (): Date => when;
const email = { channel: 'email' as const, verifiedSenderId: sender, body: '  fake cafe\u0301\r\nsecond line  ' };
const telegram = { channel: 'telegram' as const, verifiedSenderId: sender, body: 'fake café\nsecond line' };

beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'fake-channel-ack-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

describe('persisted channel acknowledgements', () => {
  it('persists canonical input once and routes detached receipts to the originating fake transports', async () => {
    const emailAcks: ChannelAck[] = [];
    const telegramAcks: ChannelAck[] = [];
    const observedInbox: Awaited<ReturnType<typeof readInboxEntries>>[] = [];
    const receive = createChannelReceiver({
      runsDir, now, allowedSenderIds: new Set([sender]),
      acknowledge: async (ack) => {
        observedInbox.push(await readInboxEntries({ runsDir }));
        const transport = ack.channel === 'email' ? emailAcks : telegramAcks;
        transport.push({ ...ack });
        // A transport may change its argument without changing the receiver's result.
        ack.channel = 'desktop';
        ack.status = 'duplicate';
        ack.dedupeKey = 'fake-mutated-key';
      },
    });

    const first = await receive(email);
    const second = await receive(telegram);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('expected successful receipts');
    expect(first.envelope.body).toBe(telegram.body);
    expect(second.envelope.body).toBe(telegram.body);
    expect(first.ack).toEqual({ channel: 'email', status: 'accepted', dedupeKey: first.envelope.dedupeKey });
    expect(second.ack).toEqual({ channel: 'telegram', status: 'duplicate', dedupeKey: first.ack.dedupeKey });
    expect(emailAcks).toEqual([first.ack]);
    expect(telegramAcks).toEqual([second.ack]);
    const persisted = {
      sourceState: 'healthy',
      entries: [{ at: '2026-10-31 00:13', source: 'email', priority: 'P0', text: telegram.body }],
    };
    expect(observedInbox).toEqual([persisted, persisted]);
    expect(await readInboxEntries({ runsDir })).toEqual(persisted);
  });

  it('does not acknowledge a failed inbox write and persists an accepted retry', async () => {
    const emailAcks: ChannelAck[] = [];
    const telegramAcks: ChannelAck[] = [];
    const receive = createChannelReceiver({
      runsDir, now, allowedSenderIds: new Set([sender]),
      acknowledge: async (ack) => { (ack.channel === 'email' ? emailAcks : telegramAcks).push({ ...ack }); },
    });
    const inboxPath = join(runsDir, 'leader', 'MASON-INBOX.md');
    await mkdir(inboxPath, { recursive: true });

    expect(await receive(email)).toEqual({ ok: false, reason: 'write-failed' });
    expect(emailAcks).toEqual([]);
    expect(telegramAcks).toEqual([]);
    await rm(inboxPath, { recursive: true });

    const retry = await receive(telegram);
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error('expected an accepted retry');
    expect(retry.ack).toEqual({ channel: 'telegram', status: 'accepted', dedupeKey: retry.envelope.dedupeKey });
    expect(emailAcks).toEqual([]);
    expect(telegramAcks).toEqual([retry.ack]);
    expect(await readInboxEntries({ runsDir })).toEqual({
      sourceState: 'healthy',
      entries: [{ at: '2026-10-31 00:13', source: 'telegram', priority: 'P0', text: telegram.body }],
    });
  });

  it('retains accepted context when the originating transport fails', async () => {
    const attemptedEmailAcks: ChannelAck[] = [];
    const telegramAcks: ChannelAck[] = [];
    const receive = createChannelReceiver({
      runsDir, now, allowedSenderIds: new Set([sender]),
      acknowledge: async (ack) => {
        if (ack.channel === 'email') {
          attemptedEmailAcks.push({ ...ack });
          throw new Error('fake email transport failure');
        }
        telegramAcks.push({ ...ack });
      },
    });

    const first = await receive(email);
    const second = await receive(telegram);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('expected successful receipts');
    expect(first.ack).toEqual({ channel: 'email', status: 'accepted', dedupeKey: first.envelope.dedupeKey });
    expect(attemptedEmailAcks).toEqual([first.ack]);
    expect(second.ack).toEqual({ channel: 'telegram', status: 'duplicate', dedupeKey: first.ack.dedupeKey });
    expect(telegramAcks).toEqual([second.ack]);
    expect(await readInboxEntries({ runsDir })).toEqual({
      sourceState: 'healthy',
      entries: [{ at: '2026-10-31 00:13', source: 'email', priority: 'P0', text: telegram.body }],
    });
  });
});
