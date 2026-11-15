/** RQ-PHX-RESULTIDCONFLICTPROOF341S — receipt-backed truthful
 * same-thread coordination: reusing an existing result reply id with
 * changed evidence must not rewrite a previously reported outcome or
 * notify another task thread. Two real bus requests carry fake Slack
 * channel/thread labels; a BLOCKED result for A is posted through the
 * actual `fleet work-result` CLI and reaches the actual
 * `fleet board-notify` delta entry point once. Replaying that reply id
 * with a different blocker, with VERIFIED evidence, or against request
 * B is refused by the durable store as a conflict: nonzero exit, the
 * stored receipt/cursor/receivedAt/body byte-identical, board evidence
 * for A and B unchanged, and no second or cross-thread notification.
 * The exact original retry is then a bus 'duplicate' with no timestamp
 * refresh, and a genuinely new reply id for B posts cleanly and
 * notifies exactly B's thread — recovery, not permanent failure. A
 * sender 'sent' receipt is transport bookkeeping only: it never writes
 * claims, never assigns the item and never mutates the bus. Delivery is
 * captured only through the injected senders — no real transport ever
 * leaves. */
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  boardNotifyLedgerKey, boardNotifyLedgerPath, readBoardNotifySent,
  type BoardNotice,
} from '../src/core/fleet/work-board-notify.js';

const ID_A = 'RQ-PHX-FAKE-341-A';
const ID_B = 'RQ-PHX-FAKE-341-B';
const TS_A = 'T0FAKEDT/C0FAKEDT/1700000000.000341';
const TS_B = 'T0FAKEDT/C0FAKEDT/1700000000.000342';
const REPLY_A = 'fake-reply-341-a-blocked';
const REPLY_B = 'fake-reply-341-b-verified';
const DEP = 'waiting on fake-dep-341';
const DEP_ALT = 'fake-dep-341-other';
const TTL = 10_000_000;

const slackRequest = (id: string, ref: string): BusEnvelope => ({
  id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: TTL,
  channel: 'slack', channel_ref: ref,
  sender: { agent_id: 'fake-requester', vendor: 'fake-vendor', human: false, team: true },
  external: false,
  body: { kind: 'work' },
});

describe('work-result reply-id conflict roundtrip', { timeout: 60_000 }, () => {
  let root: string, dir: string, now: number;
  let log: ReturnType<typeof vi.spyOn>;
  let slack: ReturnType<typeof vi.fn>;
  let busSender: ReturnType<typeof vi.fn>;

  const postRequest = (id: string, ref: string) =>
    expect(appendBusInbox(slackRequest(id, ref), { root, now: () => now }).status).toBe('posted');
  const workResult = async (replyId: string, extra: string[], requestId = ID_A) => {
    const output: string[] = [];
    const code = await cmdFleetWorkResult(
      ['--request-id', requestId, '--reply-id', replyId, '--root', root, ...extra],
      { now: () => now }, { output: text => output.push(text) });
    return { code, result: JSON.parse(output.join('')) as { outcome: string; transport: string | null } };
  };
  const runNotify = async () => {
    const code = await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'],
      { senders: { slack, bus: busSender }, now: () => now, killed: false });
    return { code, report: JSON.parse(String(log.mock.calls.at(-1)![0])) as Record<string, unknown> };
  };
  const boardItem = (id: string) => listWorkBoard({ root, now }).items.find(i => i.id === id);
  const inboxIds = () => {
    const page = listBusInboxAfter(0, 100, { root, now: () => now });
    return page.status === 'ok' ? page.messages.map(m => m.envelope.id) : [];
  };
  const notice = (call: number) => slack.mock.calls[call]![0] as BoardNotice;
  const inboxFile = () => join(root, 'bus-inbox', 'messages.json');
  const inboxSnapshot = () => readFileSync(inboxFile(), 'utf8');
  interface StoredRow { cursor: number; receivedAt: number; envelope: { id: string } }
  const storedRows = () => (JSON.parse(inboxSnapshot()) as { rows: StoredRow[] }).rows;
  const replyRow = () => storedRows().find(row => row.envelope.id === REPLY_A);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'work-result-conflict-341-'));
    dir = mkdtempSync(join(tmpdir(), 'work-result-conflict-state-341-'));
    chmodSync(root, 0o700);
    chmodSync(dir, 0o700);
    now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    slack = vi.fn().mockImplementation(async () => ({ status: 'sent' as const, receipt: `fake-ts-${slack.mock.calls.length}` }));
    busSender = vi.fn();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses conflicting reply-id reuse without rewriting the receipt or leaking threads', async () => {
    // Two independent fake Slack requests in different threads; the first
    // pass only baselines — RECEIVED never notifies.
    postRequest(ID_A, TS_A);
    postRequest(ID_B, TS_B);
    let pass = await runNotify();
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({ status: 'baselined', items: 2, planned: 0 });
    expect(slack).not.toHaveBeenCalled();

    // The work-result CLI posts A's blocked receipt; the next board pass
    // projects BLOCKED and delivers exactly one update to A's thread.
    now += 60_000;
    const blocked = await workResult(REPLY_A, ['--blocked', DEP]);
    expect(blocked.code).toBe(0);
    expect(blocked.result.outcome).toBe('posted');
    pass = await runNotify();
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 1, sent: 1, pending: 0 });
    expect(slack).toHaveBeenCalledTimes(1);
    expect(notice(0)).toMatchObject({
      itemId: ID_A, state: 'BLOCKED', sourceChannel: 'slack', sourceThread: TS_A,
    });
    expect(notice(0).text).toContain(DEP);
    expect(busSender).not.toHaveBeenCalled();

    // Freeze the durable truth: the whole snapshot bytes plus the exact
    // stored row (cursor, receivedAt, envelope) for the posted reply.
    const snapshot = inboxSnapshot();
    const originalReply = replyRow();
    expect(originalReply).toBeDefined();
    const evidenceA = collectBusWorkItemEvidence(ID_A, { root, now }).evidence;
    const evidenceB = collectBusWorkItemEvidence(ID_B, { root, now }).evidence;

    // Conflicting reuse, same request: a different blocker and then
    // VERIFIED evidence under the already-spent reply id are both
    // refused by the store as conflicts — nonzero exit, no rewrite.
    for (const extra of [['--blocked', DEP_ALT], ['--pr', '42', '--head', 'fakehead341']]) {
      now += 60_000;
      const conflict = await workResult(REPLY_A, extra);
      expect(conflict.code).toBe(4);
      expect(conflict.result).toMatchObject({ outcome: 'transport-refused', transport: 'conflict' });
      expect(inboxSnapshot()).toBe(snapshot);
      expect(replyRow()).toEqual(originalReply);
    }

    // Cross-task reuse: the same reply id aimed at request B cannot
    // borrow A's receipt — inReplyTo differs, so the store refuses it
    // too and nothing reaches B's thread.
    now += 60_000;
    const crossTask = await workResult(REPLY_A, ['--tests', 'fake suite green'], ID_B);
    expect(crossTask.code).toBe(4);
    expect(crossTask.result).toMatchObject({ outcome: 'transport-refused', transport: 'conflict' });
    expect(inboxSnapshot()).toBe(snapshot);
    expect(replyRow()).toEqual(originalReply);

    // No state change, no second or foreign notification: the board
    // still reports A BLOCKED on the original dependency and B clean.
    pass = await runNotify();
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 0, planned: 0, sent: 0 });
    expect(slack).toHaveBeenCalledTimes(1);
    expect(boardItem(ID_A)).toMatchObject({ state: 'BLOCKED', owner: null, claimReceipt: null });
    expect(boardItem(ID_A)!.result).toEqual({ kind: 'blocked', dependency: DEP });
    expect(boardItem(ID_B)).toMatchObject({ state: 'RECEIVED', owner: null, claimReceipt: null });
    const afterA = collectBusWorkItemEvidence(ID_A, { root, now }).evidence;
    const afterB = collectBusWorkItemEvidence(ID_B, { root, now }).evidence;
    expect(afterA.blocker).toEqual(evidenceA.blocker);
    expect(afterA.verified).toEqual(evidenceA.verified);
    expect(afterB.blocker).toEqual(evidenceB.blocker);
    expect(afterB.verified).toEqual(evidenceB.verified);

    // The exact original retry is a duplicate: same receipt, same
    // cursor, same receivedAt — the snapshot bytes never move, so no
    // timestamp or TTL refresh happened and no second notice posts.
    now += 60_000;
    const replay = await workResult(REPLY_A, ['--blocked', DEP]);
    expect(replay.code).toBe(0);
    expect(replay.result.outcome).toBe('duplicate');
    expect(inboxSnapshot()).toBe(snapshot);
    expect(replyRow()).toEqual(originalReply);
    pass = await runNotify();
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 0, planned: 0, sent: 0 });
    expect(slack).toHaveBeenCalledTimes(1);

    // A genuinely new reply id with valid evidence for B is a real
    // post: B alone transitions to VERIFIED and only B's thread hears.
    now += 60_000;
    const replyB = await workResult(REPLY_B, ['--tests', 'fake suite green'], ID_B);
    expect(replyB.code).toBe(0);
    expect(replyB.result.outcome).toBe('posted');
    pass = await runNotify();
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 1, sent: 1 });
    expect(slack).toHaveBeenCalledTimes(2);
    expect(notice(1)).toMatchObject({
      itemId: ID_B, state: 'VERIFIED', sourceChannel: 'slack', sourceThread: TS_B,
    });
    expect(notice(1).text).toContain('fake suite green');
    expect(notice(1).sourceThread).not.toBe(TS_A);
    // Every delivered notice stayed on its own request's thread.
    expect(notice(0).itemId).toBe(ID_A);
    expect(notice(0).sourceThread).toBe(TS_A);
    expect(boardItem(ID_A)).toMatchObject({ state: 'BLOCKED', owner: null, claimReceipt: null });

    // Evidence is not authority: the 'sent' receipts wrote no claims,
    // neither item was ever ASSIGNED, and the injected senders appended
    // nothing to the bus — the reply ids above are the only new rows.
    expect(inspectBusWorkClaims(root).claims).toEqual([]);
    expect(boardItem(ID_B)).toMatchObject({ state: 'VERIFIED', owner: null, claimReceipt: null });
    expect(inboxIds()).toEqual([ID_A, ID_B, REPLY_A, REPLY_B]);
    const sent = readBoardNotifySent(boardNotifyLedgerPath(dir))!;
    for (const [id, state] of [[ID_A, 'BLOCKED'], [ID_B, 'VERIFIED']] as const) {
      expect(sent.has(boardNotifyLedgerKey(id, state))).toBe(true);
      expect([...sent].some(k => k.startsWith(`${id} ${state} `) && k.split(' ').length === 3)).toBe(true);
    }
  });
});
