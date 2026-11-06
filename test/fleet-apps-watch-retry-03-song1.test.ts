import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const healthyWithLaunch = { code: 0, stdout: JSON.stringify({ ok: true, apps: [{ app: 'Phantom', observedRunning: true, launched: true }] }) };
const failed = { code: 1, stdout: JSON.stringify({ ok: false, apps: [{ app: 'Phantom', observedRunning: false }] }) };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'apps-watch-retry-'));
  output = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => { output += text; return true; }) as never);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

it('rejects --max-consecutive-failures before launching a child: missing value', async () => {
  const runner = vi.fn<AppsEnsureChildRunner>();
  expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '1000', '--max-consecutive-failures'], { runChild: runner })).toBe(2);
  expect(runner).not.toHaveBeenCalled();
});

it('rejects --max-consecutive-failures before launching a child: value 0', async () => {
  const runner = vi.fn<AppsEnsureChildRunner>();
  expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '1000', '--max-consecutive-failures', '0'], { runChild: runner })).toBe(2);
  expect(runner).not.toHaveBeenCalled();
});

it('rejects --max-consecutive-failures before launching a child: value 11', async () => {
  const runner = vi.fn<AppsEnsureChildRunner>();
  expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '1000', '--max-consecutive-failures', '11'], { runChild: runner })).toBe(2);
  expect(runner).not.toHaveBeenCalled();
});

it('rejects --max-consecutive-failures before launching a child: duplicate', async () => {
  const runner = vi.fn<AppsEnsureChildRunner>();
  expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '1000', '--max-consecutive-failures', '3', '--max-consecutive-failures', '5'], { runChild: runner })).toBe(2);
  expect(runner).not.toHaveBeenCalled();
});

it('rejects --max-consecutive-failures before launching a child: non-numeric', async () => {
  const runner = vi.fn<AppsEnsureChildRunner>();
  expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '1000', '--max-consecutive-failures', 'abc'], { runChild: runner })).toBe(2);
  expect(runner).not.toHaveBeenCalled();
});

it('rejects --max-consecutive-failures before launching a child: value exceeds 10', async () => {
  const runner = vi.fn<AppsEnsureChildRunner>();
  expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '1000', '--max-consecutive-failures', '20'], { runChild: runner })).toBe(2);
  expect(runner).not.toHaveBeenCalled();
});

it('launches nothing when options are invalid', async () => {
  const runner = vi.fn<AppsEnsureChildRunner>();
  const result = await cmdFleetAppsWatch(['Phantom', '--duration-ms', '1000', '--max-consecutive-failures', '3', '--wat'], { runChild: runner });
  expect(result).toBe(2);
  expect(runner).not.toHaveBeenCalled();
});

it('a failed cycle then success then another failure resets the streak', async () => {
  let clock = 0;
  let callCount = 0;
  const runner = vi.fn<AppsEnsureChildRunner>(async () => {
    callCount++;
    if (callCount === 1) return failed;
    if (callCount === 2) return healthy;
    return failed;
  });
  expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '500', '--interval-ms', '100', '--max-consecutive-failures', '3', '--jsonl'], {
    runChild: runner, now: () => clock, sleep: async ms => { clock += ms; },
  })).toBe(1);
  const evts = events();
  expect(evts.length).toBeGreaterThanOrEqual(3);
  expect(evts[0]).toMatchObject({ type: 'observation', cycle: 1, healthy: false, consecutiveFailures: 1, totalFailedCycles: 1 });
  expect(evts[1]).toMatchObject({ type: 'observation', cycle: 2, healthy: true, consecutiveFailures: 0, totalFailedCycles: 1 });
  expect(evts[2]).toMatchObject({ type: 'observation', cycle: 3, healthy: false, consecutiveFailures: 1, totalFailedCycles: 2 });
  const summary = evts.find(e => e.type === 'summary');
  // 4+ totalFailedCycles exceeds the ceiling of 3 — only possible because cycle 2 reset the streak
  expect(summary).toMatchObject({ outcome: 'failed', cycles: 5 });
  expect(summary!.totalFailedCycles).toBeGreaterThanOrEqual(4);
  expect(runner).toHaveBeenCalledTimes(5);
});

it('two consecutive failures stop at ceiling 2', async () => {
  let clock = 0;
  const runner = vi.fn<AppsEnsureChildRunner>(async () => failed);
  expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '600', '--interval-ms', '100', '--max-consecutive-failures', '2', '--jsonl'], {
    runChild: runner, now: () => clock, sleep: async ms => { clock += ms; },
  })).toBe(1);
  const evts = events();
  expect(evts.length).toBeGreaterThanOrEqual(2);
  expect(evts[0]).toMatchObject({ type: 'observation', cycle: 1, healthy: false, consecutiveFailures: 1, totalFailedCycles: 1 });
  expect(evts[1]).toMatchObject({ type: 'observation', cycle: 2, healthy: false, consecutiveFailures: 2, totalFailedCycles: 2 });
  const summary = evts.find(e => e.type === 'summary');
  expect(summary).toMatchObject({ outcome: 'failed', cycles: 2, consecutiveFailures: 2, totalFailedCycles: 2 });
  expect(runner).toHaveBeenCalledTimes(2);
});

it('default still stops at first failure (maxConsecutiveFailures=1)', async () => {
  let clock = 0;
  const runner = vi.fn<AppsEnsureChildRunner>(async () => failed);
  expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '600', '--jsonl'], {
    runChild: runner, now: () => clock, sleep: async ms => { clock += ms; },
  })).toBe(1);
  const evts = events();
  expect(evts.length).toBeGreaterThanOrEqual(2);
  expect(evts[0]).toMatchObject({ type: 'observation', cycle: 1, healthy: false, consecutiveFailures: 1, totalFailedCycles: 1 });
  const summary = evts.find(e => e.type === 'summary');
  expect(summary).toMatchObject({ outcome: 'failed', cycles: 1, consecutiveFailures: 1, totalFailedCycles: 1 });
  expect(runner).toHaveBeenCalledTimes(1);
});

it('pending child cancellation during retry sleep prevents another launch', async () => {
  const file = join(dir, 'stop');
  const clock = 0;
  let enterSleep: (() => void) | undefined;
  const runner = vi.fn<AppsEnsureChildRunner>(async () => failed);
  const watch = cmdFleetAppsWatch(['Phantom', '--duration-ms', '600', '--interval-ms', '200', '--max-consecutive-failures', '3', '--stop-file', file, '--jsonl'], {
    runChild: runner, now: () => clock,
    sleep: async (ms, signal) => {
      await new Promise<void>(r => {
        enterSleep = r;
        signal.addEventListener('abort', r, { once: true });
      });
    },
  });
  await new Promise<void>(r => {
    const check = setInterval(() => { if (enterSleep) { clearInterval(check); r(); } }, 5);
  });
  await writeFile(file, 'stop');
  enterSleep!();
  expect(await watch).toBe(1);
  const evts = events();
  expect(evts.find(e => e.type === 'summary')).toMatchObject({ outcome: 'cancelled', cycles: 1 });
  expect(runner).toHaveBeenCalledTimes(1);
});

it('stop-file during retry sleep prevents another launch', async () => {
  const file = join(dir, 'stop');
  const clock = 0;
  let enterSleep: (() => void) | undefined;
  const runner = vi.fn<AppsEnsureChildRunner>(async () => failed);
  const watch = cmdFleetAppsWatch(['Phantom', '--duration-ms', '600', '--interval-ms', '200', '--max-consecutive-failures', '3', '--stop-file', file, '--jsonl'], {
    runChild: runner, now: () => clock,
    sleep: async (ms, signal) => {
      await new Promise<void>(r => {
        enterSleep = r;
        signal.addEventListener('abort', r, { once: true });
      });
    },
  });
  await new Promise<void>(r => {
    const check = setInterval(() => { if (enterSleep) { clearInterval(check); r(); } }, 5);
  });
  await writeFile(file, 'stop');
  enterSleep!();
  expect(await watch).toBe(1);
  const evts = events();
  expect(evts.find(e => e.type === 'summary')).toMatchObject({ outcome: 'cancelled', cycles: 1 });
  expect(runner).toHaveBeenCalledTimes(1);
});

it('duration is one shared budget across retries and recovers when middle failure resolves', async () => {
  let clock = 0;
  let callCount = 0;
  const runner = vi.fn<AppsEnsureChildRunner>(async () => {
    callCount++;
    return callCount === 1 ? failed : healthyWithLaunch;
  });
  expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '120', '--interval-ms', '100', '--max-consecutive-failures', '3', '--jsonl'], {
    runChild: runner, now: () => clock, sleep: async ms => { clock += ms; },
  })).toBe(0);
  const evts = events();
  const summary = evts.find(e => e.type === 'summary');
  expect(summary).toMatchObject({ outcome: 'completed', cycles: 2 });
  expect(summary!.recoveries).toBe(1);
  expect(runner).toHaveBeenCalledTimes(2);
});

it('ends unsuccessfully when the last cycle failed before duration elapsed', async () => {
  let clock = 0;
  const runner = vi.fn<AppsEnsureChildRunner>(async () => failed);
  expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '250', '--interval-ms', '100', '--max-consecutive-failures', '3', '--jsonl'], {
    runChild: runner, now: () => clock, sleep: async ms => { clock += ms; },
  })).toBe(1);
  const evts = events();
  const summary = evts.find(e => e.type === 'summary');
  expect(summary).toMatchObject({ outcome: 'failed' });
  expect(runner).toHaveBeenCalledTimes(3);
});

it('forward argv and root to child: max-consecutive-failures option included', async () => {
  let clock = 0;
  const runner = vi.fn<AppsEnsureChildRunner>(async () => healthy);
  expect(await cmdFleetAppsWatch(['Phantom', 'Cursor', '--duration-ms', '200', '--interval-ms', '100', '--root', '/fake/root', '--max-consecutive-failures', '5', '--jsonl'], {
    runChild: runner, now: () => clock, sleep: async ms => { clock += ms; },
  })).toBe(0);
  expect(runner.mock.calls[0]![0]).toEqual([
    'fleet', 'apps-ensure', 'Phantom', 'Cursor', '--json', '--root', '/fake/root', '--timeout-ms', '200',
  ]);
  expect(runner.mock.calls[0]![1].timeoutMs).toBe(200);
  const summary = events().find(e => e.type === 'summary');
  expect(summary).toMatchObject({ apps: ['Phantom', 'Cursor'], outcome: 'completed' });
});

it('JSON output includes consecutiveFailures and totalFailedCycles', async () => {
  let clock = 0;
  let callCount = 0;
  const runner = vi.fn<AppsEnsureChildRunner>(async () => {
    callCount++;
    return callCount === 1 ? failed : healthyWithLaunch;
  });
  expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '120', '--interval-ms', '100', '--max-consecutive-failures', '3', '--json'], {
    runChild: runner, now: () => clock, sleep: async ms => { clock += ms; },
  })).toBe(0);
  const summary = JSON.parse(output.trim());
  expect(summary).toHaveProperty('consecutiveFailures');
  expect(summary).toHaveProperty('totalFailedCycles');
  expect(typeof summary.consecutiveFailures).toBe('number');
  expect(typeof summary.totalFailedCycles).toBe('number');
});
