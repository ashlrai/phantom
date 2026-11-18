import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { boardNotifyLedgerPath, boardNotifySnapshotPath } from '../src/core/fleet/work-board-notify.js';

describe('board notifier unavailable inbox', () => {
  let root: string, dir: string, now: number;
  const slack = vi.fn().mockResolvedValue({ status: 'sent', receipt: 'fake-receipt' });
  const bus = vi.fn().mockResolvedValue({ status: 'sent', receipt: 'fake-receipt' });
  const run = (flags: string[] = [], killed = false) => cmdFleetBoardNotify(
    ['--root', root, '--state-dir', dir, ...flags], { senders: { slack, bus }, now: () => now, killed });
  const inbox = () => join(root, 'bus-inbox', 'messages.json');
  const bytes = (path: string) => existsSync(path) ? readFileSync(path) : null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'notify-inbox-'));
    dir = mkdtempSync(join(tmpdir(), 'notify-state-'));
    chmodSync(root, 0o700);
    chmodSync(dir, 0o700);
    now = Date.now();
    slack.mockClear(); bus.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails first-run and dry-run reads without creating state, even with KILL armed', async () => {
    mkdirSync(join(root, 'bus-inbox'), { mode: 0o700 });
    writeFileSync(inbox(), '{not json', { mode: 0o600 });
    const log = vi.mocked(console.log);
    expect(await run(['--json'])).toBe(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ status: 'inbox-unavailable', inbox: 'unavailable' });
    expect(await run(['--dry-run'], true)).toBe(1);
    expect(String(log.mock.calls.at(-1)![0])).toContain('inbox unavailable');
    expect(bytes(boardNotifySnapshotPath(dir))).toBeNull();
    expect(bytes(boardNotifyLedgerPath(dir))).toBeNull();
    expect(slack).not.toHaveBeenCalled();
    expect(bus).not.toHaveBeenCalled();
  });

  it('keeps existing bytes and delivers the pending transition once after recovery', async () => {
    expect(appendBusInbox({
      id: 'fake-request', from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
      channel: 'slack', channel_ref: 'T0FAKEWS/C0FAKECH/1700000000.000001',
      sender: { agent_id: 'fake-peer', vendor: 'fake', human: false, team: true },
      external: false, body: { kind: 'work' },
    }, { root, now: () => now }).status).toBe('posted');
    expect(await run(['--json'])).toBe(0);
    now += 60_000;
    expect(postBusReply('fake-request', 'fake-blocked', { blocked: { dependency: 'fake-dependency' } },
      { root, now: () => now }).outcome).toBe('posted');
    const healthyInbox = readFileSync(inbox());
    const snapshot = bytes(boardNotifySnapshotPath(dir));
    // An existing ledger must also stay byte-for-byte unchanged.
    writeFileSync(boardNotifyLedgerPath(dir), '', { mode: 0o600 });
    const ledger = bytes(boardNotifyLedgerPath(dir));
    writeFileSync(inbox(), '{not json');
    expect(await run(['--json'])).toBe(1);
    expect(await run(['--dry-run', '--json'])).toBe(1);
    expect(bytes(boardNotifySnapshotPath(dir))).toEqual(snapshot);
    expect(bytes(boardNotifyLedgerPath(dir))).toEqual(ledger);
    expect(slack).not.toHaveBeenCalled();
    expect(bus).not.toHaveBeenCalled();
    writeFileSync(inbox(), healthyInbox);
    expect(await run(['--json'])).toBe(0);
    expect(slack).toHaveBeenCalledTimes(1);
    expect(slack.mock.calls[0]![0]).toMatchObject({ itemId: 'fake-request', state: 'BLOCKED' });
    expect(await run(['--json'])).toBe(0);
    expect(slack).toHaveBeenCalledTimes(1);
  });

  it('baselines a valid empty inbox', async () => {
    mkdirSync(join(root, 'bus-inbox'), { mode: 0o700 });
    writeFileSync(inbox(), '[]', { mode: 0o600 });
    expect(await run(['--json'])).toBe(0);
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0]))).toMatchObject({ status: 'baselined', items: 0 });
    expect(bytes(boardNotifySnapshotPath(dir))).not.toBeNull();
    expect(slack).not.toHaveBeenCalled();
    expect(bus).not.toHaveBeenCalled();
  });
});
