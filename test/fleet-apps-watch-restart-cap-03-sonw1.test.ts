import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsWatch } from '../src/cli/fleet-apps-watch.js';
import type { AppsEnsureChildRunner } from '../src/cli/fleet-apps-ensure.js';

let output = '', dir = '', clock = 0;
const events = () => output.trim().split('\n').map(line => JSON.parse(line));
const batch = (apps: unknown[], ok = true) => ({ code: ok ? 0 : 1, stdout: JSON.stringify({ ok, apps }) });
const row = (app: string, launched: boolean, observedRunning: unknown = true) => ({ app, launched, observedRunning });
const args = () => ['Phantom', 'Cursor', '--duration-ms', '200', '--interval-ms', '100', '--root', dir, '--jsonl'];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'watch-cap-')); output = ''; clock = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => { output += text; return true; }) as never);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

it.each([true, false])('stops after a %s healthy cycle reaches the cap', async healthy => {
  const runChild = vi.fn<AppsEnsureChildRunner>().mockResolvedValue(batch([
    row('Phantom', true), row('Cursor', healthy, healthy ? true : null),
  ], healthy));
  const sleep = vi.fn(async (ms: number) => { clock += ms; });
  expect(await cmdFleetAppsWatch([...args(), '--max-recoveries', '1'], { runChild, sleep, now: () => clock })).toBe(1);
  expect(runChild).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
  expect(events()).toMatchObject([
    { type: 'observation', healthy, recoveries: healthy ? 2 : 1 },
    { type: 'summary', outcome: 'failed', reason: 'recovery_limit', recoveries: healthy ? 2 : 1 },
  ]);
});

it('excludes malformed and duplicate rows while counting an unambiguous selected row', async () => {
  const runChild = vi.fn<AppsEnsureChildRunner>().mockResolvedValue(batch([
    row('Phantom', true), row('Phantom', true), row('Cursor', true), { app: 'Other', launched: true }, null,
  ], false));
  expect(await cmdFleetAppsWatch([...args(), '--max-recoveries', '1'], { runChild, sleep: vi.fn(), now: () => clock })).toBe(1);
  expect(events()).toMatchObject([{ recoveries: 1 }, { reason: 'recovery_limit', recoveries: 1 }]);
});

it('does not count a malformed launch row', async () => {
  const runChild = vi.fn<AppsEnsureChildRunner>().mockResolvedValue(batch([row('Phantom', true, 'yes'), row('Cursor', false)], false));
  expect(await cmdFleetAppsWatch([...args(), '--max-recoveries', '1'], { runChild })).toBe(1);
  expect(events()).toMatchObject([{ recoveries: 0 }, { recoveries: 0, outcome: 'failed' }]);
  expect(events()[1]).not.toHaveProperty('reason');
});

it('continues finite supervision when the cap is omitted', async () => {
  const runChild = vi.fn<AppsEnsureChildRunner>().mockResolvedValue(batch([row('Phantom', true), row('Cursor', false)]));
  const sleep = vi.fn(async (ms: number) => { clock += ms; });
  expect(await cmdFleetAppsWatch(args(), { runChild, sleep, now: () => clock })).toBe(0);
  expect(runChild).toHaveBeenCalledTimes(2);
  expect(events().at(-1)).toMatchObject({ outcome: 'completed', recoveries: 2 });
});

it.each([['0'], ['1001'], ['1.5'], ['abc'], ['-1'], [], ['1', '--max-recoveries', '2']])('rejects cap arguments %j before spawning', async (...values) => {
  const runChild = vi.fn<AppsEnsureChildRunner>();
  expect(await cmdFleetAppsWatch([...args(), '--max-recoveries', ...values], { runChild })).toBe(2);
  expect(runChild).not.toHaveBeenCalled();
});
