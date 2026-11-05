import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalChannelDedupeStore } from '../src/core/fleet/channel-dedupe-store.js';
import { createChannelReceiver, type ChannelAck, type ChannelEnvelope } from '../src/core/fleet/channel-envelope.js';
import { appendInboxEntry, readInboxEntries } from '../src/core/fleet/mason-inbox.js';

let runsDir: string;
// Channel-line and acknowledgement contracts: merged PRs #3004, #3040, #3044, #3211.
const entryId = (channel: string, text: string) => `${channel === 'desktop' ? 'desk' : channel}-${createHash('sha256').update('2026-10-31T04:13:00.000Z' + text).digest('hex').slice(0, 16)}`;
const entry = (channel: string, text: string) => ({ at: '2026-10-31 00:13', channel, id: entryId(channel, text), source: `${channel} (${entryId(channel, text)})`, priority: null, text });

const sender = 'fake-mason';
const body = 'Please prioritize the recovery workflow.';
const now = (): Date => new Date('2026-10-31T04:13:00.000Z');

beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'ack-write-recovery-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

describe('channel acknowledgement after an inbox write failure', () => {
  it('accepts a cross-channel retry and recognizes it after restart', async () => {
    const store = createLocalChannelDedupeStore(runsDir);
    const acknowledgements: ChannelAck[] = [];
    const inboxAtAcknowledgement: Awaited<ReturnType<typeof readInboxEntries>>[] = [];
    const write = vi.fn(async (envelope: ChannelEnvelope) =>
      appendInboxEntry(envelope.body, { runsDir, now, source: envelope.channel }));
    write.mockResolvedValueOnce({ ok: false, reason: 'write-failed' });
    const options = {
      runsDir, now, allowedSenderIds: new Set([sender]), write,
      acknowledge: async (ack: ChannelAck) => {
        acknowledgements.push(ack);
        inboxAtAcknowledgement.push(await readInboxEntries({ runsDir }));
      },
    };
    const receive = createChannelReceiver({ ...options, receiptStore: store });
    const message = { verifiedSenderId: sender, body };

    expect(await receive({ ...message, channel: 'email' })).toEqual({ ok: false, reason: 'write-failed' });
    expect(acknowledgements).toEqual([]);
    expect(await readInboxEntries({ runsDir })).toEqual({ sourceState: 'missing', entries: [] });
    expect(await store.transaction(async (receipts) => receipts.size)).toBe(0);

    const retry = await receive({ ...message, channel: 'telegram' });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error('expected retry to be accepted');
    expect(retry.ack).toEqual({ channel: 'telegram', status: 'accepted', dedupeKey: retry.envelope.dedupeKey });
    expect(acknowledgements).toEqual([retry.ack]);
    const persisted = {
      sourceState: 'healthy',
      entries: [entry('telegram', body)],
    };
    expect(inboxAtAcknowledgement).toEqual([persisted]);
    expect(await store.transaction(async (receipts) => receipts.size)).toBe(1);
    expect(write).toHaveBeenCalledTimes(2);

    const restarted = createChannelReceiver({ ...options, receiptStore: createLocalChannelDedupeStore(runsDir) });
    const replay = await restarted({ ...message, channel: 'email' });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error('expected replay to be recognized');
    expect(replay.ack).toEqual({ channel: 'email', status: 'duplicate', dedupeKey: retry.ack.dedupeKey });
    expect(acknowledgements).toEqual([retry.ack, replay.ack]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(await readInboxEntries({ runsDir })).toEqual(persisted);
  });
});
