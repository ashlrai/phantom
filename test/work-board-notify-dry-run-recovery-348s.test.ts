/** RQ-PHX-NOTIFYDRYRUNRECOVERY348S — dry-run recovery of a pending
 * board-notify transition: a real bus request answered through the actual
 * `fleet work-result` CLI (a blocked dependency) reaches the actual
 * `fleet board-notify` pass, whose injected sender refuses, so the BLOCKED
 * transition stays pending in the durable snapshot with no ledger row. A
 * read-only `--dry-run` inspection — run twice, the second a fresh
 * invocation standing in for a restarted process — must report the
 * still-pending blocker without any sender call and without mutating the
 * snapshot, sent ledger or bus store (byte-identical before/after). Once a
 * receipt-producing transport returns, a fresh live pass delivers exactly
 * one notice to the original channel/thread carrying the dependency,
 * as-of and source evidence; a further fresh pass sends nothing. An
 * unrelated request in another thread stays silent throughout, and no dry
 * run ever writes successful-delivery evidence. Real bus persistence is
 * used end to end; only the outward transport senders, the clock and the
 * output sink are injected — no production module mocks, no real sends. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, listBusInboxAfter, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { cmdFleetWorkResult } from '../src/cli/fleet-work-result.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { inspectBusWorkClaims } from '../src/core/fleet/bus-work-claims.js';
import {
  boardNotifyLedgerPath, boardNotifySnapshotPath, readBoardNotifySent,
  readBoardNotifySnapshot, type BoardNotice,
} from '../src/core/fleet/work-board-notify.js';

const ID_A = 'RQ-PHX-FAKE-348-A';
const ID_B = 'RQ-PHX-FAKE-348-B';
const TS_A = 'T0FAKEDT/C0FAKEDT/1700000000.000348';
const TS_B = 'T0FAKEDT/C0FAKEDT/1700000000.000349';
const REPLY_BLOCKED = 'fake-reply-348-a-blocked';
const DEP = 'waiting on fake-dep-348';
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
const refusingSenders = (): Senders => ({
  slack: vi.fn(async () => ({ status: 'refused' as const, reason: 'fake transport refused' })),
  bus: vi.fn(async () => ({ status: 'refused' as const, reason: 'fake transport refused' })),
});

describe('board-notify dry-run recovery of a pending transition', { timeout: 60_000 }, () => {
  let root: string, dir: string, now: number;
  let log: ReturnType<typeof vi.spyOn>;

  const postRequest = (id: string, ref: string) =>
    expect(appendBusInbox(slackRequest(id, ref), { root, now: () => now }).status).toBe('posted');
  const workResult = async (replyId: string, extra: string[], requestId = ID_A) => {
    const output: string[] = [];
    const code = await cmdFleetWorkResult(
      ['--request-id', requestId, '--reply-id', replyId, '--root', root, ...extra],
      { now: () => now }, { output: text => output.push(text) });
    return { code, result: JSON.parse(output.join('')) as { outcome: string } };
  };
  const runNotify = async (args: string[], senders?: Senders) => {
    const code = await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, ...args, '--json'],
      { ...(senders ? { senders } : {}), now: () => now, killed: false });
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
  const busStoreBytes = () => readFileSync(join(root, 'bus-inbox', 'messages.json'));
  const snapshotBytes = () => readFileSync(boardNotifySnapshotPath(dir));
  const ledgerBytes = () => (existsSync(boardNotifyLedgerPath(dir)) ? readFileSync(boardNotifyLedgerPath(dir)) : null);
  const notice = (sender: SlackSender, call: number) => sender.mock.calls[call]![0] as BoardNotice;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'board-notify-dryrun-348-'));
    dir = mkdtempSync(join(tmpdir(), 'board-notify-dryrun-state-348-'));
    now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a refused BLOCKED transition pending through dry-run inspections, then delivers it exactly once', async () => {
    // Two independent fake Slack requests in different threads; the first
    // pass only baselines — RECEIVED never notifies.
    postRequest(ID_A, TS_A);
    postRequest(ID_B, TS_B);
    let senders = workingSenders();
    let pass = await runNotify([], senders);
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({ status: 'baselined', items: 2, planned: 0 });
    expect(senders.slack).not.toHaveBeenCalled();

    // A's BLOCKED result posts through the real work-result CLI; the next
    // live pass plans the notice but the transport refuses — no durable
    // receipt, no ledger row, and the snapshot keeps A pending.
    now += 60_000;
    const blocked = await workResult(REPLY_BLOCKED, ['--blocked', DEP]);
    expect(blocked.code).toBe(0);
    expect(blocked.result.outcome).toBe('posted');
    expect(boardItem(ID_A)).toMatchObject({ state: 'BLOCKED' });
    senders = refusingSenders(); // process restart: fresh caller dependencies
    pass = await runNotify([], senders);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 1, sent: 0, pending: 1 });
    expect(senders.slack).toHaveBeenCalledTimes(1);
    expect(notice(senders.slack, 0)).toMatchObject({ itemId: ID_A, state: 'BLOCKED', sourceThread: TS_A });
    expect(readBoardNotifySent(boardNotifyLedgerPath(dir))!.size).toBe(0);
    expect(ledgerRows()).toEqual([]);
    expect(snapshotItem(ID_A)).toMatchObject({ state: 'RECEIVED' });

    // Durable bytes captured at the pending point: the snapshot still
    // holds A as RECEIVED, no sent ledger exists, and the bus store holds
    // only the request and its reply.
    const snapshotBefore = snapshotBytes();
    const busBefore = busStoreBytes();
    expect(ledgerBytes()).toBeNull();
    expect(inboxIds()).toEqual([ID_A, ID_B, REPLY_BLOCKED]);

    // Dry-run pass 1: reports the still-pending blocker, calls no sender
    // and writes nothing — snapshot, ledger and bus bytes are identical.
    senders = refusingSenders();
    pass = await runNotify(['--dry-run'], senders);
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({ status: 'dry-run', baselined: false, transitions: 1, planned: 1, dropped: [] });
    const lines = pass.report.lines as string[];
    const wouldPost = lines.filter(line => line.startsWith('would-post'));
    expect(wouldPost).toHaveLength(1);
    expect(wouldPost[0]).toContain(ID_A);
    expect(wouldPost[0]).toContain('BLOCKED');
    expect(wouldPost[0]).toContain(DEP);
    expect(wouldPost[0]).toContain(`bus-reply:${REPLY_BLOCKED}`);
    expect(wouldPost[0]).toContain(TS_A);
    expect(senders.slack).not.toHaveBeenCalled();
    expect(senders.bus).not.toHaveBeenCalled();
    expect(snapshotBytes().equals(snapshotBefore)).toBe(true);
    expect(busStoreBytes().equals(busBefore)).toBe(true);
    expect(ledgerBytes()).toBeNull();

    // Dry-run pass 2, a fresh invocation standing in for a restarted
    // process: identical report, still zero sender calls, still zero
    // durable mutation — inspection never consumes the pending update.
    senders = refusingSenders();
    pass = await runNotify(['--dry-run'], senders);
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({ status: 'dry-run', baselined: false, transitions: 1, planned: 1, dropped: [] });
    expect((pass.report.lines as string[]).filter(line => line.startsWith('would-post'))).toHaveLength(1);
    expect(senders.slack).not.toHaveBeenCalled();
    expect(senders.bus).not.toHaveBeenCalled();
    expect(snapshotBytes().equals(snapshotBefore)).toBe(true);
    expect(busStoreBytes().equals(busBefore)).toBe(true);
    expect(ledgerBytes()).toBeNull();
    expect(readBoardNotifySent(boardNotifyLedgerPath(dir))!.size).toBe(0);
    expect(snapshotItem(ID_A)).toMatchObject({ state: 'RECEIVED' });

    // Transport recovers; a fresh live pass delivers the retained pending
    // transition exactly once — BLOCKED on A's original thread with the
    // dependency, as-of and source evidence.
    senders = workingSenders();
    pass = await runNotify([], senders);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 1, sent: 1, pending: 0 });
    expect(senders.slack).toHaveBeenCalledTimes(1);
    const delivered = notice(senders.slack, 0);
    expect(delivered).toMatchObject({
      itemId: ID_A, state: 'BLOCKED', sourceChannel: 'slack', sourceThread: TS_A,
      source: `bus-reply:${REPLY_BLOCKED}`, asOf: boardItem(ID_A)!.asOf,
    });
    expect(delivered.text).toContain('as of');
    expect(delivered.text).toContain(DEP);
    expect(delivered.text).toContain(ID_A);
    expect(delivered.text).toContain(`bus-reply:${REPLY_BLOCKED}`);
    expect(senders.bus).not.toHaveBeenCalled();

    // Durable truth, not spy counts: the snapshot advanced A to BLOCKED
    // and the sent ledger holds exactly one row — entry key plus delta.
    expect(snapshotItem(ID_A)).toMatchObject({ state: 'BLOCKED' });
    const rowsA = ledgerRows().filter(r => r.itemId === ID_A);
    expect(rowsA).toHaveLength(1);
    expect(rowsA[0]).toMatchObject({ state: 'BLOCKED', thread: TS_A });
    expect(rowsA[0]!.delta).toBeTruthy();
    const sent = readBoardNotifySent(boardNotifyLedgerPath(dir))!;
    expect(sent.has(`${ID_A} BLOCKED`)).toBe(true);
    expect(sent.has(`${ID_A} BLOCKED ${rowsA[0]!.delta}`)).toBe(true);

    // A further fresh pass sends nothing: the delivery is durable.
    senders = workingSenders();
    now += 60_000;
    pass = await runNotify([], senders);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 0, planned: 0, sent: 0 });
    expect(senders.slack).not.toHaveBeenCalled();
    expect(ledgerRows()).toHaveLength(1);

    // The unrelated request in the other thread stayed silent throughout:
    // still RECEIVED, no ledger rows, and every sender call targeted A.
    expect(boardItem(ID_B)).toMatchObject({ state: 'RECEIVED', owner: null, claimReceipt: null });
    expect(ledgerRows().filter(r => r.itemId === ID_B)).toHaveLength(0);
    for (const call of senders.slack.mock.calls) {
      expect((call[0] as BoardNotice).itemId).toBe(ID_A);
    }

    // A post-delivery dry run still writes no successful-delivery
    // evidence: ledger bytes are untouched by inspection.
    const ledgerAfter = ledgerBytes();
    senders = workingSenders();
    pass = await runNotify(['--dry-run'], senders);
    expect(pass.report).toMatchObject({ status: 'dry-run', transitions: 0, planned: 0, dropped: [] });
    expect(senders.slack).not.toHaveBeenCalled();
    expect(ledgerBytes()!.equals(ledgerAfter!)).toBe(true);
    expect(ledgerRows()).toHaveLength(1);

    // Evidence is not authority: no claims were synthesized and the bus
    // holds only the two requests and the blocked reply — injected
    // senders appended nothing.
    expect(inspectBusWorkClaims(root).claims).toEqual([]);
    expect(inboxIds()).toEqual([ID_A, ID_B, REPLY_BLOCKED]);
  });
});
