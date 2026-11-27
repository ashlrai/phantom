import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as board from '../src/core/comms/work-board.js';
import * as evidence from '../src/core/comms/work-item-bus-evidence.js';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { planNotifications, readBoardNotifySnapshot, type BoardTransition } from '../src/core/fleet/work-board-notify.js';

const at = '2026-11-13T22:00:00.000Z';
const transition = (to: BoardTransition['to'], fields: Partial<BoardTransition['evidence']>): BoardTransition => ({
  itemId: 'fake-item', from: 'RECEIVED', to, sourceChannel: 'bus', sourceThread: null,
  evidence: { asOf: at, source: 'fake-source', ...fields },
});

afterEach(() => vi.restoreAllMocks());

it('diagnoses blank required evidence and omits blank optional proof', () => {
  const log = vi.fn();
  const plan = planNotifications([
    transition('ASSIGNED', { owner: ' \t', claimReceipt: 'fake-claim' }),
    transition('ASSIGNED', { owner: 'fake-owner', claimReceipt: '\n ' }),
    transition('BLOCKED', { dependency: '\t ' }),
    transition('VERIFIED', { head: ' ', tests: '\n', artifact: '\t' }),
    transition('VERIFIED', { head: ' ', tests: 'fake tests passed', artifact: '\t' }),
  ], new Set(), log);
  expect(plan.dropped.map(d => d.reason)).toEqual([
    'ASSIGNED dropped: no named owner', 'ASSIGNED dropped: no durable claim receipt',
    'BLOCKED dropped: no dependency named', 'VERIFIED dropped: no PR, head or test artifact',
  ]);
  expect(log).toHaveBeenCalledTimes(4);
  expect(plan.notices).toHaveLength(1);
  expect(plan.notices[0]!.detail).toBe('tests fake tests passed');
});

it('keeps missing evidence pending, then sends the corrected same-state update once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notify-blank-'));
  const dir = join(root, 'state');
  const item: board.WorkBoardItem = { id: 'fake-item', channel: 'bus', channelRef: null,
    receivedAt: at, state: 'RECEIVED', asOf: at, source: 'fake-source', missing: [], owner: null, claimReceipt: null };
  let dependency = ' \t';
  vi.spyOn(board, 'listWorkBoard').mockImplementation(() => ({ items: [item], inbox: 'ok', truncated: false }));
  vi.spyOn(evidence, 'collectBusWorkItemEvidence').mockImplementation(() => ({
    evidence: { id: item.id, blocker: { dependency, source: 'fake-source', at } },
    sources: { inbox: 'found', claims: 'missing', coordination: 'missing' },
  }));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const sender = vi.fn().mockResolvedValue({ status: 'sent', receipt: 'fake-receipt' });
  const run = () => cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json'], { senders: { bus: sender }, killed: false });
  const report = () => JSON.parse(String(log.mock.calls.at(-1)![0]));
  try {
    expect(await run()).toBe(0);
    expect(report().status).toBe('baselined');
    item.state = 'BLOCKED';
    expect(await run()).toBe(0);
    expect(report()).toMatchObject({ pending: 1, dropped: [{ reason: 'BLOCKED dropped: no dependency named' }] });
    expect(readBoardNotifySnapshot(dir)?.[0]?.state).toBe('RECEIVED');
    dependency = 'fake dependency';
    expect(await run()).toBe(0);
    expect(report()).toMatchObject({ sent: 1, pending: 0 });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await run()).toBe(0);
    expect(report()).toMatchObject({ transitions: 0, sent: 0 });
    expect(sender).toHaveBeenCalledTimes(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
