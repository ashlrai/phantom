import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { boardNotifyLedgerPath, boardNotifySnapshotPath } from '../src/core/fleet/work-board-notify.js';

describe('board notifier snapshot history availability', () => {
  let root: string, dir: string, now: number;
  const slack = vi.fn().mockResolvedValue({ status: 'sent', receipt: 'fake-receipt' });
  const bus = vi.fn().mockResolvedValue({ status: 'sent', receipt: 'fake-receipt' });
  const run = (flags: string[] = []) => cmdFleetBoardNotify(
    ['--root', root, '--state-dir', dir, ...flags], { senders: { slack, bus }, now: () => now, killed: false });
  const report = () => JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0]));
  const bytes = (path: string) => existsSync(path) ? readFileSync(path) : null;
  const request = () => expect(appendBusInbox({
    id: 'fake-request', from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
    channel: 'slack', channel_ref: 'T0FAKEWS/C0FAKECH/1700000000.000001',
    sender: { agent_id: 'fake-peer', vendor: 'fake', human: false, team: true },
    external: false, body: { kind: 'work' },
  }, { root, now: () => now }).status).toBe('posted');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'notify-snapshot-bus-'));
    dir = mkdtempSync(join(tmpdir(), 'notify-snapshot-state-'));
    chmodSync(root, 0o700); chmodSync(dir, 0o700);
    now = Date.now(); slack.mockClear(); bus.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('baselines only missing history and treats a valid empty history as readable', async () => {
    expect(await run(['--json'])).toBe(0);
    expect(report()).toMatchObject({ status: 'baselined', items: 0 });
    request();
    now += 60_000;
    expect(postBusReply('fake-request', 'fake-blocked', { blocked: { dependency: 'fake-dependency' } },
      { root, now: () => now }).outcome).toBe('posted');
    expect(await run(['--json'])).toBe(0);
    expect(report()).toMatchObject({ status: 'completed', sent: 1 });
    expect(slack).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['malformed', '{private malformed', 'invalid'],
    ['schema-invalid', '{"v":1,"items":[{}]}', 'invalid'],
    ['capped', 'x'.repeat(1024 * 1024 + 1), 'capped'],
  ])('preserves %s history and retries the blocked delta after restoration', async (_label, bad, reason) => {
    request();
    expect(await run(['--json'])).toBe(0);
    expect(report()).toMatchObject({ status: 'baselined' });
    expect(slack).not.toHaveBeenCalled();
    const path = boardNotifySnapshotPath(dir);
    const prior = readFileSync(path);
    now += 60_000;
    expect(postBusReply('fake-request', 'fake-blocked', { blocked: { dependency: 'fake-dependency' } },
      { root, now: () => now }).outcome).toBe('posted');
    writeFileSync(path, bad, { mode: 0o600 });
    writeFileSync(boardNotifyLedgerPath(dir), '', { mode: 0o600 });
    const snapshot = bytes(path), ledger = bytes(boardNotifyLedgerPath(dir));
    for (const flags of [['--json'], ['--dry-run', '--json']]) {
      expect(await run(flags)).toBe(1);
      expect(report()).toMatchObject({ status: 'snapshot-unavailable', reason, dependency: 'snapshot-storage' });
      expect(bytes(path)?.equals(snapshot!)).toBe(true);
      expect(bytes(boardNotifyLedgerPath(dir))?.equals(ledger!)).toBe(true);
    }
    expect(await run()).toBe(1);
    expect(String(vi.mocked(console.log).mock.calls.at(-1)![0])).toContain('snapshot storage unavailable');
    expect(bytes(path)?.equals(snapshot!)).toBe(true);
    expect(bytes(boardNotifyLedgerPath(dir))?.equals(ledger!)).toBe(true);
    expect(slack).not.toHaveBeenCalled(); expect(bus).not.toHaveBeenCalled();
    writeFileSync(path, prior);
    expect(await run(['--json'])).toBe(0);
    expect(slack).toHaveBeenCalledTimes(1);
    expect(slack.mock.calls[0]![0]).toMatchObject({ itemId: 'fake-request', state: 'BLOCKED' });
    expect(await run(['--json'])).toBe(0);
    expect(slack).toHaveBeenCalledTimes(1);
  });
});
