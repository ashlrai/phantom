import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { boardNotifyLedgerPath, type BoardNotifySender, type BoardSendReceipt } from '../src/core/fleet/work-board-notify.js';

describe('board notifier CLI sender contract', () => {
  let root: string, dir: string, now: number;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'notify-contract-bus-'));
    dir = mkdtempSync(join(tmpdir(), 'notify-contract-state-'));
    chmodSync(root, 0o700); chmodSync(dir, 0o700);
    now = Date.now();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); });

  it.each([
    [undefined, 'invalid-sender-receipt'], [null, 'invalid-sender-receipt'],
    ['malformed', 'invalid-sender-receipt'], [{ status: 'unknown' }, 'invalid-sender-receipt'],
    [{ status: 'sent', receipt: '  ' }, 'missing-sender-receipt'],
    [{ status: 'sent' }, 'missing-sender-receipt'],
    ['throw', 'sender threw'],
  ])('preserves the diagnosis for %j while another notice progresses', async (invalid, reason) => {
    for (const id of ['item-a', 'item-b']) {
      expect(appendBusInbox({ id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
        body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
    }
    const sender = vi.fn<BoardNotifySender>(notice => {
      if (notice.itemId === 'item-b') return { status: 'sent', receipt: 'receipt-b' };
      if (invalid === 'throw') throw new Error('synthetic failure');
      return invalid as BoardSendReceipt;
    });
    const run = async (json = false) => {
      vi.mocked(console.log).mockClear();
      expect(await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, ...(json ? ['--json'] : [])],
        { now: () => now, killed: false, senders: { bus: sender } })).toBe(0);
      return vi.mocked(console.log).mock.calls.map(call => String(call[0])).join('\n');
    };
    await run();
    now += 60_000;
    for (const id of ['item-a', 'item-b']) {
      expect(postBusReply(id, `block-${id}`, { blocked: { dependency: 'fake-dependency' } },
        { root, now: () => now }).outcome).toBe('posted');
    }
    const report = JSON.parse(await run(true));
    expect(report).toMatchObject({ planned: 2, sent: 1, pending: 1, queued: 0, busPosted: 0 });
    expect(report.deliveries.find((d: { itemId: string }) => d.itemId === 'item-a'))
      .toMatchObject({ status: 'unavailable', evidence: 'none', transport: 'none' });
    expect(report.deliveries.find((d: { itemId: string }) => d.itemId === 'item-b'))
      .toMatchObject({ status: 'sent', evidence: 'sender-receipt' });
    const ledger = () => readFileSync(boardNotifyLedgerPath(dir), 'utf8').trim().split('\n').map(line => JSON.parse(line).itemId);
    expect(ledger()).toEqual(['item-b']);
    const human = await run();
    expect(human).toContain(reason);
    expect(human).toContain('receipts=0');
    expect(sender.mock.calls.filter(([notice]) => notice.itemId === 'item-b')).toHaveLength(1);
    expect(ledger()).toEqual(['item-b']);
  });
});
