import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { boardNotifyLedgerPath, readBoardNotifySnapshot } from '../src/core/fleet/work-board-notify.js';

let root: string, dir: string, now: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'notify1020-root-'));
  dir = mkdtempSync(join(tmpdir(), 'notify1020-state-'));
  chmodSync(root, 0o700); chmodSync(dir, 0o700); now = Date.now();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); });

it('reports pending failures, preserves receipts and retries only pending work', async () => {
  for (const id of ['fake-a', 'fake-b']) expect(appendBusInbox({
    id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
    channel: 'slack', channel_ref: 'T0FAKEWS/C0FAKECH/1700000000.000001',
    sender: { agent_id: 'fake-peer', vendor: 'fake', human: false, team: true },
    external: false, body: { kind: 'work' },
  }, { root, now: () => now }).status).toBe('posted');
  const sender = vi.fn(async (notice: { itemId: string }) => notice.itemId === 'fake-a'
    ? { status: 'sent' as const, receipt: 'fake-receipt' }
    : { status: 'refused' as const, reason: 'fake-refusal' });
  const run = async (senders: NonNullable<Parameters<typeof cmdFleetBoardNotify>[1]>['senders']) => {
    const code = await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'], { senders, now: () => now, killed: false });
    return { code, report: JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0])) };
  };
  expect((await run({})).report.status).toBe('baselined');
  now += 60_000;
  for (const id of ['fake-a', 'fake-b']) expect(postBusReply(id, `block-${id}`,
    { blocked: { dependency: 'fake-dependency' } }, { root, now: () => now }).outcome).toBe('posted');
  const unavailable = await run({});
  expect(unavailable).toMatchObject({ code: 1, report: { status: 'notifications-pending', pending: 2 } });
  expect(unavailable.report.deliveries.every((row: { status: string }) => row.status === 'no-sender')).toBe(true);
  const mixed = await run({ slack: sender });
  expect(mixed).toMatchObject({ code: 1, report: { status: 'notifications-pending', sent: 1, pending: 1 } });
  expect(mixed.report.deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemId: 'fake-a', status: 'sent', evidence: 'sender-receipt' }),
    expect.objectContaining({ itemId: 'fake-b', status: 'refused', evidence: 'none' }),
  ]));
  expect(readFileSync(boardNotifyLedgerPath(dir), 'utf8')).toContain('fake-receipt');
  const snapshot = readBoardNotifySnapshot(dir)!;
  expect(snapshot.find(row => row.id === 'fake-a')?.state).toBe('BLOCKED');
  expect(snapshot.find(row => row.id === 'fake-b')?.state).not.toBe('BLOCKED');
  sender.mockClear();
  sender.mockResolvedValue({ status: 'sent', receipt: 'fake-receipt' });
  const recovered = await run({ slack: sender });
  expect(recovered).toMatchObject({ code: 0, report: { status: 'completed', sent: 1, pending: 0 } });
  expect(sender).toHaveBeenCalledTimes(1);
  expect(sender.mock.calls[0]![0].itemId).toBe('fake-b');
  const steady = await run({ slack: sender });
  expect(steady).toMatchObject({ code: 0, report: { status: 'completed', planned: 0, pending: 0 } });
});
