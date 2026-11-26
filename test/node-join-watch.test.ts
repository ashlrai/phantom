/**
 * `phm node join --watch [--every <seconds>]` is the standalone one-command
 * first run: it performs the ordinary join, prints the session answer, then
 * holds the new session with the same beat watch `phm node beat --watch`
 * runs — fresh capacity and host stats each pass, --probe-auth when gh was
 * advertised. The watch flags are stripped before the join parser sees them,
 * so the fleet flag table is unchanged. On a pool-configured Mac the flag is
 * refused: a pool join releases its probe session and workers hold their own
 * sessions per batch, so there is nothing for the watch to keep alive.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodesState, NodesStore } from '../src/core/drive/nodes/index.js';
import { emptyState, isHostStats, isNodeCapacity, type HostStats } from '../src/core/drive/nodes/state.js';
import type { NodeCapacity } from '../src/core/drive/nodes/capacity.js';
import { cmdNodeFleet } from '../src/cli/node-fleet.js';
import type { NodeBeatWatchDeps } from '../src/cli/node-beat-watch.js';

class MemoryStore implements NodesStore {
  state = emptyState();
  transaction<T>(fn: (state: NodesState) => T): T {
    const draft = structuredClone(this.state);
    const result = fn(draft);
    this.state = draft;
    return structuredClone(result);
  }
}

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

const watchDeps = (ac: AbortController, extra: Partial<NodeBeatWatchDeps> = {}): NodeBeatWatchDeps => ({
  signal: ac.signal,
  sleep: async () => undefined,
  measure: () => ready,
  hostStats: () => stats,
  now: () => 1_700_000_000_000,
  host: () => 'join-watch-node',
  ...extra,
});

const joinArgs = (caps = 'build', extra: string[] = []) => ['--node', 'laptop', '--owner', 'acme', '--caps', caps, ...extra];

describe('phm node join --watch', () => {
  it('joins, prints the session answer, then repeats beat on it until the stop signal', async () => {
    const store = new MemoryStore();
    const ac = new AbortController();
    const { seen, run } = recorder(3, ac);
    const lines = capture();
    const code = await cmdNodeFleet('join', [...joinArgs('build', ['--watch', '--json'])],
      { store, now: () => 1_000, phmVersion: () => null, watch: watchDeps(ac, { run }) });
    expect(code).toBe(0);
    // The join envelope prints once, before any beat.
    const joined = JSON.parse(lines[0]!);
    expect(joined).toMatchObject({ schemaVersion: 1, command: 'join', nodeId: 'laptop', owners: ['acme'], caps: ['build'], registry: 'local' });
    const session = String(joined.session);
    expect(seen).toHaveLength(3);
    for (const args of seen) {
      // The watch flags never reach the beat; join-only flags never leak either.
      for (const leaked of ['--watch', '--every', '--owner', 'acme', '--caps', 'build']) expect(args).not.toContain(leaked);
      expect(args).toEqual(expect.arrayContaining(['--node', 'laptop', '--session', session, '--json']));
      expect(args).not.toContain('--probe-auth');
      // Fresh samples each pass, like `beat --watch`.
      const at = args.indexOf('--capacity');
      expect(at).toBeGreaterThanOrEqual(0);
      expect(isNodeCapacity(JSON.parse(args[at + 1]!))).toBe(true);
      const hs = args.indexOf('--host-stats');
      expect(hs).toBeGreaterThanOrEqual(0);
      expect(isHostStats(JSON.parse(args[hs + 1]!))).toBe(true);
    }
    expect(lastJson(lines)).toEqual({ schemaVersion: 1, command: 'beat', watch: { stopped: 'signal', everySeconds: 10 } });
  });

  it('beats the session for real when no run override is injected', async () => {
    const store = new MemoryStore();
    const ac = new AbortController();
    let sleeps = 0;
    const lines = capture();
    const code = await cmdNodeFleet('join', [...joinArgs('build', ['--watch', '--json'])],
      { store, now: () => 1_000, phmVersion: () => null,
        watch: { ...watchDeps(ac), sleep: async () => { sleeps += 1; if (sleeps >= 2) ac.abort(); } } });
    expect(code).toBe(0);
    const envelopes = lines.map(line => JSON.parse(line) as Record<string, unknown>);
    expect(envelopes[0]).toMatchObject({ command: 'join', nodeId: 'laptop' });
    // Beat passes carry nodeId/leader; the stop envelope is the one with `watch`.
    expect(envelopes.filter(e => e['command'] === 'beat' && !('watch' in e))).toHaveLength(2);
    expect(envelopes.at(-1)).toMatchObject({ command: 'beat', watch: { stopped: 'signal' } });
    // The beats went through the fleet dispatch against the injected store:
    // the joined session is live there.
    const node = store.state.nodes.find(n => n.nodeId === 'laptop')!;
    expect(node.expiresAt).toBeGreaterThan(store.state.observedAt);
  });

  it('forwards --probe-auth to the beats when gh was advertised, like the join next hint', async () => {
    const ac = new AbortController();
    const { seen, run } = recorder(1, ac);
    capture();
    await cmdNodeFleet('join', [...joinArgs('build,gh', ['--watch', '--json'])],
      { store: new MemoryStore(), now: () => 1_000, phmVersion: () => null, watch: watchDeps(ac, { run }) });
    expect(seen[0]).toContain('--probe-auth');
  });

  it('honors --every and --every=N inside the shared watch bounds', async () => {
    for (const flag of [['--every', '2.5'], ['--every=4']]) {
      const ac = new AbortController();
      const { run } = recorder(1, ac);
      const sleeps: number[] = [];
      capture();
      await cmdNodeFleet('join', [...joinArgs('build', ['--watch', ...flag, '--json'])],
        { store: new MemoryStore(), now: () => 1_000, phmVersion: () => null,
          watch: watchDeps(ac, { run, sleep: async (ms: number) => { sleeps.push(ms); } }) });
      expect(sleeps).toEqual([flag[0] === '--every' ? 2500 : 4000]);
    }
  });

  it('refuses a bad --every as join usage before the store is touched', async () => {
    for (const args of [['--every'], ['--every', 'abc'], ['--every', '0'], ['--every', '0.5'], ['--every', '26'], ['--every', '5', '--every', '6']]) {
      const store = new MemoryStore();
      const ac = new AbortController();
      const run = vi.fn(async () => 0);
      const lines = capture();
      expect(await cmdNodeFleet('join', [...joinArgs('build', ['--watch', ...args, '--json'])],
        { store, watch: watchDeps(ac, { run }) })).toBe(2);
      expect(run).not.toHaveBeenCalled();
      expect(store.state.nodes).toEqual([]);
      expect(lastJson(lines)).toMatchObject({ schemaVersion: 1, command: 'join',
        error: { code: 'usage', fix: 'Run: phm node join --help' } });
    }
  });

  it('keeps --every a join-parser refusal when --watch is absent', async () => {
    const store = new MemoryStore();
    const lines = capture();
    expect(await cmdNodeFleet('join', [...joinArgs('build', ['--every', '5', '--json'])], { store })).toBe(2);
    expect(lastJson(lines)).toMatchObject({ command: 'join', error: { code: 'unknown-flag' } });
    expect(store.state.nodes).toEqual([]);
  });

  it('a failed join never starts the watch', async () => {
    const store = new MemoryStore();
    const ac = new AbortController();
    const run = vi.fn(async () => 0);
    const lines = capture();
    // No --owner: the join itself is refused, so no session exists to hold.
    expect(await cmdNodeFleet('join', ['--node', 'laptop', '--watch', '--json'],
      { store, watch: watchDeps(ac, { run }) })).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(store.state.nodes).toEqual([]);
    expect(lastJson(lines)).toMatchObject({ command: 'join', error: { code: 'missing-flag' } });
  });

  it('propagates the first failing beat exit code and stops', async () => {
    const ac = new AbortController();
    const { seen, run } = recorder(10, ac, [0, 1]);
    capture();
    expect(await cmdNodeFleet('join', [...joinArgs('build', ['--watch', '--json'])],
      { store: new MemoryStore(), now: () => 1_000, phmVersion: () => null, watch: watchDeps(ac, { run }) })).toBe(1);
    expect(seen).toHaveLength(2);
  });

  it('refuses --watch on a pool-configured Mac instead of silently dropping it', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'join-watch-pool-')));
    vi.stubEnv('ASHLR_HOME', home);
    try {
      mkdirSync(join(home, 'node-pool'), { recursive: true });
      writeFileSync(join(home, 'node-pool', 'config.json'), '{}');
      const lines = capture();
      expect(await cmdNodeFleet('join', [...joinArgs('build', ['--watch', '--json'])], {})).toBe(2);
      expect(lastJson(lines)).toMatchObject({ schemaVersion: 1, command: 'join',
        error: { code: 'usage', message: expect.stringContaining('node pool'),
          fix: expect.stringContaining('phm node worker') } });
    } finally { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); }
  });

  it('prints the join sentence then the beat stop line in text mode', async () => {
    const ac = new AbortController();
    const { run } = recorder(1, ac);
    const lines = capture();
    expect(await cmdNodeFleet('join', joinArgs('build', ['--watch']),
      { store: new MemoryStore(), now: () => 1_000, phmVersion: () => null, watch: watchDeps(ac, { run }) })).toBe(0);
    expect(lines[0]).toMatch(/^Joined laptop as session \d+ for owner acme \(caps: build\)\./);
    expect(lines.at(-1)).toBe('Heartbeat stopped; the node session expires on its own within 30 seconds.');
  });
});
