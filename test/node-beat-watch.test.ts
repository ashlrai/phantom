/**
 * `phm node beat --watch [--every <seconds>]` keeps a node session alive by
 * repeating the ordinary beat — the keep-alive docs/add-a-computer.md could
 * not previously offer, since a join's session expires 30 s after the last
 * beat. The watch flags are dispatcher-level: stripped before the beat parser
 * sees them, so the fleet flag table and the pool wire protocol are unchanged.
 * Capacity and host stats are re-measured on this machine each pass (the same
 * fresh samples the pool worker reports) unless the caller passed them
 * explicitly; usage and auth are never invented.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { NodeCapacity } from '../src/core/drive/nodes/capacity.js';
import type { HostStats } from '../src/core/drive/nodes/state.js';
import { isNodeCapacity } from '../src/core/drive/nodes/state.js';
import { cmdNodeBeatWatch, type NodeBeatWatchDeps } from '../src/cli/node-beat-watch.js';
import { cmdNode } from '../src/cli/node.js';

const GIB = 1024 ** 3;
const ready: NodeCapacity = { ramBytes: 16 * GIB, slots: 11, held: null };
const stats: HostStats = { sampledAtMs: 1, uptimeSeconds: 1, load: [1, 1, 1], ramTotal: 1, ramUsed: 1, diskFree: 1, cores: [] };

function capture() {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation((line: string) => { lines.push(String(line)); });
  return lines;
}
const lastJson = (lines: string[]) => JSON.parse(lines.at(-1)!);
afterEach(() => vi.restoreAllMocks());

/** A run that records each beat's args and stops the watch after `beats` passes. */
function recorder(beats: number, ac: AbortController, codes: number[] = []) {
  const seen: string[][] = [];
  let calls = 0;
  return {
    seen,
    run: async (args: string[]) => {
      seen.push([...args]);
      calls += 1;
      if (calls >= beats) ac.abort();
      return codes.shift() ?? 0;
    },
  };
}

const baseDeps = (ac: AbortController, extra: Partial<NodeBeatWatchDeps> = {}): NodeBeatWatchDeps => ({
  signal: ac.signal,
  sleep: async () => undefined,
  measure: () => ready,
  hostStats: () => stats,
  now: () => 1_700_000_000_000,
  host: () => 'watch-node',
  ...extra,
});

describe('phm node beat --watch', () => {
  it('repeats the beat until the stop signal, stripping --watch and --every', async () => {
    const ac = new AbortController();
    const { seen, run } = recorder(3, ac);
    const lines = capture();
    expect(await cmdNodeBeatWatch(['--node', 'n1', '--session', '1', '--watch', '--every', '5', '--json'],
      baseDeps(ac, { run }))).toBe(0);
    expect(seen).toHaveLength(3);
    for (const args of seen) {
      expect(args).not.toContain('--watch');
      expect(args).not.toContain('--every');
      expect(args).not.toContain('5');
      expect(args).toEqual(expect.arrayContaining(['--node', 'n1', '--session', '1', '--json']));
    }
    expect(lastJson(lines)).toEqual({ schemaVersion: 1, command: 'beat', watch: { stopped: 'signal', everySeconds: 5 } });
  });

  it('injects a freshly measured capacity sample and host stats each pass', async () => {
    const ac = new AbortController();
    const { seen, run } = recorder(2, ac);
    let tick = 0;
    capture();
    await cmdNodeBeatWatch(['--node', 'n1', '--session', '1', '--watch'],
      baseDeps(ac, { run, now: () => 1_700_000_000_000 + tick++ }));
    for (const args of seen) {
      const at = args.indexOf('--capacity');
      expect(at).toBeGreaterThanOrEqual(0);
      const sample = JSON.parse(args[at + 1]!) as Record<string, unknown>;
      expect(isNodeCapacity(sample)).toBe(true);
      expect(sample).toMatchObject({ hostId: 'watch-node', slots: 11, held: null });
      const hs = args.indexOf('--host-stats');
      expect(hs).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(args[hs + 1]!)).toEqual(stats);
    }
    // Re-measured, not replayed: the second pass carries a newer sampledAtMs.
    const first = JSON.parse(seen[0]![seen[0]!.indexOf('--capacity') + 1]!) as { sampledAtMs: number };
    const second = JSON.parse(seen[1]![seen[1]!.indexOf('--capacity') + 1]!) as { sampledAtMs: number };
    expect(second.sampledAtMs).toBeGreaterThan(first.sampledAtMs);
  });

  it('respects caller-supplied --capacity and --host-stats instead of re-measuring', async () => {
    const ac = new AbortController();
    const { seen, run } = recorder(2, ac);
    const measure = vi.fn(() => ready);
    const hostStats = vi.fn(() => stats);
    capture();
    await cmdNodeBeatWatch(['--node', 'n1', '--session', '1', '--watch',
      '--capacity', '{"fixed":true}', '--host-stats', '{"fixed":true}'],
      baseDeps(ac, { run, measure, hostStats }));
    expect(measure).not.toHaveBeenCalled();
    expect(hostStats).not.toHaveBeenCalled();
    for (const args of seen) {
      expect(args.filter(a => a === '--capacity')).toHaveLength(1);
      expect(args[args.indexOf('--capacity') + 1]).toBe('{"fixed":true}');
      expect(args[args.indexOf('--host-stats') + 1]).toBe('{"fixed":true}');
    }
  });

  it('omits the capacity sample when measurement fails or reports an unexpressible hold', async () => {
    const ac = new AbortController();
    const { seen, run } = recorder(2, ac);
    capture();
    await cmdNodeBeatWatch(['--node', 'n1', '--session', '1', '--watch'],
      baseDeps(ac, { run, measure: () => { throw new Error('denied'); } }));
    for (const args of seen) {
      expect(args.some(a => a === '--capacity' || a.startsWith('--capacity='))).toBe(false);
      // A measurement that throws is unknown, not held: no slots claim either way.
      expect(args.some(a => a === '--slots')).toBe(false);
    }

    const ac2 = new AbortController();
    const second = recorder(1, ac2);
    capture();
    await cmdNodeBeatWatch(['--node', 'n1', '--session', '1', '--watch'],
      baseDeps(ac2, { run: second.run, measure: () => ({ ramBytes: GIB, slots: 0, held: 'cpu-pressure' }) }));
    expect(second.seen[0]!.some(a => a === '--capacity' || a.startsWith('--capacity='))).toBe(false);
  });

  it('advertises --slots 0 on a hold the capacity sample cannot express', async () => {
    // cpu-* and host-slots-* holds have no sample form, so without the zero
    // bound the node would keep its last advertised slots — or read
    // unbounded — while the router kept assigning it held work. The pool
    // worker sends --slots 0 for the same holds (worker.ts routerSlots).
    for (const held of ['cpu-pressure', 'cpu-unmeasured', 'host-slots-exhausted', 'host-slots-unmeasured'] as const) {
      const ac = new AbortController();
      const { seen, run } = recorder(2, ac);
      capture();
      await cmdNodeBeatWatch(['--node', 'n1', '--session', '1', '--watch'],
        baseDeps(ac, { run, measure: () => ({ ramBytes: GIB, slots: 0, held }) }));
      for (const args of seen) {
        expect(args.some(a => a === '--capacity' || a.startsWith('--capacity='))).toBe(false);
        expect(args.filter(a => a === '--slots')).toHaveLength(1);
        expect(args[args.indexOf('--slots') + 1]).toBe('0');
      }
    }
  });

  it('keeps a caller-supplied --slots over the held-node zero and a ready sample over both', async () => {
    const ac = new AbortController();
    const { seen, run } = recorder(1, ac);
    capture();
    await cmdNodeBeatWatch(['--node', 'n1', '--session', '1', '--watch', '--slots', '4'],
      baseDeps(ac, { run, measure: () => ({ ramBytes: GIB, slots: 0, held: 'cpu-pressure' }) }));
    expect(seen[0]!.filter(a => a === '--slots')).toHaveLength(1);
    expect(seen[0]![seen[0]!.indexOf('--slots') + 1]).toBe('4');

    // A reportable hold rides inside the sample (slots:0, held set); the
    // watch adds no second --slots claim.
    const ac2 = new AbortController();
    const second = recorder(1, ac2);
    capture();
    await cmdNodeBeatWatch(['--node', 'n1', '--session', '1', '--watch'],
      baseDeps(ac2, { run: second.run, measure: () => ({ ramBytes: GIB, slots: 0, held: 'memory-pressure' }) }));
    const args = second.seen[0]!;
    expect(args.some(a => a === '--slots')).toBe(false);
    const sample = JSON.parse(args[args.indexOf('--capacity') + 1]!) as Record<string, unknown>;
    expect(sample).toMatchObject({ slots: 0, held: 'memory-pressure' });
  });

  it('propagates the first failing beat exit code and stops', async () => {
    const ac = new AbortController();
    const { seen, run } = recorder(10, ac, [0, 1]);
    capture();
    expect(await cmdNodeBeatWatch(['--node', 'n1', '--session', '1', '--watch'], baseDeps(ac, { run }))).toBe(1);
    expect(seen).toHaveLength(2);
  });

  it('refuses a bad --every as usage with the beat envelope under --json', async () => {
    for (const args of [
      ['--every'], ['--every', 'abc'], ['--every', '0'], ['--every', '0.5'], ['--every', '26'], ['--every', '5', '--every', '6'],
    ]) {
      const lines = capture();
      const ac = new AbortController();
      const run = vi.fn(async () => 0);
      expect(await cmdNodeBeatWatch(['--node', 'n1', '--session', '1', '--watch', ...args, '--json'],
        baseDeps(ac, { run }))).toBe(2);
      expect(run).not.toHaveBeenCalled();
      expect(lastJson(lines)).toMatchObject({ schemaVersion: 1, command: 'beat',
        error: { code: 'usage', fix: 'Run: phm node beat --help' } });
    }
  });

  it('accepts --every=N and fractional seconds inside the bound', async () => {
    const ac = new AbortController();
    const { seen, run } = recorder(1, ac);
    const sleeps: number[] = [];
    capture();
    await cmdNodeBeatWatch(['--node', 'n1', '--session', '1', '--watch', '--every=2.5'],
      baseDeps(ac, { run, sleep: async (ms: number) => { sleeps.push(ms); } }));
    expect(sleeps).toEqual([2500]);
    expect(seen[0]).not.toContain('--every=2.5');
  });

  it('prints a plain stop line in text mode', async () => {
    const ac = new AbortController();
    const { run } = recorder(1, ac);
    const lines = capture();
    expect(await cmdNodeBeatWatch(['--node', 'n1', '--session', '1', '--watch'], baseDeps(ac, { run }))).toBe(0);
    expect(lines.at(-1)).toContain('Heartbeat stopped');
  });

  it('is reachable through the node dispatcher: a dead session fails the first beat', async () => {
    const lines = capture();
    // Hermetic store under the relocated test HOME: session 9 never joined.
    expect(await cmdNode(['beat', '--node', 'ghost', '--session', '9', '--watch', '--json'])).toBe(1);
    expect(lastJson(lines)).toMatchObject({ schemaVersion: 1, command: 'beat', error: { code: 'session-expired' } });
  });

  it('is reachable through the node dispatcher: a bad --every is a watch usage error, not an unknown flag', async () => {
    const lines = capture();
    expect(await cmdNode(['beat', '--node', 'n1', '--session', '1', '--watch', '--every', '30', '--json'])).toBe(2);
    const out = lastJson(lines);
    expect(out.error).toMatchObject({ code: 'usage' });
    expect(out.error.message).toContain('at most 25');
  });
});
