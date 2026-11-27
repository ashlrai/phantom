import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';

it('previews receipt-backed notices without writing or sending, including on first pass and KILL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notify1013-root-'));
  const dir = mkdtempSync(join(tmpdir(), 'notify1013-state-'));
  const now = Date.parse('2026-11-14T01:00:00.000Z');
  const thread = 'T0FAKEWS/C0FAKECH/1700000000.000001';
  const sender = vi.fn(() => ({ status: 'sent' as const, receipt: 'fake' }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const run = async (killed: boolean) => {
    log.mockClear();
    expect(await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--dry-run', '--json'],
      { now: () => now, killed, senders: { slack: sender } })).toBe(0);
    return JSON.parse(String(log.mock.calls.at(-1)![0]));
  };
  try {
    const empty = await run(false);
    expect(empty).toMatchObject({ status: 'dry-run', planned: 0, notices: [], baselined: true, killed: false });
    expect(appendBusInbox({ id: 'fake-item', from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
      channel: 'slack', channel_ref: thread,
      sender: { agent_id: 'fake-peer', vendor: 'fake', human: false, team: true }, external: false,
      body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
    expect(postBusReply('fake-item', 'fake-reply', { blocked: { dependency: 'fake-dependency' } },
      { root, now: () => now }).outcome).toBe('posted');
    const before = listBusInboxAfter(0, 100, { root, now: () => now });
    for (const killed of [false, true]) {
      const report = await run(killed);
      expect(report).toMatchObject({ status: 'dry-run', baselined: true, killed, planned: 1, dropped: [] });
      expect(report.notices).toEqual([{ itemId: 'fake-item', state: 'BLOCKED', sourceChannel: 'slack',
        sourceThread: thread, asOf: new Date(now).toISOString(), source: 'bus-reply:fake-reply',
        detail: 'fake-dependency', text: `BLOCKED fake-item as of ${new Date(now).toISOString()} — fake-dependency (source: bus-reply:fake-reply)` }]);
      expect(report.lines).toContain(`would-post [slack ${thread}] ${report.notices[0].text}`);
    }
    expect(readdirSync(dir)).toEqual([]);
    expect(listBusInboxAfter(0, 100, { root, now: () => now })).toEqual(before);
    expect(sender).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
afterEach(() => vi.restoreAllMocks());
