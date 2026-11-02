import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createChannelReceiver, type ChannelAck } from '../src/core/fleet/channel-envelope.js';
import { readInboxEntries } from '../src/core/fleet/mason-inbox.js';

let runsDir: string;
const sender = 'fake-verified-sender';
const now = (): Date => new Date('2026-10-31T04:13:00Z');
const email = { channel: 'email' as const, verifiedSenderId: sender, body: '  fake cafe\u0301\r\nhello  ' };
const telegram = { channel: 'telegram' as const, verifiedSenderId: sender, body: 'fake café\nhello' };

beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'channel-contract-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

describe('channel delivery integration contract', () => {
  it('shares receipts and acknowledges each channel while writing one inbox entry', async () => {
    const emailAcks: ChannelAck[] = [];
    const telegramAcks: ChannelAck[] = [];
    const options = { runsDir, now, allowedSenderIds: new Set([sender]) };
    const receiveEmail = createChannelReceiver({ ...options, acknowledge: async (ack) => { emailAcks.push(ack); } });
    const receiveTelegram = createChannelReceiver({ ...options, acknowledge: async (ack) => { telegramAcks.push(ack); } });

    const first = await receiveEmail(email);
    const duplicate = await receiveTelegram(telegram);
    expect(first.ok).toBe(true);
    expect(duplicate.ok).toBe(true);
    if (!first.ok || !duplicate.ok) throw new Error('expected successful receipts');
    expect(first.envelope.verifiedSenderId).toBe(sender);
    expect(first.envelope.body).toBe(telegram.body);
    expect(first.ack).toEqual({ channel: 'email', status: 'accepted', dedupeKey: first.envelope.dedupeKey });
    expect(duplicate.ack).toEqual({ channel: 'telegram', status: 'duplicate', dedupeKey: first.ack.dedupeKey });
    expect(emailAcks).toEqual([first.ack]);
    expect(telegramAcks).toEqual([duplicate.ack]);
    expect(await readInboxEntries({ runsDir })).toEqual({
      sourceState: 'healthy',
      entries: [{ at: '2026-10-31 00:13', source: 'email', priority: 'P0', text: telegram.body }],
    });
  });

  it('does not acknowledge a refused inbox write and accepts a retry on another channel', async () => {
    const emailAcks: ChannelAck[] = [];
    const telegramAcks: ChannelAck[] = [];
    const options = { runsDir, now, allowedSenderIds: new Set([sender]) };
    const receiveEmail = createChannelReceiver({ ...options, acknowledge: async (ack) => { emailAcks.push(ack); } });
    const receiveTelegram = createChannelReceiver({ ...options, acknowledge: async (ack) => { telegramAcks.push(ack); } });
    const inboxPath = join(runsDir, 'leader', 'MASON-INBOX.md');
    await mkdir(inboxPath, { recursive: true });

    expect(await receiveEmail(email)).toEqual({ ok: false, reason: 'write-failed' });
    expect(emailAcks).toEqual([]);
    expect(telegramAcks).toEqual([]);
    await rm(inboxPath, { recursive: true });
    const retry = await receiveTelegram(telegram);
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error('expected accepted retry');
    expect(retry.ack).toEqual({ channel: 'telegram', status: 'accepted', dedupeKey: retry.envelope.dedupeKey });
    expect(emailAcks).toEqual([]);
    expect(telegramAcks).toEqual([retry.ack]);
    expect(await readInboxEntries({ runsDir })).toEqual({
      sourceState: 'healthy',
      entries: [{ at: '2026-10-31 00:13', source: 'telegram', priority: 'P0', text: telegram.body }],
    });
  });
});
