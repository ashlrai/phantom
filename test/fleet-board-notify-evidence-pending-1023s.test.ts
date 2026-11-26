import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { boardNotifyLedgerPath, readBoardNotifySnapshot, writeBoardNotifySnapshot } from '../src/core/fleet/work-board-notify.js';
import * as evidence from '../src/core/comms/work-item-bus-evidence.js';

vi.mock('../src/core/comms/work-item-bus-evidence.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/comms/work-item-bus-evidence.js')>();
  return { ...actual, collectBusWorkItemEvidence: vi.fn(actual.collectBusWorkItemEvidence) };
});

let root: string, dir: string, now: number;
const sender = vi.fn(() => ({ status: 'sent' as const, receipt: 'fake-receipt' }));
const run = async (extra: string[] = []) => {
  const code = await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json', ...extra],
    { now: () => now, killed: false, senders: { slack: sender } });
  return { code, report: JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0])) };
};
const post = (id: string) => expect(appendBusInbox({ id, from: 'fake-agent', to: 'fake-lane', priority: 'P2', ttl: 10_000_000, channel: 'slack', channel_ref: 'T0FAKEWS/C0FAKECH/1700000000.000001',
  sender: { agent_id: 'fake-agent', vendor: 'fake', human: false, team: true }, external: false,
  body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
const block = (id: string) => expect(postBusReply(id, `reply-${id}`, { blocked: { dependency: 'fake-dependency' } },
  { root, now: () => now }).outcome).toBe('posted');
const ledger = () => existsSync(boardNotifyLedgerPath(dir)) ? readFileSync(boardNotifyLedgerPath(dir), 'utf8').trim().split('\n') : [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'notify1023-bus-')); dir = mkdtempSync(join(tmpdir(), 'notify1023-state-'));
  chmodSync(root, 0o700); chmodSync(dir, 0o700); now = Date.now(); sender.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); });

it('retains missing evidence for existing and new items while valid work advances, then retries once', async () => {
  post('existing'); post('valid');
  expect((await run()).report.status).toBe('baselined');
  const before = readBoardNotifySnapshot(dir)!;
  now += 1000; post('new-item'); block('existing'); block('new-item'); block('valid');
  const actual = await vi.importActual<typeof import('../src/core/comms/work-item-bus-evidence.js')>('../src/core/comms/work-item-bus-evidence.js');
  vi.mocked(evidence.collectBusWorkItemEvidence).mockImplementation((id, opts) => id === 'valid'
    ? actual.collectBusWorkItemEvidence(id, opts) : { evidence: { id }, sources: { inbox: 'unavailable', claims: 'unavailable', coordination: 'unavailable' } });
  const dry = await run(['--dry-run']);
  expect(dry.report.evidencePending).toHaveLength(2);
  expect(readBoardNotifySnapshot(dir)).toEqual(before);
  for (let pass = 0; pass < 2; pass++) {
    const { code, report } = await run();
    expect(code).toBe(1);
    expect(report).toMatchObject({ pending: 2, sent: pass === 0 ? 1 : 0 });
    expect(report.evidencePending).toEqual(expect.arrayContaining([
      { itemId: 'existing', state: 'BLOCKED', reason: 'BLOCKED dropped: no dependency named' },
      { itemId: 'new-item', state: 'BLOCKED', reason: 'BLOCKED dropped: no dependency named' },
    ]));
    const snapshot = readBoardNotifySnapshot(dir)!;
    expect(snapshot.find(i => i.id === 'existing')).toEqual(before.find(i => i.id === 'existing'));
    expect(snapshot.find(i => i.id === 'new-item')).toBeUndefined();
    expect(ledger()).toHaveLength(1);
  }
  expect(sender).toHaveBeenCalledTimes(1);
  vi.mocked(evidence.collectBusWorkItemEvidence).mockImplementation(actual.collectBusWorkItemEvidence);
  expect((await run()).report).toMatchObject({ pending: 0, sent: 2, evidencePending: [] });
  expect(sender).toHaveBeenCalledTimes(3); expect(ledger()).toHaveLength(3);
  expect((await run()).report).toMatchObject({ pending: 0, sent: 0 });
  // Recreate a prior baseline to exercise the planner's already-notified drop.
  expect(writeBoardNotifySnapshot(dir, before).ok).toBe(true);
  const deduped = await run();
  expect(deduped.code).toBe(0);
  expect(deduped.report).toMatchObject({ pending: 0, evidencePending: [], sent: 0 });
  expect(deduped.report.dropped.every((d: { reason: string }) => d.reason.endsWith('already notified'))).toBe(true);
  expect(sender).toHaveBeenCalledTimes(3);
});
