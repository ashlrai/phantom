import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { boardNotifyLedgerPath, boardNotifySnapshotPath, readBoardNotifySent } from '../src/core/fleet/work-board-notify.js';

const id = 'fake-request-1004';
const thread = 'T0FAKETEST/C0FAKETEST/1700000000.001004';
const request: BusEnvelope = {
  id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: 10_000_000,
  channel: 'slack', channel_ref: thread,
  sender: { agent_id: 'fake-requester', vendor: 'fake-vendor', human: false, team: true },
  external: false, body: { kind: 'work' },
};

describe('uncertain board notification history', () => {
  let root: string, dir: string, now: number;
  let log: ReturnType<typeof vi.spyOn>;
  const slack = vi.fn(async () => ({ status: 'sent' as const, receipt: 'fake-receipt' }));
  const run = () => cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'],
    { senders: { slack }, now: () => now, killed: false });
  const report = () => JSON.parse(String(log.mock.calls.at(-1)![0]));
  const block = (reply: string, dependency: string) => {
    now += 60_000;
    expect(postBusReply(id, reply, { blocked: { dependency } }, { root, now: () => now }).outcome).toBe('posted');
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'notify-bus-1004-'));
    dir = mkdtempSync(join(tmpdir(), 'notify-state-1004-'));
    now = Date.now();
    slack.mockClear();
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses corrupt histories without consuming pending state, then dedupes a restored delivery and sends new evidence', async () => {
    expect(appendBusInbox(request, { root, now: () => now }).status).toBe('posted');
    expect(await run()).toBe(0);
    const baseline = readFileSync(boardNotifySnapshotPath(dir));
    block('fake-reply-one', 'fake-dependency-one');
    expect(await run()).toBe(0);
    expect(slack).toHaveBeenCalledTimes(1);
    const path = boardNotifyLedgerPath(dir);
    const valid = readFileSync(path, 'utf8');
    // Restore the pre-delivery snapshot to recreate a pending replay after restart.
    writeFileSync(boardNotifySnapshotPath(dir), baseline);
    const row = JSON.parse(valid);
    const invalidRows = [
      valid + '{"v":', '{"v":\n' + valid,
      valid + JSON.stringify({ ...row, receipt: '' }) + '\n',
      valid + JSON.stringify({ ...row, delta: null }) + '\n',
      valid + JSON.stringify({ ...row, v: 2 }) + '\n',
    ];
    for (const history of invalidRows) {
      writeFileSync(path, history);
      expect(readBoardNotifySent(path)).toBeNull();
      expect(await run()).toBe(1);
      expect(report()).toMatchObject({ status: 'ledger-unavailable' });
      expect(slack).toHaveBeenCalledTimes(1);
      expect(readFileSync(boardNotifySnapshotPath(dir))).toEqual(baseline);
    }
    writeFileSync(path, valid);
    expect(await run()).toBe(0);
    expect(report()).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
    expect(slack).toHaveBeenCalledTimes(1);
    block('fake-reply-two', 'fake-dependency-two');
    expect(await run()).toBe(0);
    expect(report()).toMatchObject({ status: 'completed', planned: 1, sent: 1 });
    expect(slack).toHaveBeenCalledTimes(2);
  });

  it('accepts missing, blank and supported state-only legacy histories', async () => {
    const path = boardNotifyLedgerPath(dir);
    expect(readBoardNotifySent(path)).toEqual(new Set());
    writeFileSync(path, '\n  \n');
    expect(readBoardNotifySent(path)).toEqual(new Set());
    expect(appendBusInbox(request, { root, now: () => now }).status).toBe('posted');
    expect(await run()).toBe(0);
    block('fake-legacy-reply', 'fake-legacy-dependency');
    writeFileSync(path, JSON.stringify({ v: 1, at: '2026-01-01T00:00:00.000Z', itemId: id,
      state: 'BLOCKED', channel: 'slack', thread, receipt: 'fake-old-receipt' }) + '\n');
    expect(readBoardNotifySent(path)).not.toBeNull();
    expect(await run()).toBe(0);
    expect(report()).toMatchObject({ status: 'completed', planned: 0, sent: 0 });
    expect(slack).not.toHaveBeenCalled();
  });
});
