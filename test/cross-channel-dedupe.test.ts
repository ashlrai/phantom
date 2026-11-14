/**
 * Nov12 22:30 acceptance item 4, cross-channel half, through the real ingress
 * path (RQ-PHX-SLACKCLAIMREPLAY315 covered Slack-to-Slack). Dot relays the
 * same order through iMessage and Slack: the shared channel receiver
 * (createChannelReceiver → appendInboxEntry → queueCosEnvelope) must land it
 * once — one MASON-INBOX.md entry attributed to both sources, one queued work
 * item — and acknowledge each delivery on its own channel. A replayed Slack
 * message id adds nothing; a different order still lands. All ids plainly
 * fake; runs state lives under a temp dir.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createChannelReceiver, OPERATOR_SENDER_ID, type ChannelAck,
} from '../src/core/fleet/channel-envelope.js';
import { imessageChannelMessage, senderIdFor } from '../src/core/comms/imessage-inbox-bridge.js';
import { cosJobId } from '../src/core/cos/intake.js';
import { parseInbox } from '../src/core/fleet/mason-inbox.js';
import { QueueStore } from '../src/core/queue/store.js';

const T0 = Date.parse('2026-11-12T22:30:00.000Z');
const ORDER = 'Fake order: replay the cross-channel dedupe proof.';
const OTHER = 'Fake order: a different instruction entirely.';
const IMESSAGE_HANDLE = '+1555FAKEMASON';
const SLACK_SENDER = 'slack:U0FAKEOWNER';
const SLACK_THREAD = 'T0FAKEWS/C0FAKECH/1793925720.000042';

let dir = '';
let now = T0;
let acks: ChannelAck[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cross-channel-dedupe-'));
  now = T0;
  acks = [];
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); dir = ''; });

/** The same shared boundary the adapters drive, durable store and queue included. */
function receiver() {
  return createChannelReceiver({
    allowedSenderIds: new Set([senderIdFor(IMESSAGE_HANDLE), SLACK_SENDER]),
    runsDir: dir,
    now: () => new Date(now),
    acknowledge: async (ack) => { acks.push(ack); },
  });
}
const inboxFile = () => readFileSync(join(dir, 'leader', 'MASON-INBOX.md'), 'utf8');
const jobs = async () => (await new QueueStore(join(dir, 'queue')).read()).jobs;

describe('cross-channel replay: one order over iMessage then Slack', () => {
  it('lands once, attributes both sources, acks each channel, and resists replays', async () => {
    const receive = receiver();

    // 1. The order arrives from iMessage with its own channel message id (rowid).
    const imessage = imessageChannelMessage({ rowid: 9001, text: ORDER, ts: now, handle: IMESSAGE_HANDLE });
    expect(imessage).not.toBeNull();
    const first = await receive({ ...imessage!, canonicalSenderId: OPERATOR_SENDER_ID });
    expect(first.ok && first.ack).toMatchObject({ channel: 'imessage', status: 'accepted' });
    const receiptKey = first.ok ? first.ack.dedupeKey : '';
    expect(receiptKey).toMatch(/^[a-f0-9]{64}$/);

    // 2. Two minutes later the same order body arrives from Slack with a
    // different channel message id. Dedupe keys on the normalized body, not
    // the channel message id, so it merges instead of landing twice.
    now += 2 * 60_000;
    const second = await receive({
      channel: 'slack', verifiedSenderId: SLACK_SENDER, canonicalSenderId: OPERATOR_SENDER_ID,
      body: ORDER, threadId: SLACK_THREAD,
    });
    expect(second.ok && second.ack).toMatchObject({ channel: 'slack', status: 'duplicate', dedupeKey: receiptKey });

    // Exactly one inbox entry, attributed to both sources.
    const markdown = inboxFile();
    expect(markdown.match(/\[src:/g)).toHaveLength(1);
    const entryId = /\[src:imessage id:(imessage-[0-9a-f]{16})\] \[also:slack\]/.exec(markdown)?.[1];
    expect(entryId).toBeTruthy();
    const entries = parseInbox(markdown);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: entryId, channel: 'imessage', alsoChannels: ['slack'], text: ORDER });

    // One work item in the durable queue, keyed on the shared receipt.
    expect(await jobs()).toHaveLength(1);
    expect((await jobs())[0]!.id).toBe(cosJobId(receiptKey));

    // 3. Same-channel acks: one acknowledgement per delivery on the channel it
    // arrived from, each carrying the single work item's receipt key; the Slack
    // ack also names the merged entry.
    expect(acks.map((a) => a.channel)).toEqual(['imessage', 'slack']);
    expect(acks.map((a) => a.dedupeKey)).toEqual([receiptKey, receiptKey]);
    expect(acks[1]!.entryId).toBe(entryId);

    // 4. A second delivery of the same Slack message id produces nothing new.
    now += 30_000;
    const replay = await receive({
      channel: 'slack', verifiedSenderId: SLACK_SENDER, canonicalSenderId: OPERATOR_SENDER_ID,
      body: ORDER, threadId: SLACK_THREAD,
    });
    expect(replay.ok && replay.ack).toMatchObject({ channel: 'slack', status: 'duplicate', dedupeKey: receiptKey });
    expect(inboxFile()).toBe(markdown);
    expect(await jobs()).toHaveLength(1);
    expect(acks).toHaveLength(3);

    // 5. A different order body still lands as a second entry and work item.
    now += 60_000;
    const other = await receive({
      channel: 'slack', verifiedSenderId: SLACK_SENDER, canonicalSenderId: OPERATOR_SENDER_ID,
      body: OTHER, threadId: 'T0FAKEWS/C0FAKECH/1793925810.000043',
    });
    expect(other.ok && other.ack.status).toBe('accepted');
    expect(other.ok && other.ack.dedupeKey).not.toBe(receiptKey);
    const finalMarkdown = inboxFile();
    expect(finalMarkdown.match(/\[src:/g)).toHaveLength(2);
    expect(parseInbox(finalMarkdown)).toHaveLength(2);
    expect(await jobs()).toHaveLength(2);
  });

  it('keeps slack receipts durable across receiver restarts', async () => {
    const slack = {
      channel: 'slack' as const, verifiedSenderId: SLACK_SENDER, canonicalSenderId: OPERATOR_SENDER_ID,
      body: ORDER, threadId: SLACK_THREAD,
    };
    const first = await receiver()(slack);
    expect(first.ok && first.ack.status).toBe('accepted');

    // A fresh receiver reloads the persisted receipts — including the slack
    // mirror row — and still collapses the replay onto the original key.
    const replay = await receiver()(slack);
    expect(replay.ok && replay.ack).toMatchObject({
      channel: 'slack', status: 'duplicate', dedupeKey: first.ok && first.ack.dedupeKey,
    });
    expect(inboxFile().match(/\[src:/g)).toHaveLength(1);
    expect(await jobs()).toHaveLength(1);
  });
});
