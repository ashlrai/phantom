/**
 * RQ-PHX-PLANNERAUTORUN01 — `ashlr fleet planner-tick`: the one-shot verb an
 * agent, a timer or a later route calls for the autorun decision. A dry-run
 * prints RUN/SKIP and always appends a PLANNER_TICK line; --apply on a RUN
 * goes through the real slate read and runPlannerPass with an injected fake
 * spawn, so these tests never spawn a real process or touch the real home.
 */
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from './fleet.js';
import { cmdFleetPlannerTick } from './fleet-planner-tick.js';
import { resolveFleetSubcommand } from './fleet-subcommand-resolve.js';
import type { PlannerAutorunInput } from '../core/fleet/planner-autorun.js';
import type { SpawnedPlannerProcess, SpawnLike } from '../core/fleet/planner-run.js';

// Fixed local clock: Nov 1 2026 12:00. Fixture stamps sit relative to it.
const NOW = new Date(2026, 10, 1, 12, 0, 0).getTime();
const pad2 = (n: number): string => String(n).padStart(2, '0');
const localStamp = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const PROMPT = 'planner tick prompt fixture — plain fake text, not a secret\n';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  stdinText = '';
  constructor(code = 0) {
    super();
    this.stdin.on('data', (chunk: Buffer) => { this.stdinText += chunk.toString('utf8'); });
    queueMicrotask(() => this.emit('close', code, null));
  }
  kill(): boolean { return true; }
}

const spawnOk = () => {
  const children: FakeChild[] = [];
  const calls: string[] = [];
  const spawn: SpawnLike = (program, args) => {
    calls.push([program, ...args].join(' '));
    const child = new FakeChild(0);
    children.push(child);
    return child as unknown as SpawnedPlannerProcess;
  };
  return { spawn, children, calls };
};

/** A runs root in the RUN state: 2 queued Phantom jobs, 2 free slots, no pass history. */
const freshRunsDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'planner-tick-'));
  await mkdir(join(dir, 'queue'), { recursive: true });
  await writeFile(join(dir, 'queue', 'ready.tsv'), [
    'RQ-PHX-AAA\tphantom\tcodex-personal\twork\t/q/p/a.md',
    'RQ-PHX-BBB\tphantom\tdevin\tmid\t/q/p/b.md',
    'RQ-PHX-PARKED\tphantom\tPARKED-BYHAND.codex-local\twork\t/q/p/p.md',
    'RQ-OTHR-CCC\tother\tdevin\twork\t/q/p/c.md',
  ].join('\n'));
  await writeFile(join(dir, 'queue', 'status.json'), JSON.stringify({
    last_tick: new Date(NOW).toISOString(),
    paused: false,
    mem_free_pct: 50,
    lanes: { 'codex-personal': { running: 1, target: 3, queued: 0, floor: null, ceiling: null, held: false } },
  }));
  return dir;
};

const slate = (extra: Record<string, unknown> = {}) => JSON.stringify({
  v: 1,
  candidates: [{ provider: 'cmp', argv: ['fake-planner', '--plan'] }],
  lastProvider: 'cmp',
  ...extra,
});

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface TickDeps {
  readInput?: (runsDir: string, now: number) => Promise<PlannerAutorunInput>;
  spawn?: SpawnLike;
}

const tick = async (args: string[], deps: TickDeps = {}) => {
  const out: string[] = [], err: string[] = [];
  const code = await cmdFleetPlannerTick(args, {
    now: NOW,
    output: (text) => out.push(text),
    error: (text) => err.push(text),
    ...deps,
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
};
const events = async (dir: string): Promise<string[]> =>
  (await readFile(join(dir, 'queue', 'dispatch-events.log'), 'utf8')).trim().split('\n');

describe('fleet planner-tick', () => {
  it('resolves through the fleet convention and owns its --help', async () => {
    expect(resolveFleetSubcommand('planner-tick'))
      .toEqual({ module: './fleet-planner-tick.js', exportName: 'cmdFleetPlannerTick' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleet(['planner-tick', '--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet planner-tick'));
  });

  it('dry-run prints RUN and appends the PLANNER_TICK line', async () => {
    const dir = await freshRunsDir(); dirs.push(dir);
    const { code, stdout } = await tick(['--runs-dir', dir]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^RUN low-supply: /);
    const rows = await events(dir);
    expect(rows.at(-1)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} PLANNER_TICK run reason=low-supply phx=2 free=2$/);
  });

  it('dry-run prints SKIP and still appends the PLANNER_TICK line', async () => {
    const dir = await freshRunsDir(); dirs.push(dir);
    await writeFile(join(dir, 'queue', 'ready.tsv'),
      Array.from({ length: 25 }, (_, i) => `RQ-PHX-${i}\tphantom\tdevin\twork\t/q/p/${i}.md`).join('\n'));
    const { code, stdout } = await tick(['--runs-dir', dir]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^SKIP enough-supply: /);
    expect((await events(dir)).at(-1)).toContain('PLANNER_TICK skip reason=enough-supply phx=25 free=2');
  });

  it('a recent pass skips as too-soon, and --min-gap-minutes can lower the gap', async () => {
    const dir = await freshRunsDir(); dirs.push(dir);
    await writeFile(join(dir, 'queue', 'dispatch-events.log'), `${localStamp(NOW - 10 * 60_000)} LEADER cmp fixups=2\n`);
    expect((await tick(['--runs-dir', dir])).stdout).toMatch(/^SKIP too-soon: /);
    expect((await events(dir)).at(-1)).toContain('PLANNER_TICK skip reason=too-soon');
    expect((await tick(['--runs-dir', dir, '--min-gap-minutes', '5'])).stdout).toMatch(/^RUN low-supply: /);
    expect((await events(dir)).at(-1)).toContain('PLANNER_TICK run reason=low-supply');
  });

  it('an ORCH_OFF file under the runs dir gates the tick', async () => {
    const dir = await freshRunsDir(); dirs.push(dir);
    await writeFile(join(dir, 'ORCH_OFF'), 'off\n');
    const { code, stdout } = await tick(['--runs-dir', dir]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^SKIP orch-off: /);
  });

  it('--json prints the decision object', async () => {
    const dir = await freshRunsDir(); dirs.push(dir);
    const { code, stdout } = await tick(['--runs-dir', dir, '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ v: 1, run: true, reason: 'low-supply', phxReady: 2, freeSlots: 2 });
  });

  it('--apply with no slate prints no-slate and still returns 0', async () => {
    const dir = await freshRunsDir(); dirs.push(dir);
    const { code, stdout } = await tick(['--runs-dir', dir, '--apply']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ outcome: 'no-slate' });
    expect((await events(dir)).at(-1)).toContain('PLANNER_TICK run reason=low-supply');
  });

  it('--apply with a slate but no declared prompt prints no-prompt-declared', async () => {
    const dir = await freshRunsDir(); dirs.push(dir);
    await writeFile(join(dir, 'queue', 'planner-candidates.json'), slate());
    const { code, stdout } = await tick(['--runs-dir', dir, '--apply']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ outcome: 'no-prompt-declared' });
  });

  it('--apply runs one pass through the injected spawn and logs LEADER', async () => {
    const dir = await freshRunsDir(); dirs.push(dir);
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, PROMPT);
    await writeFile(join(dir, 'queue', 'planner-candidates.json'), slate({ promptPath }));
    const fake = spawnOk();
    const out: string[] = [];
    const code = await cmdFleetPlannerTick(['--runs-dir', dir, '--apply'], {
      now: NOW, spawn: fake.spawn, output: (text) => out.push(text),
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ v: 1, provider: 'cmp', outcome: 'ran', exitCode: 0 });
    expect(fake.calls).toEqual(['fake-planner --plan']);
    expect(fake.children[0]!.stdinText).toBe(PROMPT);
    // The pass wrote its run log and both observational rows.
    const rows = await events(dir);
    expect(rows.at(-2)).toContain('PLANNER_TICK run reason=low-supply');
    expect(rows.at(-1)).toContain('LEADER cmp ok');
    const logs = await readdir(join(dir, 'supervisor'));
    expect(logs.filter((name) => /^run\..*\.log$/.test(name))).toHaveLength(1);
  });

  it('--apply returns 1 only when the pass itself fails', async () => {
    const dir = await freshRunsDir(); dirs.push(dir);
    const promptPath = join(dir, 'prompt.md');
    await writeFile(promptPath, PROMPT);
    await writeFile(join(dir, 'queue', 'planner-candidates.json'), slate({ promptPath }));
    const out: string[] = [];
    const code = await cmdFleetPlannerTick(['--runs-dir', dir, '--apply'], {
      now: NOW,
      spawn: () => { throw new Error('spawn boom'); },
      output: (text) => out.push(text),
    });
    expect(code).toBe(1);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ outcome: 'spawn-failed' });
  });

  it('an injected read input still ends with the PLANNER_TICK line', async () => {
    const dir = await freshRunsDir(); dirs.push(dir);
    const input: PlannerAutorunInput = {
      phxReady: 0,
      lanes: [{ lane: 'devin', running: 0, target: 1, held: false }],
      health: { status: 'ok', failingSince: null, lastGoodPassAt: new Date(NOW - 3600_000).toISOString(), resetAt: null, reason: null },
      orchOff: false,
      nowMs: NOW,
    };
    const { code, stdout } = await tick(['--runs-dir', dir], { readInput: async () => input });
    expect(code).toBe(0);
    expect(stdout).toMatch(/^RUN low-supply: /);
    expect((await events(dir)).at(-1)).toContain('PLANNER_TICK run reason=low-supply phx=0 free=1');
  });

  it('bad arguments return 2 with usage on stderr', async () => {
    for (const args of [
      ['--bogus'],
      ['--runs-dir', 'relative/path'],
      ['--runs-dir'],
      ['--min-gap-minutes', 'abc'],
      ['--min-gap-minutes'],
      ['--low-supply', 'x'],
      ['--apply', '--apply'],
    ]) {
      const { code, stderr, stdout } = await tick(args);
      expect(code, `args ${args.join(' ')}`).toBe(2);
      expect(stderr).toContain('Usage: ashlr fleet planner-tick');
      expect(stdout).toBe('');
    }
  });
});
