/** RQ-PHX-NOTIFYPENDINGSUPERSEDE344S — pending board-notify supersession:
 * a BLOCKED notice whose transport send fails leaves no durable receipt,
 * so the item stays pending in the snapshot. When newer VERIFIED
 * execution evidence lands before the next pass, the retried notice must
 * carry the actual current classification — VERIFIED with the new reply's
 * proof on the item's exact source thread — never the superseded failed
 * BLOCKED payload. Two real bus requests carry fake Slack channel/thread
 * labels; results post through the real `fleet work-result` CLI and board
 * passes through the real `fleet board-notify` entry point with only
 * transport senders and the clock injected. Caller dependencies are
 * recreated between passes to simulate process restart: the durable
 * snapshot and sent ledger — not spy counts — prove exactly-once
 * delivery, no timestamp-only notification and no synthesized claims.
 * The contrasting case shows a failed unchanged notice really retries
 * and becomes durable exactly once. No real transport ever leaves. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, listBusInboxAfter, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { cmdFleetWorkResult } from '../src/cli/fleet-work-result.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { inspectBusWorkClaims } from '../src/core/fleet/bus-work-claims.js';
import {
  boardNotifyLedgerPath, readBoardNotifySent, readBoardNotifySnapshot,
  type BoardNotice,
} from '../src/core/fleet/work-board-notify.js';

const ID_A = 'RQ-PHX-FAKE-344-A';
const ID_B = 'RQ-PHX-FAKE-344-B';
const TS_A = 'T0FAKEDT/C0FAKEDT/1700000000.000344';
const TS_B = 'T0FAKEDT/C0FAKEDT/1700000000.000345';
const REPLY_BLOCKED = 'fake-reply-344-a-blocked';
const REPLY_VERIFIED_A = 'fake-reply-344-a-verified';
const REPLY_VERIFIED_B = 'fake-reply-344-b-verified';
const DEP = 'waiting on fake-dep-344';
const TESTS_A = 'fake suite green 344-a';
const TESTS_B = 'fake suite green 344-b';
const TTL = 10_000_000;

const slackRequest = (id: string, ref: string): BusEnvelope => ({
  id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: TTL,
  channel: 'slack', channel_ref: ref,
  sender: { agent_id: 'fake-requester', vendor: 'fake-vendor', human: false, team: true },
  external: false,
  body: { kind: 'work' },
});

type SlackSender = ReturnType<typeof vi.fn>;
interface Senders { slack: SlackSender; bus: SlackSender }

let receiptSeq = 0;
const workingSenders = (): Senders => ({
  slack: vi.fn(async () => ({ status: 'sent' as const, receipt: `fake-ts-${++receiptSeq}` })),
  bus: vi.fn(),
});
const failingSenders = (): Senders => ({
  slack: vi.fn(async () => ({ status: 'unavailable' as const, reason: 'fake transport down' })),
  bus: vi.fn(async () => ({ status: 'unavailable' as const, reason: 'fake transport down' })),
});

describe('board-notify pending supersession', { timeout: 60_000 }, () => {
  let root: string, dir: string, now: number;
  let log: ReturnType<typeof vi.spyOn>;

  const postRequest = (id: string, ref: string) =>
    expect(appendBusInbox(slackRequest(id, ref), { root, now: () => now }).status).toBe('posted');
  const workResult = async (replyId: string, extra: string[], requestId = ID_A) => {
    const output: string[] = [];
    const code = await cmdFleetWorkResult(
      ['--request-id', requestId, '--reply-id', replyId, '--root', root, ...extra],
      { now: () => now }, { output: text => output.push(text) });
    return { code, result: JSON.parse(output.join('')) as { outcome: string; transport: string | null } };
  };
  const runNotify = async (senders: Senders) => {
    const code = await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'],
      { senders, now: () => now, killed: false });
    return { code, report: JSON.parse(String(log.mock.calls.at(-1)![0])) as Record<string, unknown> };
  };
  const boardItem = (id: string) => listWorkBoard({ root, now }).items.find(i => i.id === id);
  const snapshotItem = (id: string) =>
    readBoardNotifySnapshot(dir)?.find(item => item.id === id);
  const ledgerRows = (): Array<{ itemId: string; state: string; thread: string | null; delta?: string }> => {
    try {
      return readFileSync(boardNotifyLedgerPath(dir), 'utf8')
        .split('\n').filter(line => line.trim() !== '')
        .map(line => JSON.parse(line) as { itemId: string; state: string; thread: string | null; delta?: string });
    } catch { return []; }
  };
  const inboxIds = () => {
    const page = listBusInboxAfter(0, 100, { root, now: () => now });
    return page.status === 'ok' ? page.messages.map(m => m.envelope.id) : [];
  };
  const notice = (sender: SlackSender, call: number) => sender.mock.calls[call]![0] as BoardNotice;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'board-notify-supersede-344-'));
    dir = mkdtempSync(join(tmpdir(), 'board-notify-supersede-state-344-'));
    now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('delivers the current VERIFIED evidence on retry, never the failed BLOCKED payload', async () => {
    // Two independent fake Slack requests in different threads; the first
    // pass only baselines — RECEIVED never notifies.
    postRequest(ID_A, TS_A);
    postRequest(ID_B, TS_B);
    let senders = workingSenders();
    let pass = await runNotify(senders);
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({ status: 'baselined', items: 2, planned: 0 });
    expect(senders.slack).not.toHaveBeenCalled();

    // A's BLOCKED result posts through the real work-result CLI; the next
    // board pass plans the notice but the transport fails — no durable
    // receipt, no ledger row, and the snapshot keeps A pending.
    now += 60_000;
    const blocked = await workResult(REPLY_BLOCKED, ['--blocked', DEP]);
    expect(blocked.code).toBe(0);
    expect(blocked.result.outcome).toBe('posted');
    senders = failingSenders(); // process restart: fresh caller dependencies
    pass = await runNotify(senders);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 1, sent: 0, pending: 1 });
    expect(senders.slack).toHaveBeenCalledTimes(1);
    const failedNotice = notice(senders.slack, 0);
    expect(failedNotice).toMatchObject({ itemId: ID_A, state: 'BLOCKED', sourceThread: TS_A });
    expect(failedNotice.text).toContain(DEP);
    expect(readBoardNotifySent(boardNotifyLedgerPath(dir))!.size).toBe(0);
    expect(ledgerRows()).toEqual([]);
    expect(snapshotItem(ID_A)).toMatchObject({ state: 'RECEIVED' });
    expect(snapshotItem(ID_B)).toMatchObject({ state: 'RECEIVED' });

    // Newer execution evidence lands under a new reply id before the next
    // pass: the classifier's VERIFIED precedence makes A VERIFIED, so the
    // retried notice must cite the verified reply — not the failed payload.
    now += 60_000;
    const verified = await workResult(REPLY_VERIFIED_A, ['--tests', TESTS_A]);
    expect(verified.code).toBe(0);
    expect(verified.result.outcome).toBe('posted');
    expect(boardItem(ID_A)).toMatchObject({ state: 'VERIFIED', owner: null, claimReceipt: null });
    expect(boardItem(ID_A)!.result).toEqual({ kind: 'verified', pr: null, head: null, tests: TESTS_A, artifact: null });
    expect(collectBusWorkItemEvidence(ID_A, { root, now }).evidence.verified)
      .toMatchObject({ tests: TESTS_A, source: `bus-reply:${REPLY_VERIFIED_A}` });

    // Transport recovers; a fresh process replays the pass. Exactly one
    // notice goes out — VERIFIED, A's exact thread, the new reply's proof.
    senders = workingSenders();
    pass = await runNotify(senders);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 1, sent: 1, pending: 0 });
    expect(senders.slack).toHaveBeenCalledTimes(1);
    const delivered = notice(senders.slack, 0);
    expect(delivered).toMatchObject({
      itemId: ID_A, state: 'VERIFIED', sourceChannel: 'slack', sourceThread: TS_A,
      source: `bus-reply:${REPLY_VERIFIED_A}`,
    });
    expect(delivered.text).toContain(TESTS_A);
    expect(delivered.text).not.toContain(DEP);
    expect(delivered.text).not.toContain(REPLY_BLOCKED);
    expect(delivered.text).not.toContain('BLOCKED');
    // Task B was never touched by A's supersession.
    expect(boardItem(ID_B)).toMatchObject({ state: 'RECEIVED', owner: null, claimReceipt: null });
    expect(senders.bus).not.toHaveBeenCalled();

    // Durable truth, not spy counts: the snapshot advanced A to VERIFIED
    // with the new evidence, and the sent ledger holds exactly one row —
    // the (itemId, state) entry key plus its delta key.
    const snap = readBoardNotifySnapshot(dir)!;
    expect(snap.find(i => i.id === ID_A)).toMatchObject({ state: 'VERIFIED' });
    expect(snap.find(i => i.id === ID_A)!.verified).toMatchObject({ tests: TESTS_A });
    expect(snap.find(i => i.id === ID_B)).toMatchObject({ state: 'RECEIVED' });
    const rowsA = ledgerRows().filter(r => r.itemId === ID_A);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]).toMatchObject({ state: 'VERIFIED', thread: TS_A });
    expect(rowsA[0]!.delta).toBeTruthy();
    const sent = readBoardNotifySent(boardNotifyLedgerPath(dir))!;
    expect(sent.has(`${ID_A} VERIFIED`)).toBe(true);
    expect(sent.has(`${ID_A} VERIFIED ${rowsA[0]!.delta}`)).toBe(true);
    expect(ledgerRows().filter(r => r.itemId === ID_B)).toHaveLength(0);

    // Another restart, clock advanced: nothing changed but time, so no
    // timestamp-only notification fires and nothing is re-delivered.
    senders = workingSenders();
    now += 60_000;
    pass = await runNotify(senders);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 0, planned: 0, sent: 0 });
    expect(senders.slack).not.toHaveBeenCalled();
    expect(ledgerRows()).toHaveLength(1);

    // Contrast: a failed UNCHANGED notice really retries. B's VERIFIED
    // result posts, the first recovered pass still cannot send, and the
    // next pass delivers the identical notice exactly once.
    now += 60_000;
    const replyB = await workResult(REPLY_VERIFIED_B, ['--tests', TESTS_B], ID_B);
    expect(replyB.code).toBe(0);
    expect(replyB.result.outcome).toBe('posted');
    senders = failingSenders();
    pass = await runNotify(senders);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 1, sent: 0, pending: 1 });
    expect(senders.slack).toHaveBeenCalledTimes(1);
    expect(notice(senders.slack, 0)).toMatchObject({ itemId: ID_B, state: 'VERIFIED', sourceThread: TS_B });
    expect(ledgerRows().filter(r => r.itemId === ID_B)).toHaveLength(0);
    expect(snapshotItem(ID_B)).toMatchObject({ state: 'RECEIVED' });

    senders = workingSenders();
    now += 60_000;
    pass = await runNotify(senders);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 1, sent: 1, pending: 0 });
    expect(senders.slack).toHaveBeenCalledTimes(1);
    const deliveredB = notice(senders.slack, 0);
    expect(deliveredB).toMatchObject({
      itemId: ID_B, state: 'VERIFIED', sourceChannel: 'slack', sourceThread: TS_B,
      source: `bus-reply:${REPLY_VERIFIED_B}`,
    });
    expect(deliveredB.text).toContain(TESTS_B);
    expect(ledgerRows().filter(r => r.itemId === ID_B)).toHaveLength(1);

    // Final restart proves durable exactly-once for both items.
    senders = workingSenders();
    now += 60_000;
    pass = await runNotify(senders);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 0, planned: 0, sent: 0 });
    expect(senders.slack).not.toHaveBeenCalled();
    expect(ledgerRows()).toHaveLength(2);
    for (const id of [ID_A, ID_B]) {
      expect(ledgerRows().filter(r => r.itemId === id)).toHaveLength(1);
      expect(boardItem(id)).toMatchObject({ state: 'VERIFIED', owner: null, claimReceipt: null });
    }

    // Evidence is not authority: no claims were synthesized, neither item
    // was ever ASSIGNED, and the injected senders appended nothing to the
    // bus — only the requests and work-result replies are stored.
    expect(inspectBusWorkClaims(root).claims).toEqual([]);
    expect(inboxIds()).toEqual([ID_A, ID_B, REPLY_BLOCKED, REPLY_VERIFIED_A, REPLY_VERIFIED_B]);
  });
});
