/**
 * `phm node renew --watch [--every <seconds>]` keeps one claimed job's lease
 * alive by repeating the ordinary renew — the claim-side counterpart of
 * `beat --watch`, since a pull's lease expires 30 s after the last renew and a
 * manual holder had no keep-alive. The watch flags are dispatcher-level:
 * stripped before the renew parser sees them, so the fleet flag table and the
 * pool wire protocol are unchanged, and a refused renew stops the watch at
 * once with that error.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cmdNodeRenewWatch, type NodeRenewWatchDeps } from '../src/cli/node-renew-watch.js';
import { cmdNode } from '../src/cli/node.js';

function capture() {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation((line: string) => { lines.push(String(line)); });
  return lines;
}
const lastJson = (lines: string[]) => JSON.parse(lines.at(-1)!);
afterEach(() => vi.restoreAllMocks());

const LEASE = ['--job', 'j1', '--node', 'n1', '--session', '1', '--token', '5', '--leader-token', '3'];

/** A run that records each renew's args and stops the watch after `renews` passes. */
function recorder(renews: number, ac: AbortController, codes: number[] = []) {
  const seen: string[][] = [];
  let calls = 0;
  return {
    seen,
    run: async (args: string[]) => {
      seen.push([...args]);
      calls += 1;
      if (calls >= renews) ac.abort();
      return codes.shift() ?? 0;
    },
  };
}

const baseDeps = (ac: AbortController, extra: Partial<NodeRenewWatchDeps> = {}): NodeRenewWatchDeps => ({
  signal: ac.signal,
  sleep: async () => undefined,
  ...extra,
});

describe('phm node renew --watch', () => {
  it('repeats the renew until the stop signal, stripping --watch and --every', async () => {
    const ac = new AbortController();
    const { seen, run } = recorder(3, ac);
    const lines = capture();
    expect(await cmdNodeRenewWatch([...LEASE, '--watch', '--every', '5', '--json'],
      baseDeps(ac, { run }))).toBe(0);
    expect(seen).toHaveLength(3);
    for (const args of seen) {
      // The lease flags pass through verbatim; nothing is appended for renew.
      expect(args).toEqual([...LEASE, '--json']);
    }
    expect(lastJson(lines)).toEqual({ schemaVersion: 1, command: 'renew', watch: { stopped: 'signal', everySeconds: 5 } });
  });

  it('propagates the first failing renew exit code and stops', async () => {
    const ac = new AbortController();
    const { seen, run } = recorder(10, ac, [0, 1]);
    capture();
    expect(await cmdNodeRenewWatch([...LEASE, '--watch'], baseDeps(ac, { run }))).toBe(1);
    expect(seen).toHaveLength(2);
  });

  it('refuses a bad --every as usage with the renew envelope under --json', async () => {
    for (const args of [
      ['--every'], ['--every', 'abc'], ['--every', '0'], ['--every', '26'], ['--every', '5', '--every', '6'],
    ]) {
      const lines = capture();
      const ac = new AbortController();
      const run = vi.fn(async () => 0);
      expect(await cmdNodeRenewWatch([...LEASE, '--watch', ...args, '--json'],
        baseDeps(ac, { run }))).toBe(2);
      expect(run).not.toHaveBeenCalled();
      expect(lastJson(lines)).toMatchObject({ schemaVersion: 1, command: 'renew',
        error: { code: 'usage', fix: 'Run: phm node renew --help' } });
    }
  });

  it('accepts --every=N and fractional seconds inside the bound', async () => {
    const ac = new AbortController();
    const { seen, run } = recorder(1, ac);
    const sleeps: number[] = [];
    capture();
    await cmdNodeRenewWatch([...LEASE, '--watch', '--every=2.5'],
      baseDeps(ac, { run, sleep: async (ms: number) => { sleeps.push(ms); } }));
    expect(sleeps).toEqual([2500]);
    expect(seen[0]).not.toContain('--every=2.5');
  });

  it('prints a plain stop line in text mode', async () => {
    const ac = new AbortController();
    const { run } = recorder(1, ac);
    const lines = capture();
    expect(await cmdNodeRenewWatch([...LEASE, '--watch'], baseDeps(ac, { run }))).toBe(0);
    expect(lines.at(-1)).toContain('Claim watch stopped');
  });

  it('is reachable through the node dispatcher: a dead session fails the first renew', async () => {
    const lines = capture();
    // Hermetic store under the relocated test HOME: node ghost never joined,
    // so the presented session is dead — session-expired (join first, then
    // re-pull), not lease-lost, and the watch stops on it at once.
    expect(await cmdNode(['renew', '--job', 'j1', '--node', 'ghost', '--session', '9',
      '--token', '1', '--leader-token', '1', '--watch', '--json'])).toBe(1);
    expect(lastJson(lines)).toMatchObject({ schemaVersion: 1, command: 'renew', error: { code: 'session-expired' } });
  });

  it('is reachable through the node dispatcher: a bad --every is a watch usage error, not an unknown flag', async () => {
    const lines = capture();
    expect(await cmdNode(['renew', ...LEASE, '--watch', '--every', '30', '--json'])).toBe(2);
    const out = lastJson(lines);
    expect(out.error).toMatchObject({ code: 'usage' });
    expect(out.error.message).toContain('at most 25');
  });
});
