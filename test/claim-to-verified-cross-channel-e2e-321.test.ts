/**
 * Acceptance item 4 (Nov12 22:30 ET), end to end through the real modules:
 * one authorized task traced from signed Slack bus ingress, across a durable
 * cross-channel replay merge, through a named owner's durable claim and a
 * result-receipt reply, to VERIFIED on the work board — with exactly one
 * ASSIGNED and one VERIFIED board notice, planned once.
 *
 * Existing partial proofs do not cover this trace: slack-claim-replay-e2e
 * exercises the merge decision as a pure function and never reaches the
 * board; the classifier, board and notifier tests drive fabricated inputs.
 * Here every hop is the real module over real durable state, with plainly
 * fake ids, fixed fake clocks and in-memory senders only — no network.
 *
 * Two semantics the trace relies on (read before editing):
 * - The receiver is a separate identity domain from the bus. Operator
 *   surfaces map the authenticated channel identity to one canonical sender
 *   id (OPERATOR_SENDER_ID); the bus envelope keeps the peer agent id. The
 *   slack relay channel exists so the same request is present in both
 *   domains — the bus copy feeds the work board, the channel copy feeds
 *   cross-channel dedupe. A runsDir-scoped receiver without busRoot keeps
 *   its own bus mirror skipped.
 * - claimEvidence treats a live lease as running evidence, so a freshly
 *   claimed item is RUNNING. ASSIGNED is the reporting state for a claim
 *   whose receipt is durable but whose lease has lapsed without completion
 *   (the claims row outlives its lease inside the receipt TTL). The trace
 *   therefore reads ASSIGNED after the first lease lapses, then re-acquires
 *   through the same real claim path — which is exactly what a worker whose
 *   lease died does — to produce the live-lease RUNNING evidence.
 */
import { createHmac } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSlackBusIngress, type SlackBusIngressPolicy, type SlackEventRequest,
} from '../src/core/comms/slack-bus-ingress.js';
import { listBusInboxAfter, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { inspectBusWorkClaims, mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import {
  createChannelReceiver, OPERATOR_SENDER_ID, type ChannelReceiveResult,
} from '../src/core/fleet/channel-envelope.js';
import { CROSS_CHANNEL_WINDOW_MS } from '../src/core/fleet/cross-channel-dedupe.js';
import { readRecentChannelEntries } from '../src/core/fleet/mason-inbox.js';
import { listWorkBoard, type WorkBoardResult } from '../src/core/comms/work-board.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import {
  boardNotifyLedgerKey, diffBoard, planNotifications, readBoardNotifySent,
  sendNotifications, snapshotBoard, type BoardSnapshotItem, type BoardTransition,
} from '../src/core/fleet/work-board-notify.js';

const T0 = 1_700_000_000_000;
const SECRET = 'fake-signing-secret-for-tests';
const TEXT = 'Fake request: trace this task through claim and receipt to verified.';
const SLACK_TS = '1700000000.000100';
const OWNER = 'devin-fake-1';
const OTHER = 'devin-fake-2';
const PEER_AGENT = 'fake-peer-agent';
const IMESSAGE_HANDLE = 'fake-owner@example.invalid';
const LANE = 'fake-lane-1';

const policy = (): SlackBusIngressPolicy => ({
  enabled: true, workspaceId: 'T000FAKE', receiverAppId: 'A000FAKE',
  selfBotId: 'B000FAKE', selfUserId: 'U000FAKE', bridgeId: 'fake-local-bridge',
  peers: [{ botId: 'B000PEER', appId: 'A000PEER', userId: 'U000PEER', agentId: PEER_AGENT, vendor: 'fake', bridgeId: 'fake-remote-bridge' }],
  routes: [{ channelId: 'C000FAKE', audience: 'fleet-coordination', mode: 'peer', peerBotIds: ['B000PEER'], recipients: [LANE] }],
});
const payload = () => ({
  type: 'event_callback', team_id: 'T000FAKE', api_app_id: 'A000FAKE',
  event_id: 'Ev000FAKEREQUEST', is_ext_shared_channel: false,
  event: {
    type: 'message', subtype: 'bot_message', channel: 'C000FAKE',
    bot_id: 'B000PEER', app_id: 'A000PEER', user: 'U000PEER',
    ts: SLACK_TS, text: TEXT,
    metadata: {
      event_type: 'phantom_agent_message', event_payload: {
        version: 1, kind: 'request', message_id: 'fake-message-1',
        origin_bridge: 'fake-remote-bridge', hop_count: 1,
        visited_bridges: ['fake-remote-bridge'],
      },
    },
  },
});
const sign = (timestamp: string): SlackEventRequest => {
  const rawBody = JSON.stringify(payload());
  return {
    rawBody, timestamp,
    signature: `v0=${createHmac('sha256', SECRET).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`,
  };
};

let root: string, runsDir: string, now: number;
beforeEach(() => {
  // Separate domains, both private temp roots: `root` holds the durable bus
  // stores (inbox, claims, coordination), `runsDir` holds the channel domain
  // (MASON-INBOX.md, channel receipts, COS queue, notify ledger).
  root = mkdtempSync(join(tmpdir(), 'claim-verify-bus-'));
  chmodSync(root, 0o700);
  runsDir = mkdtempSync(join(tmpdir(), 'claim-verify-runs-'));
  chmodSync(runsDir, 0o700);
  now = T0;
  // The claim store reads Date.now() directly; pin it to the fake clock.
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
});

const ingress = () => createSlackBusIngress({
  root, readPolicy: policy, readSigningSecret: () => SECRET, now: () => now,
});
/** Fresh receiver each call: dedupe is proven by the durable receipts store,
 * not by instance memory, so a new instance across the same runsDir is the
 * honest replay surface. publish:null keeps the channel copy unmirrored —
 * the fleet copy already arrived through the slack bus ingress. */
const receiver = () => createChannelReceiver({
  allowedSenderIds: new Set([PEER_AGENT, IMESSAGE_HANDLE]),
  runsDir, now: () => new Date(now), publish: null,
});
const inbox = (): BusInboxReceipt[] => {
  const page = listBusInboxAfter(0, 100, { root, now: () => 0 });
  expect(page.status).toBe('ok');
  return page.status === 'ok' ? page.messages : [];
};
const board = (): WorkBoardResult => {
  const result = listWorkBoard({ root, now });
  expect(result.inbox).toBe('ok');
  return result;
};
const snapshot = (): BoardSnapshotItem[] =>
  snapshotBoard(board(), (id) => collectBusWorkItemEvidence(id, { root, now }).evidence);

describe('claim-to-verified cross-channel trace (acceptance item 4)', () => {
  it('traces one authorized task through owner, durable claim and receipt to VERIFIED without duplicated work', async () => {
    // ── Step 1: ingest one request through the real Slack ingress. The slack
    // bridge also relays the same order into the shared channel receiver as
    // channel 'slack' (RELAY_CHANNELS), so cross-channel dedupe sees it.
    const relay: ChannelReceiveResult = await receiver()({
      channel: 'slack', verifiedSenderId: PEER_AGENT,
      canonicalSenderId: OPERATOR_SENDER_ID, body: TEXT,
    });
    expect(relay).toMatchObject({ ok: true, ack: { channel: 'slack', status: 'accepted' } });
    expect(ingress()(sign('1700000000'))).toEqual({
      status: 'accepted', reason: 'persisted-locally', posted: 1, duplicates: 0, sendAuthorized: false,
    });
    const [receipt] = inbox();
    expect(inbox()).toHaveLength(1);
    const id = receipt!.envelope.id;
    expect(id).toMatch(/^slack:[0-9a-f]{64}$/);
    expect(receipt!.cursor).toBe(1);
    const claimReceipt = `bus-claim:${id}:1:${T0}`;

    const item1 = board().items;
    expect(item1).toHaveLength(1);
    expect(item1[0]).toMatchObject({
      id, state: 'RECEIVED', owner: null, claimReceipt: null,
      channel: 'slack', channelRef: `T000FAKE/C000FAKE/${SLACK_TS}`,
    });
    expect(item1[0]!.missing).toEqual(expect.arrayContaining(['named owner', 'durable claim receipt']));
    const snap1 = snapshot();

    // ── Step 2: replay on both transports. A byte-identical Slack redelivery
    // is a bus duplicate; the iMessage replay of the same instruction merges
    // onto the one channel-domain entry. The board keeps exactly one item and
    // the bus keeps exactly one claimable row.
    now = T0 + 30_000;
    expect(ingress()(sign('1700000030'))).toMatchObject({ status: 'accepted', posted: 0, duplicates: 1 });
    const replay: ChannelReceiveResult = await receiver()({
      channel: 'imessage', verifiedSenderId: IMESSAGE_HANDLE,
      canonicalSenderId: OPERATOR_SENDER_ID, threadId: 'fake-imsg-thread-1',
      body: `  ${TEXT.toUpperCase()}\n`,
    });
    expect(replay).toMatchObject({ ok: true, ack: { channel: 'imessage', status: 'duplicate' } });
    if (!replay.ok) throw new Error('iMessage replay refused');
    expect(typeof replay.ack.entryId).toBe('string');

    const entries = readRecentChannelEntries(runsDir, now, CROSS_CHANNEL_WINDOW_MS);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe(replay.ack.entryId);
    expect(entries[0]!.channels).toEqual(['slack', 'imessage']);
    expect(inbox()).toHaveLength(1);
    expect(board().items).toEqual([expect.objectContaining({ id, state: 'RECEIVED' })]);
    const snap2 = snapshot();

    // ── Step 3: the named owner takes the durable claim by request id (the
    // real claim path — the work-queue scanner deliberately does not pick up
    // slack-coordination bodies, pinned in slack-bus-ingress.test.ts).
    now = T0 + 60_000;
    const claim = mutateBusWorkClaim({ action: 'acquire', id, owner: OWNER, leaseMs: 60_000, root });
    expect(claim.status).toBe('acquired');
    expect(claim.token).toMatch(/^[a-f0-9]{64}$/);
    expect(claim.leaseUntil).toBe(T0 + 120_000);

    // ── Step 7a (claimed while live): another owner is refused and the owner stays.
    expect(mutateBusWorkClaim({ action: 'acquire', id, owner: OTHER, leaseMs: 60_000, root }).status)
      .toBe('conflict');
    const during = inspectBusWorkClaims(root);
    expect(during.claims).toEqual([expect.objectContaining({ id, owner: OWNER, completedAt: null })]);

    // A live lease is itself running evidence; ASSIGNED is the durable claim
    // read after that lease lapses (row retained inside the receipt TTL).
    now = T0 + 121_000;
    const item3 = board().items[0]!;
    expect(item3).toMatchObject({ state: 'ASSIGNED', owner: OWNER, claimReceipt, missing: [] });
    const snap3 = snapshot();

    // ── Step 4: running evidence the way the real worker path records it —
    // the live claim lease. A lapsed claim is re-acquired through the same
    // durable claim call runBusClaimedWork wraps; the receipt coordinates
    // (id, cursor, receivedAt) are unchanged, so the claimReceipt is stable.
    const reclaim = mutateBusWorkClaim({ action: 'acquire', id, owner: OWNER, leaseMs: 120_000, root });
    expect(reclaim.status).toBe('acquired');
    expect(reclaim.token).toMatch(/^[a-f0-9]{64}$/);
    const item4 = board().items[0]!;
    expect(item4).toMatchObject({ state: 'RUNNING', owner: OWNER, claimReceipt });
    const snap4 = snapshot();

    // ── Step 7b: a second claim attempt by another owner is still refused.
    expect(mutateBusWorkClaim({ action: 'acquire', id, owner: OTHER, leaseMs: 60_000, root }).status)
      .toBe('conflict');
    expect(inspectBusWorkClaims(root).claims[0]).toMatchObject({ owner: OWNER, completedAt: null });

    // ── Step 5: the worker posts its result receipt — an in-reply bus reply
    // carrying a verified {pr, head} artifact — then settles the claim, the
    // order runBusClaimedWork uses (deliver reply, then complete).
    now = T0 + 122_000;
    const reply = postBusReply(id, 'fake-result-reply-1',
      { verified: { pr: 4321, head: 'fakehead321' } }, { root, now: () => now });
    expect(reply.outcome).toBe('posted');
    expect(mutateBusWorkClaim({ action: 'complete', id, token: reclaim.token, root }).status).toBe('completed');

    const items5 = board().items;
    expect(items5).toHaveLength(1); // the in-reply reply is evidence, not a work item
    expect(items5[0]).toMatchObject({ state: 'VERIFIED', owner: OWNER, claimReceipt });
    const snap5 = snapshot();

    // ── Step 7c: after completion no one can claim the receipt again.
    expect(mutateBusWorkClaim({ action: 'acquire', id, owner: OTHER, leaseMs: 60_000, root }).status)
      .toBe('completed');
    const claims = inspectBusWorkClaims(root);
    expect(claims.claims).toEqual([expect.objectContaining({ id, owner: OWNER })]);
    expect(claims.claims[0]).not.toHaveProperty('token');
    // Fencing tokens never surface: not in the board view, not in inspection.
    for (const token of [claim.token!, reclaim.token!]) {
      expect(JSON.stringify(items5)).not.toContain(token);
      expect(JSON.stringify(claims)).not.toContain(token);
    }

    // ── Step 6: diffBoard + planNotifications across snapshots 1→5 plan
    // exactly one ASSIGNED and one VERIFIED notice for the item, sent through
    // an in-memory fake slack sender, fenced once by the real durable ledger.
    const snaps = [snap1, snap2, snap3, snap4, snap5];
    const transitions: BoardTransition[] = diffBoard([], snap1);
    for (let i = 1; i < snaps.length; i++) transitions.push(...diffBoard(snaps[i - 1]!, snaps[i]!));
    expect(transitions.map((t) => `${t.from ?? '∅'}→${t.to}`)).toEqual([
      '∅→RECEIVED', 'RECEIVED→ASSIGNED', 'ASSIGNED→RUNNING', 'RUNNING→VERIFIED',
    ]);
    expect(transitions.every((t) => t.itemId === id)).toBe(true);

    const plan = planNotifications(transitions, new Set());
    expect(plan.notices.map((n) => n.state)).toEqual(['ASSIGNED', 'VERIFIED']);
    expect(plan.notices[0]).toMatchObject({ itemId: id, detail: OWNER, sourceChannel: 'slack', sourceThread: `T000FAKE/C000FAKE/${SLACK_TS}` });
    expect(plan.notices[1]).toMatchObject({ itemId: id, detail: 'PR #4321', sourceChannel: 'slack' });

    const posted: string[] = [];
    const ledgerPath = join(runsDir, 'work-board-notify', 'sent.jsonl');
    const sent = await sendNotifications(plan.notices, {
      senders: { slack: (notice) => { posted.push(notice.text); return { status: 'sent', receipt: 'fake-thread-receipt' }; } },
      ledgerPath, now: () => now,
    });
    expect(sent.map((r) => r.status)).toEqual(['sent', 'sent']);
    expect(posted).toHaveLength(2);
    // The item id stays intact on the notice objects (asserted above); in the
    // posted line its sha256 tail is a secret shape, so the text scrubber
    // redacts it. The thread routing — sourceThread — is unaffected.
    expect(posted[0]).toContain('ASSIGNED slack:[REDACTED]');
    expect(posted[0]).toContain(OWNER);
    expect(posted[1]).toContain('VERIFIED slack:[REDACTED]');
    expect(posted[1]).toContain('PR #4321');
    for (const token of [claim.token!, reclaim.token!]) {
      expect(posted.join('\n')).not.toContain(token);
    }

    const sentSet = readBoardNotifySent(ledgerPath);
    expect(sentSet).toEqual(new Set([
      boardNotifyLedgerKey(id, 'ASSIGNED'), boardNotifyLedgerKey(id, 'VERIFIED'),
    ]));
    // A repeated pass — same transitions against the durable ledger — plans
    // nothing new, and an unchanged board diffs to nothing at all.
    const repeat = planNotifications(transitions, sentSet!);
    expect(repeat.notices).toEqual([]);
    expect(repeat.dropped).toHaveLength(2);
    expect(repeat.dropped.every((d) => d.reason.endsWith('already notified'))).toBe(true);
    expect(diffBoard(snap5, snap5)).toEqual([]);
  }, 60_000);
});
