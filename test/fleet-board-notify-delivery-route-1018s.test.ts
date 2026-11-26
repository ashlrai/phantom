import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';

it('reports each live route with its own receipt or pending result, scrubbing routes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notify1018-root-'));
  const dir = mkdtempSync(join(tmpdir(), 'notify1018-state-'));
  let now = Date.parse('2026-11-14T01:00:00.000Z');
  const thread = 'T0FAKEWS/C0FAKECH/1700000000.000001';
  const secret = 'ghp_AbCdEf0123456789GhIjKlMnOpQr';
  const sender = vi.fn(() => ({ status: 'sent' as const, receipt: 'fake-receipt' }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const run = async (dry = false) => {
    log.mockClear();
    const code = await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json', ...(dry ? ['--dry-run'] : [])],
      { now: () => now, killed: false, senders: { bus: sender, slack: notice =>
        notice.itemId === 'fake-refused' ? { status: 'refused', reason: 'fake-refusal' } : sender() } });
    return { code, output: String(log.mock.calls.at(-1)![0]), report: JSON.parse(String(log.mock.calls.at(-1)![0])) };
  };
  const post = (id: string, channel?: 'slack' | 'telegram', ref?: string) => expect(appendBusInbox({
    id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
    ...(channel ? { channel, channel_ref: ref!, sender: { agent_id: 'fake-peer', vendor: 'fake', human: false, team: true }, external: false } : {}),
    body: { kind: 'work' },
  }, { root, now: () => now }).status).toBe('posted');
  try {
    post('fake-bus');
    post('fake-slack', 'slack', thread);
    post('fake-refused', 'slack', 'fake-refused-thread');
    post('fake-pending', 'telegram', secret);
    expect((await run()).report.status).toBe('baselined');
    now += 60_000;
    for (const id of ['fake-bus', 'fake-slack', 'fake-refused', 'fake-pending']) {
      expect(postBusReply(id, `fake-reply-${id}`, { blocked: { dependency: 'fake-dependency' } },
        { root, now: () => now }).outcome).toBe('posted');
    }
    const before = listBusInboxAfter(0, 100, { root, now: () => now });
    const files = readdirSync(dir);
    const preview = await run(true);
    expect(preview.report.planned).toBe(4);
    expect(preview.output).not.toContain(secret);
    expect(readdirSync(dir)).toEqual(files);
    expect(listBusInboxAfter(0, 100, { root, now: () => now })).toEqual(before);
    expect(sender).not.toHaveBeenCalled();
    const live = await run();
    expect(live.code).toBe(0);
    expect(live.output).not.toContain(secret);
    expect(live.report.deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: 'fake-bus', status: 'sent', sourceChannel: 'bus', sourceThread: null, evidence: 'sender-receipt', transport: 'unconfirmed' }),
      expect.objectContaining({ itemId: 'fake-slack', status: 'sent', sourceChannel: 'slack', sourceThread: thread, evidence: 'sender-receipt', transport: 'unconfirmed' }),
      expect.objectContaining({ itemId: 'fake-refused', status: 'refused', sourceChannel: 'slack', sourceThread: 'fake-refused-thread' }),
      expect.objectContaining({ itemId: 'fake-pending', status: 'no-sender', sourceChannel: 'telegram', sourceThread: expect.not.stringContaining(secret) }),
    ]));
    expect(live.report.deliveries).toHaveLength(4);
  } finally {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
