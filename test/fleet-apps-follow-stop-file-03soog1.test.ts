import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsFollow } from '../src/cli/fleet-apps-follow.js';
import { readAppsRecoveryHistory } from '../src/core/fleet/apps-recovery-history.js';
import { createAppsWatchPublisher, type AppsWatchEvent } from '../src/core/fleet/apps-watch-bus.js';

const roots: string[] = [];
const stopRoots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'follow-stop-')); roots.push(dir); return dir; };
const stopDir = () => { const dir = mkdtempSync(join(tmpdir(), 'stop-file-')); stopRoots.push(dir); return dir; };
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const dir of stopRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const base = ['--duration-ms', '100', '--jsonl'];
const summary = (outcome: 'completed' | 'failed' | 'cancelled'): AppsWatchEvent =>
  ({ kind: 'apps-watch.summary.v1', apps: ['Phantom'], outcome, cycles: 1, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0, lastObservedState: null });
const observation: AppsWatchEvent = { kind: 'apps-watch.observation.v1', cycle: 1, healthy: false, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0, observedState: null };

function captureLog() { const log = vi.spyOn(console, 'log').mockImplementation(() => {}); return () => log.mock.calls.map(([line]) => JSON.parse(line as string)); }
function captureErr() { const err = vi.spyOn(console, 'error').mockImplementation(() => {}); return () => err.mock.calls.map(([line]) => line as string); }

it('pre-existing stop file returns summary without calling reader', async () => {
  const dir = root(), sdir = stopDir();
  const stopFile = join(sdir, 'stop');
  writeFileSync(stopFile, 'manual');
  const reader = vi.fn(readAppsRecoveryHistory), output = captureLog();
  expect(await cmdFleetAppsFollow([...base, '--root', dir, '--stop-file', stopFile], { reader })).toBe(1);
  expect(reader).not.toHaveBeenCalled();
  const all = output();
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ type: 'summary', reason: 'stopped', delivered: 0, nextCursor: 0 });
  expect(readFileSync(stopFile, 'utf8')).toBe('manual');
});

it('stop file appearing during idle wait exits within bounded polls', async () => {
  const dir = root(), sdir = stopDir();
  const stopFile = join(sdir, 'stop');
  const publish = createAppsWatchPublisher(dir);
  expect(publish(observation)).toBe(true);
  const id = readAppsRecoveryHistory(dir, 0, 100).events[0]!.invocationId as string;
  let time = 0, resolved = false;
  const output = captureLog();
  const pending = cmdFleetAppsFollow(
    [...base, '--root', dir, '--invocation-id', id, '--interval-ms', '50000', '--stop-file', stopFile],
    {
      now: () => time,
      sleep: async (ms) => {
        if (!resolved) { resolved = true; writeFileSync(stopFile, ''); }
        time += ms;
      },
    },
  );
  expect(await pending).toBe(1);
  const all = output();
  const summaries = all.filter(l => l.type === 'summary');
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toMatchObject({ type: 'summary', reason: 'stopped', delivered: 1, nextCursor: 1 });
});

it('pre-existing stop with checkpoint preserves cursor and emits stopped summary', async () => {
  const dir = root(), sdir = stopDir();
  const stopFile = join(sdir, 'stop');
  const cpFile = join(dir, 'cp.jsonl');
  const id = '00000001-0000-4000-8000-000000000001';
  // Pre-write checkpoint with cursor 3
  writeFileSync(cpFile, JSON.stringify({ version: 1, cursor: 3, invocationId: id }) + '\n');
  writeFileSync(stopFile, '');
  const reader = vi.fn(readAppsRecoveryHistory);
  const output = captureLog();
  expect(await cmdFleetAppsFollow(
    ['--duration-ms', '100', '--root', dir, '--invocation-id', id, '--checkpoint', cpFile, '--stop-file', stopFile, '--jsonl'],
    { reader },
  )).toBe(1);
  const all = output();
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ type: 'summary', reason: 'stopped', delivered: 0, nextCursor: 3 });
  expect(reader).not.toHaveBeenCalled();
  // Verify stop file was NOT modified or deleted
  expect(readFileSync(stopFile, 'utf8')).toBe('');
  // Verify checkpoint was NOT modified (cursor still 3)
  const cp = JSON.parse(readFileSync(cpFile, 'utf8'));
  expect(cp).toMatchObject({ version: 1, cursor: 3, invocationId: id });
});

it('no stop file retains normal deadline behavior', async () => {
  const dir = root(), output = captureLog();
  expect(await cmdFleetAppsFollow([...base, '--root', dir])).toBe(0);
  const all = output();
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ type: 'summary', reason: 'deadline', delivered: 0, nextCursor: 0 });
});

it('pre-existing stop detected before reader with AbortSignal', async () => {
  const dir = root(), sdir = stopDir();
  const stopFile = join(sdir, 'stop');
  writeFileSync(stopFile, '');
  const reader = vi.fn(readAppsRecoveryHistory);
  const log = captureLog();
  expect(await cmdFleetAppsFollow(
    ['--duration-ms', '100', '--root', dir, '--jsonl', '--stop-file', stopFile],
    { reader, signal: AbortSignal.abort() },
  )).toBe(1);
  const calls = log();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ type: 'summary', reason: 'stopped' });
  expect(reader).not.toHaveBeenCalled();
});

it('uncheckable stop-file reports explicit error', async () => {
  const dir = root(), sdir = stopDir();
  const stopFile = join(sdir, 'stop');
  const errLog = captureErr();
  const log = captureLog();
  writeFileSync(stopFile, '', { mode: 0o000 });
  const reader = vi.fn(readAppsRecoveryHistory);
  expect(await cmdFleetAppsFollow(
    ['--duration-ms', '100', '--root', dir, '--jsonl', '--stop-file', stopFile],
    { reader },
  )).toBe(1);
  expect(reader).not.toHaveBeenCalled();
  expect(errLog()).toContainEqual(expect.stringContaining('unable to check stop-file'));
  const calls = log();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ type: 'summary', reason: 'stopped' });
});
