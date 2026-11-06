import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsWatch } from '../src/cli/fleet-apps-watch.js';
import type { AppsEnsureChildRunner } from '../src/cli/fleet-apps-ensure.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, stat: vi.fn(original.stat) };
});

let dir: string, output: string;
const events = () => output.trim().split('\n').map(line => JSON.parse(line));
const healthy = { code: 0, stdout: JSON.stringify({ ok: true, apps: [{ app: 'Phantom', observedRunning: true }] }) };
const args = (path: string) => ['Phantom', '--duration-ms', '3000', '--interval-ms', '1000', '--stop-file', path, '--jsonl'];
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'apps-watch-'));
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => { output += text; return true; }) as never);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

it('honors a preexisting relative stop file before launching a child', async () => {
  const file = join(dir, 'stop');
  await writeFile(file, 'stop');
  const runner = vi.fn<AppsEnsureChildRunner>();
  expect(await cmdFleetAppsWatch([...args(relative(process.cwd(), file)), '--root', dir], { runChild: runner })).toBe(1);
  expect(runner).not.toHaveBeenCalled();
  expect(events()).toMatchObject([{ type: 'summary', outcome: 'cancelled', cycles: 0 }]);
});

it('aborts an uncooperative child and emits one summary', async () => {
  const file = join(dir, 'stop');
  const entered = deferred();
  let childSignal: AbortSignal | undefined;
  const runner = vi.fn<AppsEnsureChildRunner>((_argv, options) => {
    childSignal = options.signal;
    entered.resolve();
    return new Promise(() => {});
  });
  const watch = cmdFleetAppsWatch(args(file), { runChild: runner });
  await entered.promise;
  await writeFile(file, 'stop');
  expect(await watch).toBe(1);
  expect(childSignal?.aborted).toBe(true);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(events()).toMatchObject([{ type: 'summary', outcome: 'cancelled', cycles: 0 }]);
});

it('stops during an uncooperative sleep without another cycle', async () => {
  const file = join(dir, 'stop');
  const entered = deferred();
  const runner = vi.fn<AppsEnsureChildRunner>(async () => healthy);
  let sleepSignal: AbortSignal | undefined;
  const watch = cmdFleetAppsWatch(args(file), { runChild: runner, sleep: (_ms, signal) => {
    sleepSignal = signal;
    entered.resolve();
    return new Promise(() => {});
  } });
  await entered.promise;
  await writeFile(file, 'stop');
  expect(await watch).toBe(1);
  expect(sleepSignal?.aborted).toBe(true);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(events()).toMatchObject([{ type: 'observation' }, { type: 'summary', outcome: 'cancelled', cycles: 1 }]);
});

it('completes normally when the file is absent', async () => {
  let time = 0;
  const runner = vi.fn<AppsEnsureChildRunner>(async () => healthy);
  expect(await cmdFleetAppsWatch(args(join(dir, 'missing')), { runChild: runner, now: () => time, sleep: async ms => { time += ms; } })).toBe(0);
  expect(events().at(-1)).toMatchObject({ type: 'summary', outcome: 'completed', cycles: 3 });
  expect(events().filter(event => event.type === 'summary')).toHaveLength(1);
});

it('fails on filesystem errors without launching a child', async () => {
  const file = join(dir, 'plain');
  await writeFile(file, 'x');
  const runner = vi.fn<AppsEnsureChildRunner>();
  expect(await cmdFleetAppsWatch(args(join(file, 'stop')), { runChild: runner })).toBe(1);
  expect(runner).not.toHaveBeenCalled();
  expect(events()).toMatchObject([{ type: 'summary', outcome: 'failed', cycles: 0 }]);
});

it.each([
  ['Phantom', '--duration-ms', '1000', '--stop-file'],
  ['Phantom', '--duration-ms', '1000', '--stop-file', '--json'],
  ['Phantom', '--duration-ms', '1000', '--stop-file', 'a', '--stop-file', 'b'],
])('rejects malformed stop-file arguments before filesystem or child work: %j', async argv => {
  const runner = vi.fn<AppsEnsureChildRunner>();
  vi.mocked(stat).mockClear();
  expect(await cmdFleetAppsWatch(argv, { runChild: runner })).toBe(2);
  expect(runner).not.toHaveBeenCalled();
  expect(stat).not.toHaveBeenCalled();
});
