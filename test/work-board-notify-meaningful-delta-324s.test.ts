/** Meaningful-delta notifier: a work item whose state label stays the
 * same still reaches its source thread when the evidence that matters
 * moves — a BLOCKED dependency change, an ASSIGNED owner/claim change,
 * a VERIFIED PR/head/tests/artifact change, or a channel/thread reroute.
 * asOf-only and irrelevant-field churn produces nothing. Dedupe is
 * durable: every ledger row keeps the (itemId, state) entry key, delta
 * rows add their (itemId, state, delta) key, and legacy rows without a
 * delta fence state entries conservatively without blocking provably-new
 * same-state deltas. Fixtures are fake; sends go to injected spies or
 * the private tmp bus root — no real transport ever leaves. */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, listBusInboxAfter, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import {
  appendBoardNotifyLedger, boardNotifyDeltaDigest, boardNotifyDeltaMaterial, boardNotifyLedgerKey,
  boardNotifyLedgerPath, diffBoard, planNotifications, readBoardNotifySent, sendNotifications,
  type BoardNotice, type BoardSnapshotItem, type BoardTransition,
} from '../src/core/fleet/work-board-notify.js';

const TS_A = 'T0FAKEDT/C0FAKEDT/1700000000.000324';
const TS_B = 'T0FAKEDT/C0FAKEDT/1700000000.000325';
const AT = '2026-11-13T22:30:00.000Z';
const AT2 = '2026-11-13T22:45:00.000Z';

const snap = (over: Partial<BoardSnapshotItem>): BoardSnapshotItem => ({
  id: 'req-delta-1', state: 'RECEIVED', asOf: AT, source: 'receivedAt',
  owner: null, claimReceipt: null, channel: 'slack', channelRef: TS_A,
  blocker: null, verified: null, ...over,
});
const blocked = (dependency: string, over: Partial<BoardSnapshotItem> = {}): BoardSnapshotItem => snap({
  state: 'BLOCKED', asOf: AT2, source: 'bus-reply:rb-delta',
  blocker: { dependency, source: 'bus-reply:rb-delta', at: AT2 }, ...over,
});
const transition = (over: Partial<BoardTransition> = {}): BoardTransition => ({
  itemId: 'req-delta-1', from: 'BLOCKED', to: 'BLOCKED',
  evidence: { asOf: AT, source: 'bus-reply:rb-delta', dependency: 'dep-alpha' },
  sourceChannel: 'slack', sourceThread: TS_A, ...over,
});

describe('diffBoard meaningful deltas', () => {
  it('emits same-state transitions only when the meaningful delta moves', () => {
    const changes = diffBoard([blocked('dep-alpha')], [blocked('dep-beta')]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: 'BLOCKED', to: 'BLOCKED' });
    expect(changes[0]!.evidence.dependency).toBe('dep-beta');
    // asOf/source/whitespace-only churn and silent states stay quiet.
    expect(diffBoard([blocked('dep-alpha')], [blocked('dep-alpha', { asOf: AT2, source: 'bus-reply:rb-other' })])).toEqual([]);
    expect(diffBoard([blocked('dep-alpha')], [blocked('  dep-alpha  ')])).toEqual([]);
    const running = snap({ state: 'RUNNING', asOf: AT });
    expect(diffBoard([running], [snap({ state: 'RUNNING', asOf: AT2 })])).toEqual([]);
  });

  it('covers owner/claim, verified artifact and reroute changes', () => {
    const assigned = snap({ state: 'ASSIGNED', owner: 'fake-owner', claimReceipt: 'bus-claim:x:1:1' });
    expect(diffBoard([assigned], [snap({ state: 'ASSIGNED', owner: 'fake-owner', claimReceipt: 'bus-claim:x:1:2' })])).toHaveLength(1);
    expect(diffBoard([assigned], [snap({ state: 'ASSIGNED', owner: 'other-owner', claimReceipt: 'bus-claim:x:1:1' })])).toHaveLength(1);
    const verified = snap({ state: 'VERIFIED', verified: { pr: 1, head: 'h1', source: 'bus-reply:r', at: AT } });
    expect(diffBoard([verified], [snap({ state: 'VERIFIED', verified: { pr: 1, head: 'h2', source: 'bus-reply:r', at: AT } })])).toHaveLength(1);
    expect(diffBoard([verified], [snap({ state: 'VERIFIED', verified: { pr: 1, head: 'h1', tests: 't', source: 'bus-reply:r', at: AT } })])).toHaveLength(1);
    // Same evidence routed to a different thread is a new identity.
    expect(diffBoard([blocked('dep-alpha')], [blocked('dep-alpha', { channelRef: TS_B })])).toHaveLength(1);
  });
});

describe('planNotifications delta dedupe', () => {
  it('posts each distinct meaningful delta once and dedupes repeats', () => {
    const depA = transition();
    const depB = transition({ evidence: { asOf: AT2, source: 'bus-reply:rb-delta2', dependency: 'dep-beta' } });
    const plan1 = planNotifications([depA], new Set());
    expect(plan1.notices).toHaveLength(1);
    const sentA = new Set([boardNotifyLedgerKey('req-delta-1', 'BLOCKED', plan1.notices[0]!.delta)]);
    const plan2 = planNotifications([depA, depB], sentA);
    expect(plan2.notices).toHaveLength(1);
    expect(plan2.notices[0]!.detail).toBe('dep-beta');
    expect(plan2.notices[0]!.delta).not.toBe(plan1.notices[0]!.delta);
    expect(plan2.dropped[0]!.reason).toContain('already notified');
    // Returning to dep-alpha dedupes against its own delta key.
    const plan3 = planNotifications([depA], new Set([
      boardNotifyLedgerKey('req-delta-1', 'BLOCKED'),
      boardNotifyLedgerKey('req-delta-1', 'BLOCKED', plan1.notices[0]!.delta),
      boardNotifyLedgerKey('req-delta-1', 'BLOCKED', plan2.notices[0]!.delta),
    ]));
    expect(plan3.notices).toEqual([]);
  });

  it('keeps state entries once-only while same-state deltas ignore the entry key', () => {
    const legacy = new Set([boardNotifyLedgerKey('req-delta-1', 'BLOCKED')]);
    // A state entry is fenced by any prior row, legacy included.
    expect(planNotifications([transition({ from: 'RECEIVED' })], legacy).notices).toEqual([]);
    // A same-state delta is provably new against the snapshot: the legacy
    // row cannot have recorded this delta, so it does not block.
    const plan = planNotifications([transition()], legacy);
    expect(plan.notices).toHaveLength(1);
    expect(plan.notices[0]!.delta).toMatch(/^[0-9a-f]{24}$/);
  });

  it('distinguishes owner/claim and verified-artifact identities', () => {
    const mk = (evidence: BoardTransition['evidence'], to: BoardTransition['to']): BoardTransition =>
      transition({ from: to, to, evidence: { asOf: AT, source: 's', ...evidence } });
    const deltas = (...ts: BoardTransition[]) => ts.map(t => planNotifications([t], new Set()).notices[0]!.delta);
    const [ownerA, ownerB, claimB] = deltas(
      mk({ owner: 'o-a', claimReceipt: 'c-1' }, 'ASSIGNED'),
      mk({ owner: 'o-b', claimReceipt: 'c-1' }, 'ASSIGNED'),
      mk({ owner: 'o-a', claimReceipt: 'c-2' }, 'ASSIGNED'));
    expect(new Set([ownerA, ownerB, claimB]).size).toBe(3);
    const [v1, v2, v3, v4] = deltas(
      mk({ pr: 7, head: 'h1' }, 'VERIFIED'), mk({ pr: 7, head: 'h2' }, 'VERIFIED'),
      mk({ pr: 8, head: 'h1' }, 'VERIFIED'), mk({ tests: 'suite-x' }, 'VERIFIED'));
    expect(new Set([v1, v2, v3, v4]).size).toBe(4);
    // asOf/source churn on identical evidence is the same delta.
    const repeat = { ...mk({ pr: 7, head: 'h1' }, 'VERIFIED'), evidence: { asOf: AT2, source: 'other', pr: 7, head: 'h1' } };
    expect(planNotifications([repeat], new Set([boardNotifyLedgerKey('req-delta-1', 'VERIFIED', v1)])).notices).toEqual([]);
  });
});

describe('durable delta ledger', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'board-notify-delta-'));
    chmodSync(dir, 0o700);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads legacy rows conservatively and records delta digests once-only', async () => {
    const ledgerPath = boardNotifyLedgerPath(dir);
    appendBoardNotifyLedger(ledgerPath, { v: 1, at: AT, itemId: 'req-legacy', state: 'BLOCKED', channel: 'slack', thread: TS_A, receipt: 'r-1' });
    expect(readBoardNotifySent(ledgerPath)).toEqual(new Set([boardNotifyLedgerKey('req-legacy', 'BLOCKED')]));

    const notice = (delta: string): BoardNotice => ({
      itemId: 'req-delta-1', state: 'BLOCKED', asOf: AT, delta, detail: 'dep', source: 'bus-reply:r',
      text: `BLOCKED req-delta-1 as of ${AT} — dep (source: bus-reply:r)`,
      sourceChannel: 'slack', sourceThread: TS_A,
    });
    const digest = (dependency: string) => boardNotifyDeltaDigest(boardNotifyDeltaMaterial({
      state: 'BLOCKED', channel: 'slack', thread: TS_A, dependency })!);
    const n1 = notice(digest('dep-alpha')), n2 = notice(digest('dep-beta'));
    const slack = vi.fn().mockResolvedValue({ status: 'sent' as const, receipt: 'fake-ts' });
    await sendNotifications([n1, n2], { senders: { slack }, ledgerPath });
    const sent = readBoardNotifySent(ledgerPath)!;
    expect(sent).toEqual(new Set([
      boardNotifyLedgerKey('req-legacy', 'BLOCKED'),
      boardNotifyLedgerKey('req-delta-1', 'BLOCKED'),
      boardNotifyLedgerKey('req-delta-1', 'BLOCKED', n1.delta),
      boardNotifyLedgerKey('req-delta-1', 'BLOCKED', n2.delta),
    ]));
    // A fresh read (restart) dedupes both deltas; identical evidence replays nothing.
    expect(planNotifications([transition(), transition({ evidence: { asOf: AT2, source: 's', dependency: 'dep-alpha' } })], sent).notices).toEqual([]);
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

describe('cmdFleetBoardNotify meaningful deltas', { timeout: 60_000 }, () => {
  let root: string, dir: string, now: number;
  const post = (envelope: BusEnvelope) => expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
  const lastJson = (log: ReturnType<typeof vi.spyOn>) => JSON.parse(String(log.mock.calls.at(-1)![0]));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'board-notify-delta-bus-'));
    dir = mkdtempSync(join(tmpdir(), 'board-notify-delta-state-'));
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

  it('posts a same-state blocker change once to the same source thread, then dedupes durably', async () => {
    post(slackRequest('slack-delta-1', TS_A));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const slack = vi.fn().mockResolvedValue({ status: 'sent', receipt: 'fake-ts-d1' });
    const run = () => cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'], { senders: { slack }, now: () => now });
    expect(await run()).toBe(0);
    expect(lastJson(log)).toMatchObject({ status: 'baselined', items: 1 });

    now += 60_000;
    expect(postBusReply('slack-delta-1', 'fake-block-a', { blocked: { dependency: 'dep-alpha' } }, { root, now: () => now }).outcome).toBe('posted');
    expect(await run()).toBe(0);
    expect(lastJson(log)).toMatchObject({ status: 'completed', planned: 1, sent: 1 });
    const first = slack.mock.calls[0]![0] as BoardNotice;
    expect(first).toMatchObject({ state: 'BLOCKED', sourceChannel: 'slack', sourceThread: TS_A });
    expect(first.text).toContain('dep-alpha');

    // The dependency changes while the state label stays BLOCKED.
    now += 60_000;
    expect(postBusReply('slack-delta-1', 'fake-block-b', { blocked: { dependency: 'dep-beta' } }, { root, now: () => now }).outcome).toBe('posted');
    expect(await run()).toBe(0);
    expect(lastJson(log)).toMatchObject({ status: 'completed', planned: 1, sent: 1 });
    expect(slack).toHaveBeenCalledTimes(2);
    const second = slack.mock.calls[1]![0] as BoardNotice;
    expect(second.sourceThread).toBe(TS_A);
    expect(second.text).toContain('dep-beta');
    expect(second.delta).not.toBe(first.delta);

    // Unchanged board: nothing posts.
    expect(await run()).toBe(0);
    expect(lastJson(log)).toMatchObject({ status: 'completed', transitions: 0, planned: 0 });
    expect(slack).toHaveBeenCalledTimes(2);
    // Returning to dep-alpha dedupes against its durable delta key — a
    // restart-equivalent fresh read of the same private ledger.
    now += 60_000;
    expect(postBusReply('slack-delta-1', 'fake-block-c', { blocked: { dependency: 'dep-alpha' } }, { root, now: () => now }).outcome).toBe('posted');
    expect(await run()).toBe(0);
    const report = lastJson(log);
    expect(report).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
    expect(report.dropped).toEqual([expect.objectContaining({ itemId: 'slack-delta-1', reason: expect.stringContaining('already notified') })]);
    expect(slack).toHaveBeenCalledTimes(2);
    const sent = readBoardNotifySent(boardNotifyLedgerPath(dir))!;
    expect(sent.has(boardNotifyLedgerKey('slack-delta-1', 'BLOCKED', first.delta))).toBe(true);
    expect(sent.has(boardNotifyLedgerKey('slack-delta-1', 'BLOCKED', second.delta))).toBe(true);
  });

  it('retries a failed send with the same deterministic delta identity', async () => {
    post(slackRequest('slack-delta-2', TS_B));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const run = (slack: ReturnType<typeof vi.fn>) =>
      cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'], { senders: { slack }, now: () => now });
    expect(await run(vi.fn())).toBe(0); // baseline while RECEIVED
    now += 60_000;
    expect(postBusReply('slack-delta-2', 'fake-block-r', { blocked: { dependency: 'dep-retry' } }, { root, now: () => now }).outcome).toBe('posted');
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? { status: 'refused' as const, reason: 'fake-down' } : { status: 'sent' as const, receipt: 'fake-ts-retry' };
    });
    expect(await run(flaky)).toBe(0);
    expect(lastJson(log)).toMatchObject({ status: 'completed', planned: 1, sent: 0, pending: 1 });
    expect(readBoardNotifySent(boardNotifyLedgerPath(dir))!).toEqual(new Set());
    expect(await run(flaky)).toBe(0);
    expect(lastJson(log)).toMatchObject({ status: 'completed', planned: 1, sent: 1, pending: 0 });
    expect(flaky).toHaveBeenCalledTimes(2);
    const [retryA, retryB] = flaky.mock.calls.map(c => c[0] as BoardNotice);
    expect(retryB.delta).toBe(retryA.delta);
    expect(retryB.text).toBe(retryA.text);
    expect(readBoardNotifySent(boardNotifyLedgerPath(dir))!).toEqual(new Set([
      boardNotifyLedgerKey('slack-delta-2', 'BLOCKED'),
      boardNotifyLedgerKey('slack-delta-2', 'BLOCKED', retryA.delta),
    ]));
  });

  it('gives each meaningful delta a distinct deterministic bus reply id', async () => {
    post({ id: 'bus-delta-3', from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: TTL, body: { kind: 'work' } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const run = () => cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'], { now: () => now });
    expect(await run()).toBe(0);
    for (const [i, dep] of ['dep-one', 'dep-two'].entries()) {
      now += 60_000;
      expect(postBusReply('bus-delta-3', `fake-block-d${i + 1}`, { blocked: { dependency: dep } }, { root, now: () => now }).outcome).toBe('posted');
      expect(await run()).toBe(0);
      expect(lastJson(log)).toMatchObject({ status: 'completed', planned: 1, sent: 1 });
    }
    // The real bus sender derives its envelope id from (itemId, state,
    // delta): recompute the expected ids from the ledgered delta digests.
    const sent = readBoardNotifySent(boardNotifyLedgerPath(dir))!;
    const deltas = [...sent].filter(k => k.startsWith('bus-delta-3 BLOCKED ')).map(k => k.split(' ').pop()!);
    expect(deltas).toHaveLength(2);
    const expectedIds = deltas.map(d => `board-notify-${createHash('sha256').update(`bus-delta-3|BLOCKED|${d}`).digest('hex').slice(0, 24)}`);
    const page = listBusInboxAfter(0, 100, { root, now: () => 0 });
    const replyIds = page.status === 'ok' ? page.messages.map(m => m.envelope.id).filter(id => id.startsWith('board-notify-')) : [];
    expect(replyIds.sort()).toEqual(expectedIds.sort());
  });
});
