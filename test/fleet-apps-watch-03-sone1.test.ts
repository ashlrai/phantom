import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsWatch } from '../src/cli/fleet-apps-watch.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import type { AppsEnsureChildRunner } from '../src/cli/fleet-apps-ensure.js';

let output = '';
const events = () => output.trim().split('\n').map(line => JSON.parse(line));
const batch = (launched = false) => ({ code: 0, stdout: JSON.stringify({ ok: true, apps: [
  { app: 'Phantom', observedRunning: true, launched }, { app: 'Cursor', observedRunning: true, launched: false },
] }) });
const args = ['Phantom', 'Cursor', '--duration-ms', '200', '--interval-ms', '100', '--jsonl'];
beforeEach(() => {
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => { output += text; return true; }) as never);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

it('resolves the public verb through the registry', async () => {
  const resolved = resolveFleetSubcommand('apps-watch')!;
  const module = await FLEET_SUBCOMMAND_LOADERS['apps-watch']!();
  expect(resolved.module).toBe('./fleet-apps-watch.js');
  expect(module[resolved.exportName]).toBe(cmdFleetAppsWatch);
});

it('supervises two ordered apps, forwards the remaining budget, and reports recovery', async () => {
  let clock = 0, active = 0;
  const runner = vi.fn<AppsEnsureChildRunner>(async () => {
    expect(++active).toBe(1);
    await Promise.resolve();
    active--;
    return batch(runner.mock.calls.length === 1);
  });
  expect(await cmdFleetAppsWatch(['Phantom', 'Cursor', 'Phantom', '--root', '/fake/root', ...args.slice(2)], {
    runChild: runner, now: () => clock, sleep: async ms => { clock += ms; },
  })).toBe(0);
  expect(runner.mock.calls.map(([argv, options]) => [argv, options.timeoutMs])).toEqual([200, 100].map(n => [
    ['fleet', 'apps-ensure', 'Phantom', 'Cursor', '--json', '--root', '/fake/root', '--timeout-ms', String(n)], n,
  ]));
  expect(events()).toMatchObject([
    { type: 'observation', healthy: true, recoveries: 1 },
    { type: 'observation', healthy: true, recoveries: 0 },
    { type: 'summary', apps: ['Phantom', 'Cursor'], outcome: 'completed', cycles: 2, recoveries: 1,
      lastObservedState: [{ app: 'Phantom', observedRunning: true }, { app: 'Cursor', observedRunning: true }] },
  ]);
});

it.each([
  [], ['Phantom'], ['--duration-ms', '1'], ['Bad', '--duration-ms', '1'],
  ['Phantom', '--duration-ms', '0'], ['Phantom', '--duration-ms', '1', '--duration-ms', '2'],
  ['Phantom', '--duration-ms', '1', '--json', '--jsonl'], ['Phantom', '--duration-ms', '1', '--interval-ms', '99'],
  ['Phantom', '--duration-ms', '1', '--wat'],
].map(argv => ({ argv })))('rejects invalid arguments without a child: $argv', async ({ argv }) => {
  const runner = vi.fn<AppsEnsureChildRunner>();
  expect(await cmdFleetAppsWatch(argv, { runChild: runner })).toBe(2);
  expect(runner).not.toHaveBeenCalled();
});

it.each([
  { code: 0, stdout: 'private child output' },
  { code: 0, stdout: JSON.stringify({ ok: true, apps: [{ app: 'Phantom', observedRunning: true }] }) },
  { code: 0, stdout: JSON.stringify({ ok: true, apps: [{ app: 'Phantom', observedRunning: true }, { app: 'Phantom', observedRunning: true }] }) },
  { code: 1, stdout: JSON.stringify({ ok: false, apps: [{ app: 'Phantom', observedRunning: false, outcome: 'refused' }, { app: 'Cursor', observedRunning: true }] }) },
  { ...batch(), code: 1 },
])('fails closed on malformed or unsuccessful batches', async result => {
  expect(await cmdFleetAppsWatch(['Phantom', 'Cursor', '--duration-ms', '1000', '--json'], { runChild: async () => result })).toBe(1);
  expect(events()).toHaveLength(1);
  expect(events()[0]).toMatchObject({ outcome: 'failed', cycles: 1 });
  expect(output).not.toContain('private child output');
});

it('retains the last observed state after an invalid later batch', async () => {
  let clock = 0;
  const runner = vi.fn<AppsEnsureChildRunner>().mockResolvedValueOnce(batch()).mockResolvedValueOnce({ code: 0, stdout: '{}' });
  expect(await cmdFleetAppsWatch(args, { runChild: runner, now: () => clock, sleep: async ms => { clock += ms; } })).toBe(1);
  expect(events().at(-1)).toMatchObject({ outcome: 'failed', cycles: 2, lastObservedState: [{ app: 'Phantom', observedRunning: true }, { app: 'Cursor', observedRunning: true }] });
});

it.each(['before', 'child', 'sleep'] as const)('cancels %s without starting another child', async stage => {
  const controller = new AbortController();
  const runner = vi.fn<AppsEnsureChildRunner>(async () => {
    if (stage === 'child') { controller.abort(); return new Promise(() => {}); }
    return batch();
  });
  if (stage === 'before') controller.abort();
  expect(await cmdFleetAppsWatch(args, { runChild: runner, signal: controller.signal, sleep: async () => { controller.abort(); return new Promise(() => {}); } })).toBe(1);
  expect(runner).toHaveBeenCalledTimes(stage === 'before' ? 0 : 1);
  expect(events().at(-1)).toMatchObject({ outcome: 'cancelled' });
});

it('bounds a hung child by real time and reports failure', async () => {
  const runner = vi.fn<AppsEnsureChildRunner>(() => new Promise(() => {}));
  expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '30', '--json'], { runChild: runner, now: () => 0 })).toBe(1);
  expect(events()[0]).toMatchObject({ outcome: 'failed', cycles: 0, lastObservedState: null });
  expect(runner).toHaveBeenCalledTimes(1);
});

it('bounds an uncooperative sleep by real time and completes a healthy interval', async () => {
  expect(await cmdFleetAppsWatch(['Phantom', 'Cursor', '--duration-ms', '30', '--json'], { runChild: async () => batch(), now: () => 0, sleep: () => new Promise(() => {}) })).toBe(0);
  expect(events()[0]).toMatchObject({ outcome: 'completed', cycles: 1 });
});
