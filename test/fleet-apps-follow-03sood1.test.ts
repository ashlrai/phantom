import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsFollow } from '../src/cli/fleet-apps-follow.js';
import { createAppsWatchPublisher } from '../src/core/fleet/apps-watch-bus.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { readAppsRecoveryHistory } from '../src/core/fleet/apps-recovery-history.js';

const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'follow-')); roots.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const args = ['--duration-ms', '100', '--jsonl'];
function output() { const log = vi.spyOn(console, 'log').mockImplementation(() => {}); return () => log.mock.calls.map(([line]) => JSON.parse(line as string)); }
const summary = { kind: 'apps-watch.summary.v1' as const, apps: ['Phantom'], outcome: 'completed' as const, cycles: 1, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0, lastObservedState: null };

it('follows real published pages once and resumes after unrelated messages', async () => {
  const dir = root(), publish = createAppsWatchPublisher(dir);
  expect(createAppsWatchPublisher(dir)(summary)).toBe(true);
  expect(publish(summary)).toBe(true);
  const rows = output(); let time = 0;
  expect(await cmdFleetAppsFollow([...args, '--root', dir], { reader: (r, a, _l, id) => readAppsRecoveryHistory(r, a, 1, id), now: () => time, sleep: async ms => { time += ms; } })).toBe(0);
  const lines = rows(), events = lines.filter(row => row.type === 'event');
  expect(events).toHaveLength(2);
  expect(new Set(events.map(row => row.event.cursor)).size).toBe(2);
  expect(lines.at(-1)).toMatchObject({ reason: 'deadline', delivered: 2, nextCursor: 2 });
  expect(appendBusInbox({ id: 'other', from: 'peer', to: 'leaders', priority: 'P2', ttl: 60000, body: 'private' }, { root: dir }).status).toBe('posted');
  const id = events[0].event.invocationId as string;
  const filtered = readAppsRecoveryHistory(dir, 0, 100, id);
  expect(filtered.events).toHaveLength(1);
  time = 0;
  await cmdFleetAppsFollow([...args, '--root', dir, '--after', '2', '--invocation-id', id], { now: () => time, sleep: async ms => { time += ms; } });
  expect(rows().at(-1)).toMatchObject({ delivered: 0, nextCursor: 3 });
});

it('caps events before draining and sleeps on empty history', async () => {
  const dir = root(); for (let i = 0; i < 3; i++) createAppsWatchPublisher(dir)(summary);
  const rows = output();
  await cmdFleetAppsFollow([...args, '--root', dir, '--max-events', '2']);
  expect(rows().at(-1)).toMatchObject({ reason: 'event_limit', delivered: 2, nextCursor: 2 });
  let time = 0; const sleep = vi.fn(async (ms: number) => { time += ms; });
  await cmdFleetAppsFollow([...args, '--root', dir, '--after', '3'], { now: () => time, sleep });
  expect(sleep).toHaveBeenCalledTimes(1);
  expect(rows().at(-1)).toMatchObject({ reason: 'deadline', nextCursor: 3 });
});

it('wakes on abort and reports unavailable and invalid cursor', async () => {
  const dir = root(), rows = output(), controller = new AbortController();
  const pending = cmdFleetAppsFollow(['--duration-ms', '300000', '--root', dir, '--jsonl'], { signal: controller.signal });
  controller.abort(); expect(await pending).toBe(0);
  expect(rows().at(-1).reason).toBe('cancelled');
  chmodSync(dir, 0o755);
  expect(await cmdFleetAppsFollow([...args, '--root', dir])).toBe(1);
  expect(rows().at(-1).reason).toBe('unavailable');
  chmodSync(dir, 0o700);
  expect(await cmdFleetAppsFollow([...args, '--root', dir, '--after', '999'])).toBe(2);
  expect(rows().at(-1).reason).toBe('invalid_cursor');
});

it('rejects malformed flags before reading and offers help', async () => {
  const reader = vi.fn<typeof readAppsRecoveryHistory>();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const flags of [[], ['--duration-ms', '0', '--jsonl'], [...args, '--after', '-1'], [...args, '--interval-ms', '99'], [...args, '--max-events', '1001'], [...args, '--invocation-id', 'bad'], [...args, '--jsonl']]) {
    expect(await cmdFleetAppsFollow(flags, { reader })).toBe(2);
  }
  expect(reader).not.toHaveBeenCalled();
  expect(await cmdFleetAppsFollow(['--help'], { reader })).toBe(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('apps-follow'));
});
