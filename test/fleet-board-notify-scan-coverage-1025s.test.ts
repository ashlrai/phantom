import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { boardNotifyLedgerPath, boardNotifySnapshotPath } from '../src/core/fleet/work-board-notify.js';

let root: string, dir: string, now: number;
const ids = ['RQ-FAKE-1025-A', 'RQ-FAKE-1025-B'];
const sender = vi.fn(async () => ({ status: 'sent' as const, receipt: 'fake-durable-receipt' }));
const run = async (args: string[] = [], json = true) => {
  vi.mocked(console.log).mockClear();
  const code = await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, ...args, ...(json ? ['--json'] : [])],
    { now: () => now, killed: false, senders: { slack: sender } });
  const output = vi.mocked(console.log).mock.calls.map(call => String(call[0])).join('\n');
  return { code, output, report: json ? JSON.parse(output) : undefined };
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'notify1025-root-'));
  dir = mkdtempSync(join(tmpdir(), 'notify1025-state-'));
  chmodSync(root, 0o700); chmodSync(dir, 0o700);
  now = Date.now(); sender.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  for (const id of ids) expect(appendBusInbox({
    id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
    channel: 'slack', channel_ref: 'T0FAKEWS/C0FAKECH/1700000000.000353', sender: { agent_id: 'fake-peer', vendor: 'fake', human: false, team: true },
    external: false, body: { kind: 'work' },
  }, { root, now: () => now }).status).toBe('posted');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

it('reports bounded coverage, preserves dry-run state, and sends an in-page transition once', async () => {
  expect((await run()).report).toMatchObject({ status: 'baselined', coverage: { truncated: false, inspected: 2, complete: true } });
  let pass = await run(['--limit', '1']);
  expect(pass.code).toBe(1);
  expect(pass.report).toMatchObject({ status: 'completed', reason: 'scan-incomplete', pending: 0,
    coverage: { truncated: true, inspected: 1, complete: false } });
  expect(pass.output).not.toMatch(/unseen(?:Count|Total)|totalUnseen/i);
  pass = await run(['--limit', '1'], false);
  expect(pass.code).toBe(1);
  expect(pass.output).toContain('unseen work may remain');
  pass = await run();
  expect(pass.code).toBe(0);
  expect(pass.report.coverage).toEqual({ truncated: false, inspected: 2, complete: true });

  now += 60_000;
  expect(postBusReply(ids[1]!, 'fake-block-1025', { blocked: { dependency: 'fake-dependency' } }, { root, now: () => now }).outcome).toBe('posted');
  pass = await run(['--limit', '1']);
  expect(pass.code).toBe(1);
  expect(pass.report).toMatchObject({ sent: 1, pending: 0, reason: 'scan-incomplete' });
  expect(sender).toHaveBeenCalledTimes(1);
  const snapshot = readFileSync(boardNotifySnapshotPath(dir));
  const ledger = readFileSync(boardNotifyLedgerPath(dir));
  expect(ledger.toString()).toContain('fake-durable-receipt');
  pass = await run(['--limit', '1', '--dry-run']);
  expect(pass.code).toBe(0);
  expect(pass.report.coverage).toEqual({ truncated: true, inspected: 1, complete: false });
  expect(readFileSync(boardNotifySnapshotPath(dir))).toEqual(snapshot);
  expect(readFileSync(boardNotifyLedgerPath(dir))).toEqual(ledger);
  await run(['--limit', '1']);
  expect(sender).toHaveBeenCalledTimes(1);
});
