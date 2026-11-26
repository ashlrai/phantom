import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { loadAgentNetworkConfig } from '../src/core/agents/slack-network.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { boardNotifyLedgerPath, boardNotifySnapshotPath, sendNotifications,
  type BoardNotice, type BoardSendReceipt } from '../src/core/fleet/work-board-notify.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'receipt1019-')); chmodSync(dir, 0o700); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
const notice: BoardNotice = { itemId: 'fake-item', state: 'BLOCKED', asOf: '2026-11-26T12:00:00Z',
  delta: 'fake-delta', detail: 'fake-dep', source: 'fake-source', text: 'fake-notice',
  sourceChannel: 'bus', sourceThread: null };

it.each(['sent', 'duplicate'] as const)('returns the exact bounded ledger receipt after %s', async status => {
  const ledgerPath = boardNotifyLedgerPath(dir);
  const [result] = await sendNotifications([notice], { ledgerPath,
    senders: { bus: () => ({ status, receipt: `  bus-reply:${'a'.repeat(600)}  ` }) } });
  const row = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  expect(result).toMatchObject({ status, receipt: row.receipt });
  expect(result!.receipt).toHaveLength(512);
});

it.each<BoardSendReceipt>([{ status: 'sent' }, { status: 'duplicate', receipt: ' \t\n' },
  { status: 'refused', receipt: 'fake-rejected', reason: 'fake-refusal' },
  { status: 'unavailable', receipt: 'fake-unavailable', reason: 'fake-unavailable' }])(
  'does not advertise a rejected or missing receipt: %j', async senderResult => {
    const appendLedger = vi.fn();
    const [result] = await sendNotifications([notice], { appendLedger, senders: { bus: () => senderResult } });
    expect(result).not.toHaveProperty('receipt');
    expect(result).toMatchObject({ status: senderResult.status === 'sent' || senderResult.status === 'duplicate'
      ? 'unavailable' : senderResult.status, reason: senderResult.reason ?? 'missing-sender-receipt' });
    expect(appendLedger).not.toHaveBeenCalled();
  });
it('withholds the receipt when append throws', async () => {
  const [result] = await sendNotifications([notice], { appendLedger: () => { throw new Error('fake-disk'); },
    senders: { bus: () => ({ status: 'sent', receipt: 'bus-reply:fake' }) } });
  expect(result).toEqual({ notice, status: 'unavailable', reason: 'ledger-append-failed' });
});

it.each(['bus', 'slack'])('traces default %s JSON success and duplicate to the durable bus ID', async channel => {
  const root = join(dir, 'bus'), state = join(dir, 'state'), cfg = join(dir, 'network.toml');
  writeFileSync(cfg, '[slack]\nteam_id="T0FAKEWS"\n[[slack.map]]\ntopic="fake-topic"\nchannel="C0FAKECH"\n', { mode: 0o600 });
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const now = Date.now();
  expect(appendBusInbox({ id: 'fake-request', from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
    ...(channel === 'slack' ? { channel, channel_ref: 'T0FAKEWS/C0FAKECH/1700000000.000001',
      sender: { agent_id: 'fake-peer', vendor: 'fake', human: false, team: true }, external: false } : {}),
    body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
  const run = async () => {
    expect(await cmdFleetBoardNotify(['--root', root, '--state-dir', state, '--json'], {
      killed: false, now: () => now, readConfig: () => loadAgentNetworkConfig({ path: cfg }),
    })).toBe(0);
    return JSON.parse(String(log.mock.calls.at(-1)![0]));
  };
  await run();
  const baseline = readFileSync(boardNotifySnapshotPath(state), 'utf8');
  expect(postBusReply('fake-request', 'fake-blocker', { blocked: { dependency: 'fake-dep' } }, { root }).outcome).toBe('posted');
  let receipt: string | undefined;
  for (const status of ['sent', 'duplicate']) {
    const report = await run(), delivery = report.deliveries[0];
    const row = JSON.parse(readFileSync(boardNotifyLedgerPath(state), 'utf8'));
    expect(delivery).toMatchObject({ status, receipt: row.receipt,
      transport: channel === 'slack' ? 'unconfirmed' : 'bus-durable' });
    expect(report).toMatchObject({ sent: 1, pending: 0, queued: channel === 'slack' ? 1 : 0 });
    const page = listBusInboxAfter(0, 100, { root });
    expect(page.status).toBe('ok');
    if (page.status === 'ok') expect(page.messages.some(m =>
      `${channel === 'slack' ? 'bus-note' : 'bus-reply'}:${m.envelope.id}` === delivery.receipt)).toBe(true);
    if (receipt) expect(delivery.receipt).toBe(receipt);
    receipt = delivery.receipt;
    expect(JSON.stringify(report)).not.toContain('slack-delivered');
    unlinkSync(boardNotifyLedgerPath(state));
    writeFileSync(boardNotifySnapshotPath(state), baseline, { mode: 0o600 });
  }
});
