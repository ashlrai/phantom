import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsFollow } from '../src/cli/fleet-apps-follow.js';
import { readAppsRecoveryHistory } from '../src/core/fleet/apps-recovery-history.js';
import { createAppsWatchPublisher, type AppsWatchEvent } from '../src/core/fleet/apps-watch-bus.js';

const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'follow-terminal-')); roots.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const base = ['--duration-ms', '100', '--jsonl', '--until-summary'];
const summary = (outcome: 'completed' | 'failed' | 'cancelled'): AppsWatchEvent => ({ kind: 'apps-watch.summary.v1', apps: ['Phantom'], outcome, cycles: 1, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0, lastObservedState: null });
const observation: AppsWatchEvent = { kind: 'apps-watch.observation.v1', cycle: 1, healthy: false, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0, observedState: null };
const lines = () => { const log = vi.spyOn(console, 'log').mockImplementation(() => {}); return () => log.mock.calls.map(([line]) => JSON.parse(line as string)); };

it.each(['completed', 'failed', 'cancelled'] as const)('stops on %s and resumes after the terminal cursor', async outcome => {
  const dir = root(), publish = createAppsWatchPublisher(dir);
  expect(publish(observation)).toBe(true);
  expect(publish(summary(outcome))).toBe(true);
  expect(publish({ ...observation, cycle: 2, recoveries: 1 })).toBe(true);
  const id = readAppsRecoveryHistory(dir, 0, 100).events[0]!.invocationId as string;
  const output = lines(), reader = vi.fn(readAppsRecoveryHistory), sleep = vi.fn();
  expect(await cmdFleetAppsFollow([...base, '--root', dir, '--invocation-id', id, '--max-events', '2'], { reader, sleep })).toBe(outcome === 'failed' ? 1 : 0);
  expect(reader).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
  expect(output()).toHaveLength(3);
  expect(output()[1].event).toMatchObject({ kind: 'apps-watch.summary.v1', outcome });
  expect(output()[2]).toEqual({ type: 'summary', reason: 'invocation_finished', delivered: 2, nextCursor: 2, outcome });
  expect(readAppsRecoveryHistory(dir, output()[2].nextCursor, 100, id).events).toMatchObject([{ cursor: 3, kind: 'apps-watch.observation.v1' }]);
});

it('ignores another invocation and reaches the deadline without a terminal result', async () => {
  const dir = root(), publish = createAppsWatchPublisher(dir);
  expect(publish(observation)).toBe(true);
  expect(createAppsWatchPublisher(dir)(summary('failed'))).toBe(true);
  const id = readAppsRecoveryHistory(dir, 0, 100).events[0]!.invocationId as string;
  const output = lines(); let time = 0;
  expect(await cmdFleetAppsFollow([...base, '--root', dir, '--invocation-id', id], { now: () => time, sleep: async ms => { time += ms; } })).toBe(0);
  expect(output()).toHaveLength(2);
  expect(output().at(-1)).toMatchObject({ reason: 'deadline', delivered: 1, nextCursor: 2 });
});

it('rejects invalid or duplicate flags before reading', async () => {
  const reader = vi.fn(readAppsRecoveryHistory);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const id = '12345678-1234-4123-8123-123456789abc';
  for (const flags of [base, [...base, '--invocation-id', 'bad'], [...base, '--invocation-id', id, '--until-summary'], [...base, '--invocation-id', id, '--invocation-id', id], [...base, 'true', '--invocation-id', id]]) {
    expect(await cmdFleetAppsFollow(flags, { reader })).toBe(2);
  }
  expect(reader).not.toHaveBeenCalled();
});
