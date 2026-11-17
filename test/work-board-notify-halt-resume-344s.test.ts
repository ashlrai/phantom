/** RQ-PHX-NOTIFYKILLRESUME344S — board-notify across a deliberate KILL halt.
 * A fake Slack work request is baselined, then real `fleet work-result`
 * receipts (BLOCKED, later VERIFIED) land while the injected `killed`
 * dependency is armed. Halted and dry-run passes must leave every byte of
 * the state dir and bus root unchanged, including the absence of a ledger
 * that does not exist yet. After resume, the missed change is delivered
 * exactly once to its original thread with its evidence, a sender failure
 * right after resume leaves no durable receipt, and recovery delivers it
 * once. A second unrelated request never receives the notice. Dependencies
 * are recreated for each pass to simulate restarts. Only the clock and the
 * injected senders are fake; no real transport, no sleeps. */
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { cmdFleetWorkResult } from '../src/cli/fleet-work-result.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { inspectBusWorkClaims } from '../src/core/fleet/bus-work-claims.js';
import {
  boardNotifyLedgerPath, readBoardNotifySnapshot,
  type BoardNotice, type BoardNotifySender,
} from '../src/core/fleet/work-board-notify.js';

const ID_A = 'RQ-PHX-FAKE-NK344-A';
const ID_B = 'RQ-PHX-FAKE-NK344-B';
const TS_A = 'T0FAKEDT/C0FAKEDT/1700000000.000344';
const TS_B = 'T0FAKEDT/C0FAKEDT/1700000000.000345';
const DEP = 'waiting on fake-dep-nk344';
const TTL = 10_000_000;

const slackRequest = (id: string, ref: string): BusEnvelope => ({
  id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: TTL,
  channel: 'slack', channel_ref: ref,
  sender: { agent_id: 'fake-requester', vendor: 'fake-vendor', human: false, team: true },
  external: false,
  body: { kind: 'work' },
});
const okSender: BoardNotifySender = notice => ({ status: 'sent', receipt: `fake-slack-${notice.state}` });
const downSender: BoardNotifySender = () => ({ status: 'unavailable', reason: 'fake-transport-down' });

/** Every file under `base` as exact bytes (latin1 keeps bytes 1:1). */
const tree = (base: string): Record<string, string> => Object.fromEntries(
  (readdirSync(base, { recursive: true }) as string[])
    .filter(rel => statSync(join(base, rel)).isFile())
    .sort()
    .map(rel => [rel, readFileSync(join(base, rel)).toString('latin1')]));

describe('board-notify across a KILL halt', { timeout: 60_000 }, () => {
  let root: string, dir: string, now: number;
  let log: ReturnType<typeof vi.spyOn>;
  let busSender: Mock<BoardNotifySender>;

  const postRequest = (id: string, ref: string) =>
    expect(appendBusInbox(slackRequest(id, ref), { root, now: () => now }).status).toBe('posted');
  const workResult = async (replyId: string, extra: string[], requestId = ID_A) => {
    const output: string[] = [];
    const code = await cmdFleetWorkResult(
      ['--request-id', requestId, '--reply-id', replyId, '--root', root, ...extra],
      { now: () => now }, { output: text => output.push(text) });
    return { code, result: JSON.parse(output.join('')) as { outcome: string } };
  };
  /** Fresh senders per pass: each call is a simulated process restart. */
  const run = async (opts: { killed?: boolean; dryRun?: boolean; sender?: BoardNotifySender } = {}) => {
    const slack = vi.fn<BoardNotifySender>(opts.sender ?? okSender);
    const code = await cmdFleetBoardNotify(
      ['--root', root, '--state-dir', dir, ...(opts.dryRun ? ['--dry-run'] : []), '--json'],
      { senders: { slack, bus: busSender }, now: () => now, killed: opts.killed ?? false });
    return { code, report: JSON.parse(String(log.mock.calls.at(-1)![0])) as Record<string, unknown>, slack };
  };
  const boardItem = (id: string) => listWorkBoard({ root, now }).items.find(i => i.id === id);
  const inboxIds = () => {
    const page = listBusInboxAfter(0, 100, { root, now: () => now });
    return page.status === 'ok' ? page.messages.map(m => m.envelope.id) : [];
  };
  const ledger = () => boardNotifyLedgerPath(dir);
  const ledgerRows = () => readFileSync(ledger(), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { itemId: string; state: string; thread: string | null; receipt: string | null; delta?: string });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'notify-halt-root-344-'));
    dir = mkdtempSync(join(tmpdir(), 'notify-halt-state-344-'));
    chmodSync(root, 0o700);
    chmodSync(dir, 0o700);
    now = Date.now();
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    busSender = vi.fn<BoardNotifySender>();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('holds the missed BLOCKED and VERIFIED changes under KILL, then delivers each once after resume', async () => {
    // Baseline the fake Slack request: snapshot only, no ledger yet.
    postRequest(ID_A, TS_A);
    let pass = await run();
    expect(pass.report).toMatchObject({ status: 'baselined' });
    expect(existsSync(ledger())).toBe(false);
    const baselineState = tree(dir);
    expect(Object.keys(baselineState)).toEqual(['snapshot.json']);

    // A real BLOCKED receipt lands; the board now holds an unsent change.
    now += 60_000;
    const blocked = await workResult('fake-reply-nk344-blocked', ['--blocked', DEP]);
    expect(blocked).toMatchObject({ code: 0, result: { outcome: 'posted' } });
    const busBeforeHalt = tree(root);

    // KILL armed: the pass halts, sends nothing, and writes nothing.
    pass = await run({ killed: true });
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({ status: 'halted', planned: 1 });
    expect(pass.report.lines).toEqual([expect.stringContaining('sends halted')]);
    expect(pass.slack).not.toHaveBeenCalled();
    expect(tree(dir)).toEqual(baselineState);
    expect(existsSync(ledger())).toBe(false);
    expect(tree(root)).toEqual(busBeforeHalt);

    // Dry-run during the halt prints the plan and stays read-only.
    pass = await run({ killed: true, dryRun: true });
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({ status: 'dry-run', killed: true, baselined: false, planned: 1 });
    expect(pass.report.lines).toEqual(expect.arrayContaining([expect.stringContaining('(KILL armed)')]));
    expect(pass.report.lines).toEqual(expect.arrayContaining([expect.stringContaining('would-post [slack')]));
    expect(pass.slack).not.toHaveBeenCalled();
    expect(tree(dir)).toEqual(baselineState);
    expect(tree(root)).toEqual(busBeforeHalt);

    // The durable bus result is still there, and the board still shows BLOCKED.
    expect(inboxIds()).toContain('fake-reply-nk344-blocked');
    expect(boardItem(ID_A)).toMatchObject({ state: 'BLOCKED', owner: null, claimReceipt: null });

    // Resume, but the transport is down immediately: nothing is ledgered
    // and the item stays pending instead of being consumed.
    pass = await run({ sender: downSender });
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 1, sent: 0, pending: 1 });
    expect(pass.slack).toHaveBeenCalledTimes(1);
    expect(existsSync(ledger())).toBe(false);
    expect(readBoardNotifySnapshot(dir)).toEqual([expect.objectContaining({ id: ID_A, state: 'RECEIVED' })]);

    // Recovery: the same missed change is delivered once, to its own thread,
    // carrying the blocker evidence, with a durable receipt in the ledger.
    pass = await run();
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 1, sent: 1, pending: 0 });
    expect(pass.slack).toHaveBeenCalledTimes(1);
    const blockedNotice = pass.slack.mock.calls[0]![0] as BoardNotice;
    expect(blockedNotice).toMatchObject({ itemId: ID_A, state: 'BLOCKED', sourceChannel: 'slack', sourceThread: TS_A });
    expect(blockedNotice.text).toContain(DEP);
    expect(blockedNotice.text).toContain(ID_A);
    expect(ledgerRows()).toEqual([expect.objectContaining({
      itemId: ID_A, state: 'BLOCKED', thread: TS_A, receipt: 'fake-slack-BLOCKED', delta: blockedNotice.delta,
    })]);

    // Replay after the recovery sends nothing.
    pass = await run();
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 0, planned: 0, sent: 0 });
    expect(pass.slack).not.toHaveBeenCalled();

    // A second, unrelated request arrives and is baselined as RECEIVED: silent.
    postRequest(ID_B, TS_B);
    pass = await run();
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 0, sent: 0 });
    expect(pass.slack).not.toHaveBeenCalled();
    expect(boardItem(ID_B)).toMatchObject({ state: 'RECEIVED', owner: null, claimReceipt: null });

    // Later verification evidence lands while KILL is armed again. The ledger
    // now exists, so the halt must preserve its bytes too.
    now += 60_000;
    const verified = await workResult('fake-reply-nk344-verified', ['--pr', '42', '--head', 'fakehead344']);
    expect(verified).toMatchObject({ code: 0, result: { outcome: 'posted' } });
    const stateBeforeSecondHalt = tree(dir);
    const busBeforeSecondHalt = tree(root);
    expect(Object.keys(stateBeforeSecondHalt)).toEqual(['sent.jsonl', 'snapshot.json']);

    pass = await run({ killed: true });
    expect(pass.report).toMatchObject({ status: 'halted', planned: 1 });
    expect(pass.slack).not.toHaveBeenCalled();
    expect(tree(dir)).toEqual(stateBeforeSecondHalt);
    expect(tree(root)).toEqual(busBeforeSecondHalt);

    // Resume: exactly one VERIFIED notice reaches only the original thread.
    pass = await run();
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 1, sent: 1, pending: 0 });
    expect(pass.slack).toHaveBeenCalledTimes(1);
    const verifiedNotice = pass.slack.mock.calls[0]![0] as BoardNotice;
    expect(verifiedNotice).toMatchObject({ itemId: ID_A, state: 'VERIFIED', sourceThread: TS_A });
    expect(verifiedNotice.text).toContain('PR #42');
    expect(verifiedNotice.delta).not.toBe(blockedNotice.delta);
    expect(ledgerRows().map(r => [r.itemId, r.state, r.thread])).toEqual([
      [ID_A, 'BLOCKED', TS_A], [ID_A, 'VERIFIED', TS_A],
    ]);

    // A second pass after the resume sends nothing.
    pass = await run();
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 0, planned: 0, sent: 0 });
    expect(pass.slack).not.toHaveBeenCalled();

    // Across the whole scenario: no notice ever reached the unrelated thread,
    // no claim was created or completed, and the bus results are intact.
    const ledgerIds = new Set(ledgerRows().map(r => r.itemId));
    expect(ledgerIds).toEqual(new Set([ID_A]));
    expect(ledgerRows().some(r => r.thread === TS_B)).toBe(false);
    expect(inspectBusWorkClaims(root).claims).toEqual([]);
    expect(boardItem(ID_A)).toMatchObject({ state: 'VERIFIED', owner: null, claimReceipt: null });
    expect(boardItem(ID_B)).toMatchObject({ state: 'RECEIVED', owner: null, claimReceipt: null });
    expect(inboxIds()).toEqual(expect.arrayContaining([
      ID_A, ID_B, 'fake-reply-nk344-blocked', 'fake-reply-nk344-verified',
    ]));
    expect(busSender).not.toHaveBeenCalled();
    expect(readBoardNotifySnapshot(dir)?.find(i => i.id === ID_B)).toMatchObject({ state: 'RECEIVED' });
  });
});
