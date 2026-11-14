/** Board → source-thread notifier: only meaningful state changes post —
 * ASSIGNED with a named owner and claim receipt, BLOCKED naming its
 * dependency, VERIFIED citing a PR, head or test artifact. RUNNING and
 * RECEIVED never post; the durable JSONL ledger makes every
 * (itemId, to-state) pair once-only; a failed send writes nothing. All
 * fixtures are plainly fake and no real message ever leaves a sender:
 * channel senders are injected spies, and the one real transport
 * (postBusReply) lands only in the private tmp bus root. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, listBusInboxAfter, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import {
  appendBoardNotifyLedger, boardNotifyLedgerKey, boardNotifyLedgerPath, boardNotifySnapshotPath,
  boardNoticeText, diffBoard, planNotifications, readBoardNotifySent, readBoardNotifySnapshot,
  sendNotifications, snapshotAfterSend, snapshotBoard, writeBoardNotifySnapshot,
  type BoardNotice, type BoardNotifyLedgerRow, type BoardSnapshotItem, type BoardTransition,
} from '../src/core/fleet/work-board-notify.js';

const TS_A = 'T0FAKEWS/C0FAKECH/1700000000.000001';
const TS_B = 'T0FAKEWS/C0FAKECH/1700000000.000002';
const AT = '2026-11-13T22:00:00.000Z';

const snap = (over: Partial<BoardSnapshotItem>): BoardSnapshotItem => ({
  id: 'req-fake-1', state: 'RECEIVED', asOf: AT, source: 'receivedAt',
  owner: null, claimReceipt: null, channel: 'slack', channelRef: TS_A,
  blocker: null, verified: null, ...over,
});

const transition = (over: Partial<BoardTransition>): BoardTransition => ({
  itemId: 'req-fake-1', from: 'RECEIVED', to: 'ASSIGNED',
  evidence: { asOf: AT, source: 'claim:bus-claim:req-fake-1:4:1700' },
  sourceChannel: 'slack', sourceThread: TS_A, ...over,
});

describe('diffBoard', () => {
  it('emits a transition for a new item and for a state change, none for an unchanged state', () => {
    const received = snap({ id: 'a' });
    expect(diffBoard([], [received])).toHaveLength(1);
    const t = diffBoard([], [received])[0]!;
    expect(t).toMatchObject({ itemId: 'a', from: null, to: 'RECEIVED', sourceChannel: 'slack', sourceThread: TS_A });
    expect(diffBoard([received], [snap({ id: 'a' })])).toEqual([]);
    const blocked = snap({ id: 'a', state: 'BLOCKED', asOf: '2026-11-13T22:05:00.000Z', source: 'bus-reply:rb-1',
      blocker: { dependency: 'fake-dep', source: 'bus-reply:rb-1', at: '2026-11-13T22:05:00.000Z' } });
    const change = diffBoard([received], [blocked]);
    expect(change).toHaveLength(1);
    expect(change[0]).toMatchObject({ itemId: 'a', from: 'RECEIVED', to: 'BLOCKED' });
    expect(change[0]!.evidence.dependency).toBe('fake-dep');
  });

  it('carries owner, claim and verification evidence into the transition', () => {
    const item = snap({ id: 'v', state: 'VERIFIED', source: 'bus-reply:rb-9',
      verified: { pr: 1234, head: 'fakeheadsha', source: 'bus-reply:rb-9', at: AT } });
    const t = diffBoard([], [item])[0]!;
    expect(t.evidence).toMatchObject({ pr: 1234, head: 'fakeheadsha', source: 'bus-reply:rb-9', asOf: AT });
    const assigned = snap({ id: 'w', state: 'ASSIGNED', owner: 'fake-owner', claimReceipt: 'bus-claim:w:4:1' });
    expect(diffBoard([], [assigned])[0]!.evidence).toMatchObject({ owner: 'fake-owner', claimReceipt: 'bus-claim:w:4:1' });
  });
});

describe('planNotifications', () => {
  it('drops ASSIGNED without a durable claim receipt and logs why', () => {
    const log = vi.fn();
    const noReceipt = transition({ evidence: { asOf: AT, source: 'claim:none', owner: 'fake-owner' } });
    const noOwner = transition({ itemId: 'req-fake-2', evidence: { asOf: AT, source: 'claim:x', claimReceipt: 'bus-claim:x:1:1' } });
    const plan = planNotifications([noReceipt, noOwner], new Set(), log);
    expect(plan.notices).toEqual([]);
    expect(plan.dropped).toHaveLength(2);
    expect(plan.dropped[0]!.reason).toBe('ASSIGNED dropped: no durable claim receipt');
    expect(plan.dropped[1]!.reason).toBe('ASSIGNED dropped: no named owner');
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('keeps ASSIGNED with owner and claim receipt, one line naming both', () => {
    const plan = planNotifications([transition({
      evidence: { asOf: AT, source: 'claim:bus-claim:req-fake-1:4:1700', owner: 'fake-owner', claimReceipt: 'bus-claim:req-fake-1:4:1700' },
    })], new Set());
    expect(plan.dropped).toEqual([]);
    expect(plan.notices).toHaveLength(1);
    expect(plan.notices[0]!.text).toBe(`ASSIGNED req-fake-1 as of ${AT} — fake-owner (claim bus-claim:req-fake-1:4:1700) (source: claim:bus-claim:req-fake-1:4:1700)`);
  });

  it('drops BLOCKED without a named dependency and VERIFIED without an artifact', () => {
    const blocked = transition({ to: 'BLOCKED', evidence: { asOf: AT, source: 'bus-reply:rb-1' } });
    const verified = transition({ itemId: 'req-fake-3', to: 'VERIFIED', evidence: { asOf: AT, source: 'bus-reply:rb-3' } });
    const plan = planNotifications([blocked, verified], new Set());
    expect(plan.notices).toEqual([]);
    expect(plan.dropped.map(d => d.reason)).toEqual([
      'BLOCKED dropped: no dependency named', 'VERIFIED dropped: no PR, head or test artifact']);
  });

  it('keeps BLOCKED with a dependency and VERIFIED with each accepted artifact form', () => {
    const blocked = transition({ to: 'BLOCKED', evidence: { asOf: AT, source: 'bus-reply:rb-1', dependency: 'fake-dep-123' } });
    const verified = transition({ itemId: 'req-fake-2', to: 'VERIFIED',
      evidence: { asOf: AT, source: 'bus-reply:rb-2', pr: 4321, head: 'fakeheadsha' } });
    const plan = planNotifications([blocked, verified], new Set());
    expect(plan.notices.map(n => n.text)).toEqual([
      `BLOCKED req-fake-1 as of ${AT} — fake-dep-123 (source: bus-reply:rb-1)`,
      `VERIFIED req-fake-2 as of ${AT} — PR #4321 head fakeheadsha (source: bus-reply:rb-2)`]);
  });

  it('never posts RUNNING or RECEIVED transitions', () => {
    const running = transition({ to: 'RUNNING', evidence: { asOf: AT, source: 'bus-work-claims lease-until x' } });
    const received = transition({ itemId: 'req-fake-4', to: 'RECEIVED', evidence: { asOf: AT, source: 'receivedAt' } });
    const plan = planNotifications([running, received], new Set());
    expect(plan.notices).toEqual([]);
    expect(plan.dropped).toEqual([]);
  });

  it('dedupes (itemId, to-state) against the sent ledger', () => {
    const t = transition({ evidence: { asOf: AT, source: 's', owner: 'o', claimReceipt: 'r' } });
    const sent = new Set([boardNotifyLedgerKey('req-fake-1', 'ASSIGNED')]);
    const plan = planNotifications([t], sent);
    expect(plan.notices).toEqual([]);
    expect(plan.dropped[0]!.reason).toContain('already notified');
  });
});

describe('sendNotifications', () => {
  const notice = (over: Partial<BoardNotice>): BoardNotice => ({
    itemId: 'req-fake-1', state: 'BLOCKED', asOf: AT, delta: 'fake-digest-1', detail: 'fake-dep', source: 'bus-reply:rb-1',
    text: `BLOCKED req-fake-1 as of ${AT} — fake-dep (source: bus-reply:rb-1)`,
    sourceChannel: 'slack', sourceThread: TS_A, ...over,
  });

  it('replies through the sender for the source channel and thread, not another channel', async () => {
    const slack = vi.fn().mockResolvedValue({ status: 'sent', receipt: 'fake-ts-1' });
    const bus = vi.fn().mockResolvedValue({ status: 'sent' });
    const appended: BoardNotifyLedgerRow[] = [];
    const results = await sendNotifications([notice({})], {
      senders: { slack, bus }, appendLedger: row => appended.push(row),
    });
    expect(slack).toHaveBeenCalledTimes(1);
    expect(slack.mock.calls[0]![0]).toMatchObject({ sourceChannel: 'slack', sourceThread: TS_A });
    expect(bus).not.toHaveBeenCalled();
    expect(results[0]!.status).toBe('sent');
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ v: 1, itemId: 'req-fake-1', state: 'BLOCKED', channel: 'slack', thread: TS_A, receipt: 'fake-ts-1' });
  });

  it('reports no-sender for a channel without one and writes no ledger row', async () => {
    const appended: BoardNotifyLedgerRow[] = [];
    const results = await sendNotifications([notice({})], { senders: { bus: vi.fn() }, appendLedger: row => appended.push(row) });
    expect(results[0]!.status).toBe('no-sender');
    expect(appended).toEqual([]);
  });

  it('a failed send does not write the ledger', async () => {
    const appended: BoardNotifyLedgerRow[] = [];
    const refused = vi.fn().mockResolvedValue({ status: 'refused', reason: 'fake-refusal' });
    const threw = vi.fn().mockRejectedValue(new Error('fake-transport-down'));
    const results = await sendNotifications([notice({}), notice({ itemId: 'req-fake-2' })], {
      senders: { slack: refused }, appendLedger: row => appended.push(row),
    });
    expect(results.map(r => r.status)).toEqual(['refused', 'refused']);
    expect(appended).toEqual([]);
    const second = await sendNotifications([notice({})], { senders: { slack: threw }, appendLedger: row => appended.push(row) });
    expect(second[0]!.status).toBe('unavailable');
    expect(appended).toEqual([]);
  });

  it('a duplicate receipt still counts as delivered and is ledgered once', async () => {
    const appended: BoardNotifyLedgerRow[] = [];
    const results = await sendNotifications([notice({})], {
      senders: { slack: vi.fn().mockResolvedValue({ status: 'duplicate', receipt: 'fake-dup-1' }) },
      appendLedger: row => appended.push(row),
    });
    expect(results[0]!.status).toBe('duplicate');
    expect(appended).toHaveLength(1);
  });
});

describe('durable state', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-notify-'));
    chmodSync(dir, 0o700);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a replay posts nothing once the ledger holds the (itemId, state) pair', async () => {
    const ledgerPath = boardNotifyLedgerPath(dir);
    expect(readBoardNotifySent(ledgerPath)).toEqual(new Set());
    const slack = vi.fn().mockResolvedValue({ status: 'sent', receipt: 'fake-ts-1' });
    const t = transition({ to: 'BLOCKED', evidence: { asOf: AT, source: 'bus-reply:rb-1', dependency: 'fake-dep' } });
    const plan = planNotifications([t], readBoardNotifySent(ledgerPath)!);
    expect(plan.notices).toHaveLength(1);
    await sendNotifications(plan.notices, { senders: { slack }, ledgerPath });
    expect(slack).toHaveBeenCalledTimes(1);
    // Second pass over the same transition: deduped, sender untouched.
    const replay = planNotifications([t], readBoardNotifySent(ledgerPath)!);
    expect(replay.notices).toEqual([]);
    expect(replay.dropped[0]!.reason).toContain('already notified');
    const rows = readBoardNotifySent(ledgerPath)!;
    expect(rows.has(boardNotifyLedgerKey('req-fake-1', 'BLOCKED'))).toBe(true);
  });

  it('keeps an undelivered item out of the persisted snapshot so the transition retries', () => {
    const received = snap({ id: 'a', state: 'RECEIVED' });
    const blocked = snap({ id: 'a', state: 'BLOCKED', blocker: { dependency: 'd', source: 's', at: AT } });
    const kept = snapshotAfterSend([received], [blocked], new Set(['a']));
    expect(kept).toEqual([received]);
    // A brand-new item with a failed send is absent again next pass: the
    // null→BLOCKED transition re-fires and the send retries.
    expect(snapshotAfterSend([], [blocked], new Set(['a']))).toEqual([]);
    expect(diffBoard(kept, [blocked])).toHaveLength(1);
  });

  it('round-trips the snapshot and refuses a corrupt file by baselining', () => {
    const items = [snap({ id: 'a' }), snap({ id: 'b', state: 'VERIFIED',
      verified: { pr: 9, head: 'h', source: 's', at: AT } })];
    writeBoardNotifySnapshot(dir, items);
    expect(readBoardNotifySnapshot(dir)).toEqual(items);
    appendBoardNotifyLedger(boardNotifyLedgerPath(dir), { v: 1, at: AT, itemId: 'a', state: 'VERIFIED', channel: 'slack', thread: TS_A, receipt: 'r' });
    writeFileSync(boardNotifySnapshotPath(dir), '{"v":1,"items":[{"id":5}]}');
    expect(readBoardNotifySnapshot(dir)).toBeNull();
  });
});

describe('boardNoticeText', () => {
  it('renders the required one-line shape', () => {
    expect(boardNoticeText('VERIFIED', 'req-fake-9', '2026-11-14T01:00:00.000Z', 'PR #5555', 'bus-reply:rb-1'))
      .toBe('VERIFIED req-fake-9 as of 2026-11-14T01:00:00.000Z — PR #5555 (source: bus-reply:rb-1)');
  });
});

const TTL = 10_000_000;
const slackRequest = (id: string, ref: string): BusEnvelope => ({
  id, from: 'fake-peer-agent', to: 'fake-lane', priority: 'P2', ttl: TTL,
  channel: 'slack', channel_ref: ref,
  sender: { agent_id: 'fake-peer-agent', vendor: 'fake-vendor', human: false, team: true },
  external: false,
  body: { kind: 'slack-coordination', text: 'fake request text' },
});
const busRequest = (id: string): BusEnvelope => ({
  id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: TTL,
  body: { kind: 'work' },
});

describe('cmdFleetBoardNotify on real durable stores', { timeout: 60_000 }, () => {
  let root: string, dir: string, now: number;
  const post = (envelope: BusEnvelope) => expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
  const board = () => snapshotBoard(listWorkBoard({ root, now }), id => collectBusWorkItemEvidence(id, { root, now }).evidence);
  const lastJson = (log: ReturnType<typeof vi.spyOn>) => JSON.parse(String(log.mock.calls.at(-1)![0]));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'board-notify-bus-'));
    dir = mkdtempSync(join(tmpdir(), 'board-notify-state-'));
    chmodSync(root, 0o700);
    chmodSync(dir, 0o700);
    now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('is registered under the convention name', () => {
    expect(resolveFleetSubcommand('board-notify')).toEqual(
      { module: './fleet-board-notify.js', exportName: 'cmdFleetBoardNotify' });
  });

  it('baselines the first live pass, then posts a BLOCKED reply into the slack source thread only', async () => {
    post(slackRequest('slack-order-1', TS_A));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const slack = vi.fn().mockResolvedValue({ status: 'sent', receipt: 'fake-ts-9' });
    expect(await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'], { senders: { slack }, now: () => now })).toBe(0);
    expect(lastJson(log)).toMatchObject({ status: 'baselined', items: 1 });
    expect(slack).not.toHaveBeenCalled();

    now += 60_000;
    expect(postBusReply('slack-order-1', 'fake-blocked-reply', { blocked: { dependency: 'fake-dep-123' } },
      { root, now: () => now }).outcome).toBe('posted');
    const item = board().find(i => i.id === 'slack-order-1')!;
    expect(item.state).toBe('BLOCKED');
    expect(item.blocker?.dependency).toBe('fake-dep-123');

    expect(await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'], { senders: { slack }, now: () => now })).toBe(0);
    expect(lastJson(log)).toMatchObject({ status: 'completed', planned: 1, sent: 1, pending: 0 });
    expect(slack).toHaveBeenCalledTimes(1);
    const notice = slack.mock.calls[0]![0] as BoardNotice;
    expect(notice.sourceChannel).toBe('slack');
    expect(notice.sourceThread).toBe(TS_A);
    expect(notice.text).toBe(`BLOCKED slack-order-1 as of ${new Date(now).toISOString()} — fake-dep-123 (source: bus-reply:fake-blocked-reply)`);

    // Third pass: no transition, nothing sent.
    expect(await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'], { senders: { slack }, now: () => now })).toBe(0);
    expect(lastJson(log)).toMatchObject({ status: 'completed', transitions: 0, planned: 0, sent: 0 });
    expect(slack).toHaveBeenCalledTimes(1);
  });

  it('posts ASSIGNED in the bus source thread through the real bus reply sender, once', async () => {
    post(busRequest('bus-order-2'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'], { now: () => now })).toBe(0);
    const acquired = mutateBusWorkClaim({ action: 'acquire', id: 'bus-order-2', owner: 'fake-owner', leaseMs: 600_000, root });
    expect(acquired.status).toBe('acquired');
    const completed = mutateBusWorkClaim({ action: 'complete', id: 'bus-order-2', token: acquired.token!, root });
    expect(completed.status).toBe('completed');
    expect(board().find(i => i.id === 'bus-order-2')!.state).toBe('ASSIGNED');

    expect(await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'], { now: () => now })).toBe(0);
    expect(lastJson(log)).toMatchObject({ status: 'completed', planned: 1, sent: 1 });
    // The reply is a real durable bus envelope in-reply-to the request.
    const page = listBusInboxAfter(0, 100, { root, now: () => 0 });
    const reply = page.status === 'ok'
      ? page.messages.find(m => (m.envelope.body as Record<string, unknown>)?.['inReplyTo'] === 'bus-order-2')
      : undefined;
    expect(reply).toBeDefined();
    expect((reply!.envelope.body as Record<string, unknown>)['kind']).toBe('work-board-notify');
    expect(readBoardNotifySent(boardNotifyLedgerPath(dir))!.has(boardNotifyLedgerKey('bus-order-2', 'ASSIGNED'))).toBe(true);

    // Replay: ledger dedupes even if the transition somehow reappears.
    expect(await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'], { now: () => now })).toBe(0);
    expect(lastJson(log)).toMatchObject({ transitions: 0, planned: 0 });
  });

  it('halts sends under KILL without advancing the snapshot, and --dry-run sends and writes nothing', async () => {
    post(slackRequest('slack-order-3', TS_B));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const slack = vi.fn().mockResolvedValue({ status: 'sent', receipt: 'fake-ts-kill' });
    // Dry-run before any snapshot shows the plan but leaves no state.
    expect(await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--dry-run', '--json'], { senders: { slack }, now: () => now })).toBe(0);
    expect(lastJson(log)).toMatchObject({ status: 'dry-run', baselined: true });
    expect(readBoardNotifySnapshot(dir)).toBeNull();
    expect(slack).not.toHaveBeenCalled();

    // Baseline, then a change while KILL is armed: halted, snapshot kept.
    expect(await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'], { senders: { slack }, now: () => now })).toBe(0);
    now += 60_000;
    expect(postBusReply('slack-order-3', 'fake-blocked-2', { blocked: { dependency: 'fake-dep-9' } }, { root, now: () => now }).outcome).toBe('posted');
    expect(await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'], { senders: { slack }, now: () => now, killed: true })).toBe(0);
    expect(lastJson(log)).toMatchObject({ status: 'halted', planned: 1 });
    expect(slack).not.toHaveBeenCalled();
    // The transition was not consumed: the next unhalted pass still posts it.
    expect(await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'], { senders: { slack }, now: () => now })).toBe(0);
    expect(lastJson(log)).toMatchObject({ status: 'completed', planned: 1, sent: 1 });
    expect(slack).toHaveBeenCalledTimes(1);
  });

  it('exits 2 on bad flags and prints nothing on stdout', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdFleetBoardNotify(['--bogus'])).toBe(2);
    expect(await cmdFleetBoardNotify(['--root', 'relative/path'])).toBe(2);
    expect(await cmdFleetBoardNotify(['--dry-run', '--dry-run'])).toBe(2);
    expect(await cmdFleetBoardNotify(['--limit', '0'])).toBe(2);
    expect(log).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });
});
