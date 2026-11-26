import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { readBoardNotifySnapshot } from '../src/core/fleet/work-board-notify.js';

const failure = vi.hoisted(() => ({ append: false }));
vi.mock('../src/core/fleet/work-board-notify.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/fleet/work-board-notify.js')>();
  return { ...actual, sendNotifications: (notices: Parameters<typeof actual.sendNotifications>[0], opts: Parameters<typeof actual.sendNotifications>[1]) =>
    actual.sendNotifications(notices, failure.append ? { ...opts, appendLedger: () => { throw new Error('fake'); } } : opts) };
});

describe('board notifier receipt accounting', () => {
  let root: string, dir: string, now: number;
  const run = async (senders?: NonNullable<Parameters<typeof cmdFleetBoardNotify>[1]>['senders'], json = true) => {
    vi.mocked(console.log).mockClear();
    await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, ...(json ? ['--json'] : [])], { now: () => now, killed: false, senders });
    const output = vi.mocked(console.log).mock.calls.map(c => String(c[0])).join('\n');
    return json ? JSON.parse(output) : output;
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'notify1017-root-')); dir = mkdtempSync(join(tmpdir(), 'notify1017-state-'));
    chmodSync(root, 0o700); chmodSync(dir, 0o700); now = Date.now();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(appendBusInbox({ id: 'fake-item', from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10000000,
      body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
  });
  afterEach(() => { failure.append = false; vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); });
  const block = () => { now += 60000; expect(postBusReply('fake-item', 'fake-block', { blocked: { dependency: 'fake-dep' } }, { root, now: () => now }).outcome).toBe('posted'); };

  it('keeps bus enqueue evidence and retries an unrecorded receipt as a duplicate', async () => {
    await run(); const baseline = readBoardNotifySnapshot(dir); block(); failure.append = true;
    const report = await run();
    expect(report).toMatchObject({ sent: 0, queued: 0, busPosted: 0, pending: 1, deliveries: [{ status: 'unavailable', reason: 'ledger-append-failed', receiptRecorded: false, evidence: 'bus-reply-posted', transport: 'bus-durable' }] });
    expect(readBoardNotifySnapshot(dir)).toEqual(baseline);
    const human = await run(undefined, false);
    expect(human).toContain('notification receipt unrecorded');
    expect(human).not.toContain('receipt recorded');
    failure.append = false;
    const retry = await run();
    expect(retry).toMatchObject({ sent: 1, busPosted: 1, pending: 0, deliveries: [{ status: 'duplicate', duplicate: true }] });
    expect((await run()).planned).toBe(0);
  });

  it.each([undefined, '   '])('keeps a missing or blank sender receipt pending', async receipt => {
    const sender = vi.fn().mockReturnValue({ status: 'sent', receipt });
    const senders = { bus: sender };
    await run(senders); const baseline = readBoardNotifySnapshot(dir); block();
    const report = await run(senders);
    expect(report).toMatchObject({ sent: 0, queued: 0, busPosted: 0, pending: 1, deliveries: [{ status: 'unavailable', reason: 'missing-sender-receipt', receiptRecorded: false, transport: 'unconfirmed' }] });
    expect(readBoardNotifySnapshot(dir)).toEqual(baseline);
    sender.mockReturnValue({ status: 'sent', receipt: 'fake-receipt' });
    expect(await run(senders)).toMatchObject({ sent: 1, pending: 0, deliveries: [{ status: 'sent', transport: 'unconfirmed' }] });
  });
});
