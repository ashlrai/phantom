import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { boardNotifyLedgerPath } from '../src/core/fleet/work-board-notify.js';

it('reports each pending blocker alongside its item and keeps successful receipts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notify1012-root-'));
  const dir = mkdtempSync(join(tmpdir(), 'notify1012-state-'));
  let now = Date.now();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const run = () => cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'], {
    now: () => now, killed: false, senders: { slack: notice => {
      if (notice.itemId === 'refused') return { status: 'refused', reason: 'unmapped-channel' };
      if (notice.itemId === 'unavailable') return { status: 'unavailable', reason: 'sender-unavailable' };
      return { status: 'sent', receipt: 'fake-receipt' };
    } },
  });
  try {
    for (const id of ['refused', 'unavailable', 'success', 'missing']) {
      expect(appendBusInbox({ id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
        ...(id === 'missing' ? {} : { channel: 'slack', channel_ref: 'T0FAKEWS/C0FAKECH/1700000000.000001',
          sender: { agent_id: 'fake-peer', vendor: 'fake', human: false, team: true }, external: false }),
        body: { kind: 'work' },
      }, { root, now: () => now }).status).toBe('posted');
    }
    expect(await run()).toBe(0);
    now += 60_000;
    for (const id of ['refused', 'unavailable', 'success', 'missing']) {
      expect(postBusReply(id, `blocked-${id}`, { blocked: { dependency: 'fake-dependency' } },
        { root, now: () => now }).outcome).toBe('posted');
    }
    expect(await run()).toBe(0);
    const report = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(report).toMatchObject({ status: 'completed', planned: 4, sent: 1, pending: 3, queued: 0, busPosted: 0 });
    expect(report.deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: 'refused', status: 'refused', reason: 'unmapped-channel' }),
      expect.objectContaining({ itemId: 'unavailable', status: 'unavailable', reason: 'sender-unavailable' }),
      expect.objectContaining({ itemId: 'missing', status: 'no-sender', reason: 'no sender for channel bus' }),
      expect.objectContaining({ itemId: 'success', status: 'sent', evidence: 'sender-receipt', transport: 'unconfirmed' }),
    ]));
    expect(report.deliveries.find((d: { itemId: string }) => d.itemId === 'success')).not.toHaveProperty('reason');
    const receipts = readFileSync(boardNotifyLedgerPath(dir), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ itemId: 'success', receipt: 'fake-receipt' });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => vi.restoreAllMocks());
