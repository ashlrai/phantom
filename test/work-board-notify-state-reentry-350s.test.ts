import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import {
  appendBoardNotifyLedger, boardNotifyLedgerPath, readBoardNotifySnapshot,
  type BoardNotice,
} from '../src/core/fleet/work-board-notify.js';

const ID = 'fake-reentry-order';
const THREAD = 'fake-thread-350';
const request: BusEnvelope = {
  id: ID, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
  channel: 'slack', channel_ref: THREAD,
  sender: { agent_id: 'fake-peer', vendor: 'fake-vendor', human: false, team: true },
  external: false, body: { kind: 'slack-coordination', text: 'fake request' },
};

describe('state reentry through durable command passes', { timeout: 60_000 }, () => {
  let dir: string, roots: string[], root: string, now: number;
  let log: ReturnType<typeof vi.spyOn>;
  const sender = vi.fn<(notice: BoardNotice) => Promise<{ status: 'sent' | 'refused'; receipt?: string }>>();
  const run = () => cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'],
    { senders: { slack: sender }, now: () => now });
  const report = () => JSON.parse(String(log.mock.calls.at(-1)![0]));
  // The collector retains old verified evidence, so each observed board state
  // uses a fresh durable bus fixture; the notifier state survives every pass.
  const state = (kind?: 'blocked' | 'verified', value?: string) => {
    now += 60_000;
    root = mkdtempSync(join(tmpdir(), 'fake-reentry-bus-'));
    roots.push(root);
    chmodSync(root, 0o700);
    expect(appendBusInbox(request, { root, now: () => now }).status).toBe('posted');
    if (kind && value) {
      const evidence = kind === 'blocked' ? { blocked: { dependency: value } } : { verified: { artifact: value } };
      expect(postBusReply(ID, `fake-reply-${now}`, evidence, { root, now: () => now }).outcome).toBe('posted');
    }
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fake-reentry-state-'));
    chmodSync(dir, 0o700);
    roots = [];
    now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    sender.mockReset().mockResolvedValue({ status: 'sent', receipt: 'fake-durable-receipt' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const path of [...roots, dir]) rmSync(path, { recursive: true, force: true });
  });

  it('delivers new blocker and verified evidence on reentry, but never repeats an exact delta', async () => {
    state();
    expect(await run()).toBe(0);
    expect(report()).toMatchObject({ status: 'baselined' });
    state('blocked', 'fake-dependency-A');
    expect(await run()).toBe(0);
    state('verified', 'fake-artifact-B');
    expect(await run()).toBe(0);
    state('blocked', 'fake-dependency-C');
    expect(await run()).toBe(0);
    expect(report()).toMatchObject({ planned: 1, sent: 1 });
    expect(sender.mock.calls.map(([n]) => [n.state, n.detail, n.sourceThread])).toEqual([
      ['BLOCKED', 'fake-dependency-A', THREAD], ['VERIFIED', 'fake-artifact-B', THREAD],
      ['BLOCKED', 'fake-dependency-C', THREAD],
    ]);
    expect(await run()).toBe(0);
    expect(report()).toMatchObject({ planned: 0, sent: 0 });
    state('verified', 'fake-artifact-D');
    expect(await run()).toBe(0);
    expect(sender.mock.calls.at(-1)![0]).toMatchObject({ state: 'VERIFIED', detail: 'fake-artifact-D', sourceThread: THREAD });
    state('blocked', 'fake-dependency-A');
    expect(await run()).toBe(0);
    expect(report()).toMatchObject({ planned: 0, sent: 0 });
    expect(await run()).toBe(0);
    expect(sender).toHaveBeenCalledTimes(4);
  });

  it('keeps legacy state-only proof conservative, even alongside modern rows', async () => {
    state();
    await run();
    appendBoardNotifyLedger(boardNotifyLedgerPath(dir), {
      v: 1, at: new Date(now).toISOString(), itemId: ID, state: 'BLOCKED', channel: 'slack', thread: THREAD, receipt: 'fake-legacy',
    });
    state('blocked', 'fake-legacy-unknown');
    await run();
    expect(sender).not.toHaveBeenCalled();
    expect(await run()).toBe(0);
    expect(sender).not.toHaveBeenCalled();
    // A same-state change is provably new and gains modern proof.
    state('blocked', 'fake-new');
    await run();
    expect(sender).toHaveBeenCalledTimes(1);
    state('verified', 'fake-verified');
    await run();
    state('blocked', 'fake-other');
    await run();
    expect(report()).toMatchObject({ planned: 0, sent: 0 });
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it('retries a refused reentry without advancing its snapshot', async () => {
    state(); await run();
    state('blocked', 'fake-A'); await run();
    state('verified', 'fake-B'); await run();
    const before = readBoardNotifySnapshot(dir);
    state('blocked', 'fake-C');
    sender.mockResolvedValueOnce({ status: 'refused' });
    await run();
    expect(report()).toMatchObject({ planned: 1, sent: 0, pending: 1 });
    expect(readBoardNotifySnapshot(dir)).toEqual(before);
    await run();
    expect(report()).toMatchObject({ planned: 1, sent: 1, pending: 0 });
    expect(sender.mock.calls.at(-1)![0]).toMatchObject({ state: 'BLOCKED', detail: 'fake-C', sourceThread: THREAD });
    await run();
    expect(sender).toHaveBeenCalledTimes(4);
  });
});
