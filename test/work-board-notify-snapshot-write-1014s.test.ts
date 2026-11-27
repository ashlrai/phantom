import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { boardNotifyLedgerPath, boardNotifySnapshotPath } from '../src/core/fleet/work-board-notify.js';

describe('board notify snapshot persistence', () => {
  let root: string, dir: string, now: number;
  const sender = vi.fn(async (_notice: unknown): Promise<{ status: 'sent'; receipt: string }> => ({ status: 'sent', receipt: 'fake-receipt' }));
  const run = (flags: string[] = []) => cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json', ...flags],
    { senders: { slack: sender }, now: () => now, killed: false });
  const report = () => JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0]));
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'notify-snapshot-'));
    dir = join(root, 'state');
    now = Date.now();
    sender.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(appendBusInbox({ id: 'fake-request', from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
      channel: 'slack', channel_ref: 'T0FAKEWS/C0FAKECH/1700000000.000001',
      sender: { agent_id: 'fake-peer', vendor: 'fake', human: false, team: true },
      external: false, body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

  it('reports baseline failure without sending, while dry-run writes nothing', async () => {
    mkdirSync(dir);
    mkdirSync(boardNotifySnapshotPath(dir));
    expect(await run(['--dry-run'])).toBe(0);
    expect(report().status).toBe('dry-run');
    expect(existsSync(boardNotifySnapshotPath(dir))).toBe(true);
    expect(await run()).toBe(1);
    expect(report()).toMatchObject({ status: 'snapshot-persistence-failed', reason: 'snapshot-write-failed' });
    expect(JSON.stringify(report())).not.toContain(dir);
    expect(sender).not.toHaveBeenCalled();
  });

  it('saves a baseline and fences a delivered delta after checkpoint failure', async () => {
    expect(await run()).toBe(0);
    expect(report().status).toBe('baselined');
    const snapshot = boardNotifySnapshotPath(dir);
    const backup = join(root, 'baseline');
    now += 60_000;
    expect(postBusReply('fake-request', 'fake-blocked', { blocked: { dependency: 'fake-dependency' } },
      { root, now: () => now }).outcome).toBe('posted');
    sender.mockImplementationOnce(async () => {
      renameSync(snapshot, backup);
      mkdirSync(snapshot);
      return { status: 'sent', receipt: 'fake-receipt' };
    });
    expect(await run()).toBe(1);
    expect(report()).toMatchObject({ status: 'snapshot-persistence-failed', reason: 'snapshot-write-failed', sent: 1,
      deliveries: [{ itemId: 'fake-request', state: 'BLOCKED', status: 'sent' }] });
    expect(existsSync(boardNotifyLedgerPath(dir))).toBe(true);
    rmSync(snapshot, { recursive: true });
    renameSync(backup, snapshot);
    expect(await run()).toBe(0);
    expect(report()).toMatchObject({ status: 'completed', sent: 0 });
    expect(sender).toHaveBeenCalledTimes(1);
  });
});
