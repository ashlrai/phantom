import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetBoardNotify } from '../src/cli/fleet-board-notify.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { boardNotifySnapshotPath, readBoardNotifySnapshot, type BoardNotifySender } from '../src/core/fleet/work-board-notify.js';

let root: string, dir: string, now: number;
const sent = () => ({ status: 'sent' as const, receipt: 'fake-receipt' });
const bus = vi.fn<BoardNotifySender>(sent), slack = vi.fn<BoardNotifySender>(sent);
const run = async (flags: string[] = []) => {
  expect(await cmdFleetBoardNotify(['--root', root, '--state-dir', dir, '--json', ...flags],
    { now: () => now, killed: false, senders: { bus, slack } })).toBe(0);
  return JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)![0]));
};
const post = (channel: string, id = `fake-${channel}`) => expect(appendBusInbox({
  id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000, channel,
  channel_ref: channel === 'slack' ? 'T0FAKEWS/C0FAKECH/1700000000.000001' : 'fake-bus-thread',
  sender: { agent_id: 'fake-peer', vendor: 'fake', human: false, team: true }, external: false,
  body: { kind: 'work' },
}, { root, now: () => now }).status).toBe('posted');
const outcomes = () => {
  now += 60_000;
  expect(postBusReply('fake-bus', 'fake-blocked', { blocked: { dependency: 'fake-dependency' } },
    { root, now: () => now }).outcome).toBe('posted');
  expect(postBusReply('fake-slack', 'fake-verified', { verified: { tests: 'fake-test-passed' } },
    { root, now: () => now }).outcome).toBe('posted');
};
const stateFiles = () => readdirSync(dir).sort().map(file => [file, readFileSync(join(dir, file), 'utf8')]);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'notify1022-root-'));
  dir = mkdtempSync(join(tmpdir(), 'notify1022-state-'));
  now = Date.now();
  bus.mockReset().mockImplementation(sent); slack.mockReset().mockImplementation(sent);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  post('bus'); post('slack');
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); });

it.each([['--channel', 'bus'], []])('drains Slack independently, then bus once with %j', async (...flags: string[]) => {
  expect(await run(['--channel', 'slack'])).toMatchObject({ status: 'baselined', items: 2 });
  outcomes();
  const report = await run(['--channel', 'slack']);
  expect(report).toMatchObject({ channel: 'slack', deferred: 1, planned: 1, sent: 1, pending: 0 });
  expect(report.lines).toContain('board-notify selection: channel=slack deferred=1 (bounded board)');
  expect(report.deliveries).toMatchObject([{ itemId: 'fake-slack', state: 'VERIFIED', transport: 'unconfirmed' }]);
  expect(slack).toHaveBeenCalledTimes(1); expect(bus).not.toHaveBeenCalled();
  expect(readBoardNotifySnapshot(dir)?.find(i => i.id === 'fake-bus')?.state).toBe('RECEIVED');
  expect(await run(flags)).toMatchObject({ planned: 1, sent: 1, deferred: 0 });
  expect(await run()).toMatchObject({ planned: 0, sent: 0, channel: null, deferred: 0 });
  expect(bus).toHaveBeenCalledTimes(1); expect(slack).toHaveBeenCalledTimes(1);
});

it('retains selected refusal and excluded new item until an unrestricted retry', async () => {
  await run(); outcomes();
  post('bus', 'fake-new-bus');
  expect(postBusReply('fake-new-bus', 'fake-new-blocked', { blocked: { dependency: 'fake-new-dependency' } },
    { root, now: () => now }).outcome).toBe('posted');
  const before = readFileSync(boardNotifySnapshotPath(dir), 'utf8');
  slack.mockImplementationOnce(() => ({ status: 'refused', reason: 'fake-refusal' }));
  expect(await run(['--channel', 'slack'])).toMatchObject({ sent: 0, pending: 1, deferred: 2 });
  expect(readBoardNotifySnapshot(dir)).toEqual(JSON.parse(before).items);
  expect(readdirSync(dir)).toEqual(['snapshot.json']);
  expect(bus).not.toHaveBeenCalled();
  expect(await run()).toMatchObject({ sent: 3, pending: 0, deferred: 0 });
  expect(await run()).toMatchObject({ sent: 0 });
  expect(bus).toHaveBeenCalledTimes(2); expect(slack).toHaveBeenCalledTimes(2);
});

it('filtered dry runs preserve snapshot and ledger bytes and preview only exact channel matches', async () => {
  await run(); outcomes();
  const before = stateFiles();
  const preview = await run(['--channel', 'slack', '--dry-run']);
  expect(preview).toMatchObject({ planned: 1, deferred: 1, notices: [{ sourceChannel: 'slack' }] });
  expect(preview.notices).toHaveLength(1);
  expect(stateFiles()).toEqual(before);
  expect(await run(['--channel', 'Slack', '--dry-run'])).toMatchObject({ planned: 0, deferred: 2, notices: [] });
  expect(bus).not.toHaveBeenCalled(); expect(slack).not.toHaveBeenCalled();
  await run(['--channel', 'slack']);
  const withLedger = stateFiles();
  expect(await run(['--channel', 'bus', '--dry-run'])).toMatchObject({ planned: 1, deferred: 0 });
  expect(stateFiles()).toEqual(withLedger);
  expect(bus).not.toHaveBeenCalled(); expect(slack).toHaveBeenCalledTimes(1);
});

it.each([['--channel'], ['--channel', ''], ['--channel', '   '], ['--channel', '--json'],
  ['--channel', 'slack', '--channel', 'bus']])('rejects invalid channel arguments %j', async (...args: string[]) => {
  expect(await cmdFleetBoardNotify(args)).toBe(2);
  expect(vi.mocked(console.error).mock.calls.at(-1)?.[0]).toContain('Usage:');
  expect(stateFiles()).toEqual([]);
});
