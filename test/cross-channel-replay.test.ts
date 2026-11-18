/**
 * Nov12 22:30 acceptance item 4 (RQ-PHX-CROSSCHANNELREPLAY573): one request
 * repeated through Slack and iMessage becomes ONE durable claim and ONE result
 * receipt, not two jobs, and every delivery is acknowledged on its own channel.
 *
 * Real modules over temp dirs:
 * - Slack Socket Mode ingress (`receiveSlackSocketEnvelope`) for the delivery
 *   and its event-id retry, against a temp bus root;
 * - Slack's relay into the shared channel receiver (`createChannelReceiver`,
 *   channel 'slack' from RELAY_CHANNELS), whose `acknowledge` is the Slack send;
 * - iMessage ingress (`ingestIMessages`) end to end. Only its chat.db poll is
 *   injected, through the module's own seam;
 * - the durable receipts store, MASON-INBOX.md, the COS work queue
 *   (`queueCosEnvelope` → `QueueStore.claim/finish`) and the result draft
 *   (`draftCosResult`).
 * Only outward transports are faked: the Slack HTTP send (an in-memory
 * acknowledge) and the iMessage send (`sendIMessageOutbox`). Ids are plainly fake.
 *
 * Production gap, kept visible on purpose: no production Slack adapter
 * calls the shared receiver yet. Socket ingress posts only to the bus, and
 * owner messages go through the external Leader inbox writer. The relay
 * below is the receiver contract Slack must use, so it is test wiring, not
 * a shipped adapter. See BRIDGE_NOTES.md.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const imessageSends: { text: string; to: string }[] = [];
let onImessageSend: () => Promise<void> = async () => {};
vi.mock('../src/core/comms/imessage-outbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/comms/imessage-outbox.js')>();
  return {
    ...actual,
    sendIMessageOutbox: async (text: string, _cfg: unknown, to: string) => {
      await onImessageSend();
      imessageSends.push({ text, to });
      return { ok: true };
    },
  };
});

import { receiveSlackSocketEnvelope } from '../src/core/agents/slack-transport.js';
import { ingestIMessages } from '../src/core/comms/imessage-inbox-bridge.js';
import { writeCursor, type IntakeMsg } from '../src/core/integrations/imessage.js';
import { cosJobId, draftCosResult } from '../src/core/cos/intake.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { formatChannelAck } from '../src/core/fleet/channel-ack-text.js';
import { createChannelReceiver, OPERATOR_SENDER_ID } from '../src/core/fleet/channel-envelope.js';
import { parseInbox } from '../src/core/fleet/mason-inbox.js';
import { QueueStore } from '../src/core/queue/store.js';
import type { AshlrConfig } from '../src/core/types.js';

const T0 = Date.parse('2026-11-12T22:30:00.000Z');
const TEAM = 'T000FAKE', CHANNEL = 'C000FAKE', MASON_SLACK = 'U000FAKEMASON';
const SLACK_TS = '1794522600.000100';
const SLACK_THREAD = `${TEAM}/${CHANNEL}/${SLACK_TS}`;
const PHONE = '+15550000000';
const REQUEST = 'Fake order: rerun the cross-channel replay proof for job one.';
const SIMILAR = 'Fake order: rerun the cross-channel replay proof for job two.';
const OWNER = 'claude-fake-owner';

let runsDir = '', busRoot = '', now = T0;
let slackSends: string[] = [];
let socketAcks: string[] = [];
/** Claims held on the queue at the moment each ack left (ASSIGNED-before-claim guard). */
let claimsAtAck: number[] = [];

const cfg = { comms: { enabled: true, imessageHandle: PHONE } } as unknown as AshlrConfig;
const queue = () => new QueueStore(join(runsDir, 'queue'));
const jobs = async () => (await queue().read()).jobs;
const claimCount = async () => (await jobs()).reduce((n, job) => n + job.claims.length, 0);
const receiptIn = (text: string) => /Receipt: ([a-f0-9]{64})/.exec(text)?.[1];

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'xchan-replay-runs-'));
  busRoot = mkdtempSync(join(tmpdir(), 'xchan-replay-bus-'));
  now = T0;
  slackSends = []; socketAcks = []; claimsAtAck = [];
  imessageSends.length = 0;
  onImessageSend = async () => { claimsAtAck.push(await claimCount()); };
  // The iMessage cursor already sits just before the rows this test delivers.
  writeCursor(100, runsDir);
});
afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
  rmSync(busRoot, { recursive: true, force: true });
});

/** The Slack event exactly as Socket Mode delivers it (and redelivers it on retry). */
const socketEvent = (envelopeId: string) => ({
  type: 'events_api', envelope_id: envelopeId,
  payload: {
    team_id: TEAM, event_id: 'Ev000FAKEREQUEST',
    event: { type: 'message', channel: CHANNEL, user: MASON_SLACK, ts: SLACK_TS, text: REQUEST },
  },
});
const slackIngress = (envelopeId: string): boolean => receiveSlackSocketEnvelope(socketEvent(envelopeId), {
  config: { bridgeId: 'fake-bridge', teamId: TEAM, map: [{ topic: 'leaders', channel: CHANNEL }] },
  teamIdentities: [{ channel: 'slack', id: MASON_SLACK }],
  busRoot, runsDir, now: () => new Date(now),
}, (id) => { socketAcks.push(id); });

/** Slack's relay into the shared receiver; `acknowledge` is the Slack HTTP send. */
const slackRelay = () => createChannelReceiver({
  allowedSenderIds: new Set([`slack:${MASON_SLACK}`]),
  runsDir, now: () => new Date(now), publish: null,
  acknowledge: async (ack) => {
    claimsAtAck.push(await claimCount());
    slackSends.push(formatChannelAck(ack));
  },
});
const slackDeliver = () => slackRelay()({
  channel: 'slack', verifiedSenderId: `slack:${MASON_SLACK}`, canonicalSenderId: OPERATOR_SENDER_ID,
  threadId: SLACK_THREAD, body: REQUEST,
});

/** Real iMessage ingress for one chat.db row; only the poll is injected. */
const imessage = (rowid: number, text: string) => ingestIMessages(cfg, {
  runsDir, busRoot, platform: 'darwin', now: () => new Date(now),
  poll: async () => ({ ok: true, messages: [{ rowid, text, ts: now, handle: PHONE } satisfies IntakeMsg] }),
  bridgeFindings: () => { throw new Error('findings mirror is out of scope here'); },
  patchSweep: () => { throw new Error('patch sweep is out of scope here'); },
});

describe('cross-channel replay: Slack, then iMessage 30 s later, then a Slack retry', () => {
  it('yields one claim by one named owner, one result receipt, and a same-channel ack per delivery', async () => {
    // 1. Slack delivers R: one bus record from the socket ingress, one receipt
    //    and one queued work item from the shared receiver, one Slack ack.
    expect(slackIngress('env-fake-1')).toBe(true);
    const first = await slackDeliver();
    expect(first.ok && first.ack).toMatchObject({ channel: 'slack', status: 'accepted' });
    const receipt = first.ok ? first.ack.dedupeKey : '';
    expect(receipt).toMatch(/^[a-f0-9]{64}$/);
    const jobId = cosJobId(receipt);

    // 2. The same text arrives from iMessage 30 s later. It joins the Slack
    //    instruction: nothing new is queued, and iMessage gets its own ack
    //    that quotes the same receipt.
    now = T0 + 30_000;
    expect(await imessage(101, `  ${REQUEST}\n`)).toMatchObject({ ok: true, accepted: 0, duplicate: 1, cursor: 101 });

    // 3. Slack redelivers R (same event id, new socket envelope). The bus
    //    collapses it, the socket is acked again, and the receiver adds nothing.
    now = T0 + 60_000;
    expect(slackIngress('env-fake-2')).toBe(true);
    const retry = await slackDeliver();
    expect(retry.ok && retry.ack).toMatchObject({ channel: 'slack', status: 'duplicate', dedupeKey: receipt });

    // Each delivery is acknowledged on the channel it arrived on, and every ack
    // quotes the one receipt that names the one work item.
    expect(socketAcks).toEqual(['env-fake-1', 'env-fake-2']);
    expect(slackSends).toHaveLength(2);
    expect(imessageSends).toHaveLength(1);
    expect(imessageSends[0]!.to).toBe(PHONE);
    for (const text of [...slackSends, imessageSends[0]!.text]) {
      expect(receiptIn(text)).toBe(receipt);
      expect(cosJobId(receiptIn(text)!)).toBe(jobId);
      // No ack claims an assignment, and none left after a claim existed.
      expect(text).not.toMatch(/ASSIGNED/i);
    }
    expect(claimsAtAck).toEqual([0, 0, 0]);

    // One bus record for the Slack event, one inbox entry attributed to both
    // channels, and one queued work item.
    const bus = listBusInboxAfter(0, 50, { root: busRoot, now: () => 0 });
    expect(bus.status === 'ok' && bus.messages.map((m) => m.envelope.id))
      .toEqual([`slack-${TEAM}-${CHANNEL}-${SLACK_TS}`]);
    const entries = parseInbox(readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ channel: 'slack', alsoChannels: ['imessage'], text: REQUEST });
    expect((await jobs()).map((job) => job.id)).toEqual([jobId]);

    // 4. One named owner takes the one durable claim; a second owner cannot.
    await queue().claim(jobId, OWNER);
    await expect(queue().claim(jobId, 'claude-fake-other')).rejects.toThrow(/not READY/);
    const [claimed] = await jobs();
    expect(claimed).toMatchObject({ id: jobId, status: 'CLAIMED' });
    expect(claimed!.claims.map((c) => c.owner)).toEqual([OWNER]);

    // 5. The claim settles with exactly one result receipt.
    await draftCosResult(jobId, 'Fake result: replay proof rerun.', runsDir);
    await queue().finish(jobId, OWNER);
    const [done] = await jobs();
    expect(done).toMatchObject({ id: jobId, status: 'DONE' });
    expect(done!.claims).toHaveLength(1);
    expect(done!.claims[0]).toMatchObject({ owner: OWNER, finishedAt: expect.any(String) });
    expect(readdirSync(join(runsDir, 'cos'))).toEqual([`${jobId}.json`]);

    // 6. A similar but different request is a different identity: it gets
    //    its own receipt, work item and claim, so dedupe does not over-merge.
    now = T0 + 90_000;
    expect(await imessage(102, SIMILAR)).toMatchObject({ ok: true, accepted: 1, duplicate: 0 });
    const otherReceipt = receiptIn(imessageSends.at(-1)!.text);
    expect(otherReceipt).toMatch(/^[a-f0-9]{64}$/);
    expect(otherReceipt).not.toBe(receipt);
    const otherId = cosJobId(otherReceipt!);
    await queue().claim(otherId, OWNER);
    const all = await jobs();
    expect(all.map((job) => job.id)).toEqual([jobId, otherId]);
    expect(all.map((job) => job.claims.length)).toEqual([1, 1]);
    expect(parseInbox(readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8'))).toHaveLength(2);
  });
});
