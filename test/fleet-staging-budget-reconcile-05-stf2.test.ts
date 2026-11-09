import { describe, expect, it } from 'vitest';
import { cmdFleetStagingInventory } from '../src/cli/fleet-staging-inventory.js';
import {
  DEFAULT_MAX_DURATION_MS, DU_TIMEOUT_MS, MAX_DURATION_MS_LIMIT, type InventoryDeps,
} from '../src/core/fleet/staging-inventory.js';

// Fake monotonic clock: time only moves when a seam advances it, so nothing sleeps.
function fakeClock() {
  let now = 0;
  return { clock: () => now, advance: (ms: number) => { now += ms; } };
}
const child = (name: string) => ({ name, modifiedAt: '2026-11-05T00:00:00.000Z' });
const listing = (names: string[]) => async () => ({ state: 'ok' as const, children: names.map(child), skippedSymlinks: 0, truncated: false });
async function run(args: string[], deps: InventoryDeps = {}) {
  const lines: string[] = [];
  const code = await cmdFleetStagingInventory(args, { ...deps, output: { log: s => lines.push(s), error: s => lines.push(s) } });
  return { code, lines, json: () => JSON.parse(lines.join('\n')) };
}

describe('staging inventory scan budget (async reconcile)', () => {
  it('rejects invalid --max-duration-ms values before any measurement', async () => {
    const calls: string[] = [];
    const deps: InventoryDeps = { list: listing(['a']), measure: (path, _timeoutMs) => { calls.push(path); return 1; } };
    const invalid = ['0', '-1', '1.5', '1e3', '+5', 'abc', '', '--json', String(MAX_DURATION_MS_LIMIT + 1), '9007199254740993'];
    for (const value of invalid) {
      expect((await run(['--root', '/fake', '--max-duration-ms', value], deps)).code, value).toBe(2);
    }
    expect((await run(['--root', '/fake', '--max-duration-ms'], deps)).code).toBe(2);
    expect((await run(['--root', '/fake', '--max-duration-ms', '5', '--max-duration-ms', '5'], deps)).code).toBe(2);
    expect(calls).toEqual([]);
  });
  it('accepts a bounded positive integer and documents the default in --help', async () => {
    const deps: InventoryDeps = { list: listing(['a']), measure: (_path, _timeoutMs) => 1 };
    expect(((await run(['--root', '/fake', '--max-duration-ms', '1', '--json'], deps)).json()).budget.maxDurationMs).toBe(1);
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.lines.join('\n')).toContain(`default ${DEFAULT_MAX_DURATION_MS}`);
    expect(help.lines.join('\n')).toContain('--max-duration-ms');
  });
  it('reports a complete inventory with full budget and no timeout reduction', async () => {
    const { clock, advance } = fakeClock();
    const timeouts: number[] = [];
    const deps: InventoryDeps = {
      list: async () => ({ state: 'ok', children: [child('a'), child('b')], skippedSymlinks: 1, truncated: false }),
      clock,
      measure: (_path, timeoutMs) => { timeouts.push(timeoutMs); advance(5); return 2048; },
    };
    const report = (await run(['--root', '/fake', '--json'], deps)).json();
    expect(report.complete).toBe(true);
    expect(report.incompleteReasons).toEqual([]);
    expect(report.source).toBe('ok');
    expect(report.skippedSymlinks).toBe(1);
    expect(report.totalMeasuredBytes).toBe(4096);
    expect(report.measurements).toEqual({ measured: 2, unmeasured: 0, failed: 0, notAttempted: 0 });
    expect(report.budget).toEqual({ maxDurationMs: DEFAULT_MAX_DURATION_MS, elapsedMs: 10, exhausted: false });
    expect(timeouts).toEqual([DU_TIMEOUT_MS, DU_TIMEOUT_MS]);
    const human = (await run(['--root', '/fake'], deps)).lines.join('\n');
    expect(human).toContain('source: ok; complete');
    expect(human).not.toContain('lower bound');
  });
  it('treats a measurement timeout as a failed entry, not as budget exhaustion', async () => {
    const { clock, advance } = fakeClock();
    const deps: InventoryDeps = {
      list: listing(['slow', 'fast']),
      clock,
      measure: (path, _timeoutMs) => {
        if (path.endsWith('slow')) { advance(1000); throw Error('du timed out'); }
        advance(1);
        return 512;
      },
    };
    const report = (await run(['--root', '/fake', '--json'], deps)).json();
    const slow = report.entries.find((e: { name: string }) => e.name === 'slow');
    expect(slow.bytes).toBeNull();
    expect(slow.measurement).toBe('failed');
    expect(report.entries.find((e: { name: string }) => e.name === 'fast').bytes).toBe(512);
    expect(report.incompleteReasons).toEqual(['measurement-failed']);
    expect(report.budget.exhausted).toBe(false);
    expect(report.measurements).toEqual({ measured: 1, unmeasured: 1, failed: 1, notAttempted: 0 });
    expect(report.totalMeasuredBytes).toBe(512);
    expect(report.source).toBe('degraded');
  });
  it('caps each du timeout to the remaining budget, keeps earlier results and starts no extra child', async () => {
    const timeouts: Array<[string, number]> = [];
    const sizes: Record<string, number> = { a: 1, b: 2, c: 3 };
    // A fresh clock per run: each run must start with the full budget.
    const makeDeps = (): InventoryDeps => {
      const { clock, advance } = fakeClock();
      return {
        list: listing(['a', 'b', 'c', 'd']),
        clock,
        measure: (path, timeoutMs) => {
          const name = path.split('/').pop()!;
          timeouts.push([name, timeoutMs]);
          advance(name === 'a' ? 600 : name === 'b' ? 300 : 100);
          return sizes[name]!;
        },
      };
    };
    const result = await run(['--root', '/fake', '--max-duration-ms', '1000', '--json'], makeDeps());
    const report = result.json();
    // a: 1000 ms left, b: 400 left after a's 600, c: 100 left after b's 300, d: none left.
    expect(timeouts).toEqual([['a', 1000], ['b', 400], ['c', 100]]);
    const byName = (name: string) => report.entries.find((e: { name: string }) => e.name === name);
    expect(byName('a').bytes).toBe(1);
    expect(byName('c').bytes).toBe(3);
    expect(byName('d').bytes).toBeNull();
    expect(byName('d').measurement).toBe('not-attempted');
    expect(report.incompleteReasons).toEqual(['budget-exhausted']);
    expect(report.complete).toBe(false);
    expect(report.budget).toEqual({ maxDurationMs: 1000, elapsedMs: 1000, exhausted: true });
    expect(report.measurements).toEqual({ measured: 3, unmeasured: 1, failed: 0, notAttempted: 1 });
    expect(report.totalMeasuredBytes).toBe(6);
    const human = (await run(['--root', '/fake', '--max-duration-ms', '1000'], makeDeps())).lines.join('\n');
    expect(human).toContain('incomplete');
    expect(human).toContain('Incomplete reasons: budget-exhausted');
    expect(human).toContain('(exhausted)');
    expect(human).toContain('"d": not measured (budget exhausted)');
    expect(human).toContain('Total excludes 1 unmeasured entries; it is a lower bound.');
    expect(human).toContain('not reclaimable');
  });
  it('exhausts the budget during listing and starts no measurement', async () => {
    const { clock, advance } = fakeClock();
    let measureCalls = 0;
    const deps: InventoryDeps = {
      list: async () => { advance(50); return { state: 'ok', children: [child('a'), child('b')], skippedSymlinks: 0, truncated: false }; },
      clock,
      measure: (_path, _timeoutMs) => { measureCalls++; return 1; },
    };
    const report = (await run(['--root', '/fake', '--max-duration-ms', '50', '--json'], deps)).json();
    expect(measureCalls).toBe(0);
    expect(report.entries.map((e: { bytes: unknown }) => e.bytes)).toEqual([null, null]);
    expect(report.incompleteReasons).toEqual(['budget-exhausted']);
    expect(report.complete).toBe(false);
    expect(report.measurements).toEqual({ measured: 0, unmeasured: 2, failed: 0, notAttempted: 2 });
    expect(report.totalMeasuredBytes).toBe(0);
  });
  it('treats a sub-millisecond remainder as exhausted rather than passing a zero du timeout', async () => {
    const { clock, advance } = fakeClock();
    let measureCalls = 0;
    const deps: InventoryDeps = {
      list: async () => { advance(0.5); return { state: 'ok', children: [child('a')], skippedSymlinks: 0, truncated: false }; },
      clock,
      measure: (_path, _timeoutMs) => { measureCalls++; return 1; },
    };
    const report = (await run(['--root', '/fake', '--max-duration-ms', '1', '--json'], deps)).json();
    expect(measureCalls).toBe(0);
    expect(report.budget.exhausted).toBe(true);
  });
  it('keeps listing failure distinct from budget exhaustion', async () => {
    let measureCalls = 0;
    const deps: InventoryDeps = {
      list: async () => { throw Error('unreadable'); },
      measure: (_path, _timeoutMs) => { measureCalls++; return 1; },
    };
    const report = (await run(['--root', '/fake', '--json'], deps)).json();
    expect(measureCalls).toBe(0);
    expect(report.incompleteReasons).toEqual(['listing-degraded']);
    expect(report.budget.exhausted).toBe(false);
    expect(report.source).toBe('degraded');
    expect(report.complete).toBe(false);
  });
  it('proves the default process runner remains asynchronous with bounded timeout', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const base = await mkdtemp(join(tmpdir(), 'staging-budget-async-'));
    try {
      const root = join(base, 'staging'); await mkdir(root);
      const bin = join(root, 'bin'); await mkdir(bin);
      // Async du: writes started, waits for release file, then outputs.
      const started = join(root, 'started'); const release = join(root, 'release');
      const script = `#!${process.execPath}\nconst fs = require('node:fs');\nconst [s, r] = ${JSON.stringify([started, release])};\nfs.appendFileSync(s, process.pid + '\\n');\nconst timer = setInterval(() => { if (fs.existsSync(r)) { clearInterval(timer); console.log('1\\tasync-ok'); } }, 10);\n`;
      await writeFile(join(bin, 'du'), script, { mode: 0o755 });
      const originalPath = process.env.PATH;
      process.env.PATH = bin;
      // Write the release file immediately so the async du finishes quickly.
      await writeFile(release, 'go');
      const child = (name: string) => ({ name, modifiedAt: '2026-11-05T00:00:00.000Z' });
      const report = await (await import('../src/core/fleet/staging-inventory.js')).inventoryStaging(root, {
        list: async () => ({ state: 'ok', children: [child('a'), child('b')], skippedSymlinks: 0, truncated: false }),
      });
      expect(report.entries.map((e: { bytes: unknown }) => e.bytes)).toEqual([1024, 1024]);
      expect(report.measurements.measured).toBe(2);
      expect(report.budget.exhausted).toBe(false);
      process.env.PATH = originalPath;
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});
