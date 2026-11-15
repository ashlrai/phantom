/** RQ-PHX-RESULTNOTIFYPROOF334S — the full receipt roundtrip: a real bus
 * request carrying fake Slack channel/thread labels is answered through the
 * actual `fleet work-result` CLI (a blocked dependency, then later
 * verification evidence), and each real board-state change reaches the
 * actual `fleet board-notify` delta entry point as exactly one
 * thread-bound update. An identical reply-id/body replay is a bus
 * 'duplicate' and produces no second update; a sender 'sent' receipt is
 * transport bookkeeping only — it never writes claims, never assigns the
 * item and never mutates the bus; a second independent request keeps its
 * own receipt and its own thread. Delivery is captured only through the
 * injected sender — no real transport ever leaves. */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
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

const ID_A = 'RQ-PHX-FAKE-334-A';
const ID_B = 'RQ-PHX-FAKE-334-B';
const TS_A = 'T0FAKEDT/C0FAKEDT/1700000000.000334';
const TS_B = 'T0FAKEDT/C0FAKEDT/1700000000.000335';
const TTL = 10_000_000;

const slackRequest = (id: string, ref: string): BusEnvelope => ({
  id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: TTL,
  channel: 'slack', channel_ref: ref,
  sender: { agent_id: 'fake-requester', vendor: 'fake-vendor', human: false, team: true },
  external: false,
  body: { kind: 'work' },
});

describe('work-result receipt to thread notification roundtrip', { timeout: 60_000 }, () => {
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
    return { code, result: JSON.parse(output.join('')) as { outcome: string } };
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

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'work-result-notify-334-'));
    dir = mkdtempSync(join(tmpdir(), 'work-result-notify-state-334-'));
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

  it('posts one thread-bound update per real state change and suppresses the replay', async () => {
    postRequest(ID_A, TS_A);
    // First pass only baselines: RECEIVED never notifies.
    let pass = await runNotify();
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({ status: 'baselined', items: 1, planned: 0 });
    expect(slack).not.toHaveBeenCalled();

    // The work-result CLI posts the blocked receipt; the next board pass
    // projects BLOCKED and delivers exactly one update to the source thread.
    now += 60_000;
    const blocked = await workResult('fake-reply-334-blocked', ['--blocked', 'waiting on fake-dep-334']);
    expect(blocked.code).toBe(0);
    expect(blocked.result.outcome).toBe('posted');
    pass = await runNotify();
    expect(pass.code).toBe(0);
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 1, sent: 1, pending: 0 });
    expect(slack).toHaveBeenCalledTimes(1);
    expect(notice(0)).toMatchObject({
      itemId: ID_A, state: 'BLOCKED', sourceChannel: 'slack', sourceThread: TS_A,
    });
    expect(notice(0).text).toContain('waiting on fake-dep-334');
    expect(notice(0).text).toContain(ID_A);
    expect(busSender).not.toHaveBeenCalled();

    // Replaying the identical reply id and body is a bus duplicate: no new
    // envelope, no state change, no second meaningful update.
    const replay = await workResult('fake-reply-334-blocked', ['--blocked', 'waiting on fake-dep-334']);
    expect(replay.code).toBe(0);
    expect(replay.result.outcome).toBe('duplicate');
    pass = await runNotify();
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 0, planned: 0, sent: 0 });
    expect(slack).toHaveBeenCalledTimes(1);

    // Later verification evidence is a real BLOCKED -> VERIFIED change:
    // one completion update, same request identity, same source thread.
    now += 60_000;
    const verified = await workResult('fake-reply-334-verified', ['--pr', '42', '--head', 'fakehead334']);
    expect(verified.code).toBe(0);
    expect(verified.result.outcome).toBe('posted');
    pass = await runNotify();
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 1, sent: 1 });
    expect(slack).toHaveBeenCalledTimes(2);
    expect(notice(1)).toMatchObject({
      itemId: ID_A, state: 'VERIFIED', sourceChannel: 'slack', sourceThread: TS_A,
    });
    expect(notice(1).text).toContain('PR #42');
    expect(notice(1).delta).not.toBe(notice(0).delta);

    // Evidence is not authority: the 'sent' receipts wrote no claims, the
    // item was never ASSIGNED, and the injected sender appended nothing.
    expect(inspectBusWorkClaims(root).claims).toEqual([]);
    const itemA = boardItem(ID_A)!;
    expect(itemA.state).toBe('VERIFIED');
    expect(itemA.owner).toBeNull();
    expect(itemA.claimReceipt).toBeNull();
    expect(inboxIds()).toEqual([ID_A, 'fake-reply-334-blocked', 'fake-reply-334-verified']);
    const sent = readBoardNotifySent(boardNotifyLedgerPath(dir))!;
    for (const state of ['BLOCKED', 'VERIFIED'] as const) {
      expect(sent.has(boardNotifyLedgerKey(ID_A, state))).toBe(true);
      expect([...sent].some(k => k.startsWith(`${ID_A} ${state} `) && k.split(' ').length === 3)).toBe(true);
    }

    // A second independent request does not inherit the first item's
    // receipt: it lists RECEIVED with clean evidence and stays silent.
    postRequest(ID_B, TS_B);
    now += 60_000;
    pass = await runNotify();
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 0, sent: 0 });
    expect(slack).toHaveBeenCalledTimes(2);
    const evidenceB = collectBusWorkItemEvidence(ID_B, { root, now }).evidence;
    expect(evidenceB.verified).toBeUndefined();
    expect(evidenceB.blocker).toBeUndefined();
    expect(boardItem(ID_B)).toMatchObject({ state: 'RECEIVED', owner: null, claimReceipt: null });

    // Its own work-result receipt notifies on its own thread only.
    const replyB = await workResult('fake-reply-334-b-tests', ['--tests', 'fake suite green'], ID_B);
    expect(replyB.code).toBe(0);
    expect(replyB.result.outcome).toBe('posted');
    now += 60_000;
    pass = await runNotify();
    expect(pass.report).toMatchObject({ status: 'completed', transitions: 1, planned: 1, sent: 1 });
    expect(slack).toHaveBeenCalledTimes(3);
    expect(notice(2)).toMatchObject({
      itemId: ID_B, state: 'VERIFIED', sourceChannel: 'slack', sourceThread: TS_B,
    });
    expect(notice(2).text).toContain('fake suite green');
    expect(readBoardNotifySent(boardNotifyLedgerPath(dir))!.has(boardNotifyLedgerKey(ID_B, 'VERIFIED'))).toBe(true);
  });
});
