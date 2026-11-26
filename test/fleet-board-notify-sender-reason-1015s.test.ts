import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import type { BoardNotifySenders } from '../src/core/fleet/work-board-notify.js';

describe('board notify sender reasons', () => {
  let root: string, dir: string, now: number;
  const run = (senders: BoardNotifySenders) => cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'],
    { senders, now: () => now, killed: false });
  const report = () => JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0]));
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'notify-reason-')); dir = join(root, 'state'); now = Date.now();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(appendBusInbox({ id: 'fake-request', from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
      channel: 'slack', channel_ref: 'T0FAKEWS/C0FAKECH/1700000000.000001',
      sender: { agent_id: 'fake-peer', vendor: 'fake', human: false, team: true },
      external: false, body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
    expect(await run({})).toBe(0);
    now += 60_000;
    expect(postBusReply('fake-request', 'fake-blocked', { blocked: { dependency: 'fake-dependency' } },
      { root, now: () => now }).outcome).toBe('posted');
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

  it('reports unavailable, refused and absent sender dependencies while pending', async () => {
    for (const status of ['unavailable', 'refused'] as const) {
      expect(await run({ slack: () => ({ status, reason: 'fake-sender-dependency unavailable' }) })).toBe(0);
      expect(report()).toMatchObject({ pending: 1, deliveries: [{ status, reason: 'fake-sender-dependency unavailable' }] });
    }
    expect(await run({})).toBe(0);
    expect(report()).toMatchObject({ pending: 1, deliveries: [{ status: 'no-sender', reason: 'no sender for channel slack' }] });
  });

  it('scrubs and bounds multiline reasons and omits reason on success', async () => {
    const reason = `fake-dependency\napi_key=sk_${'a'.repeat(40)}\r\n${'x'.repeat(600)}`;
    expect(await run({ slack: () => ({ status: 'unavailable', reason }) })).toBe(0);
    const row = report().deliveries[0];
    expect(report().pending).toBe(1);
    expect(row.reason).toContain('fake-dependency');
    expect(row.reason).not.toContain(`sk_${'a'.repeat(40)}`);
    expect(row.reason).not.toMatch(/[\r\n\u2028\u2029]/);
    expect(row.reason.length).toBeLessThanOrEqual(512);
    expect(await run({ slack: () => ({ status: 'sent', receipt: 'fake-receipt' }) })).toBe(0);
    expect(report().pending).toBe(0);
    expect(report().deliveries[0]).not.toHaveProperty('reason');
  });
});
