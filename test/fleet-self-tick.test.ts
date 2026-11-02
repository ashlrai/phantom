/**
 * RQ-PHX-SELFTICKVERB02 — `ashlr fleet self-tick` runs one locked pass of
 * Phantom's self-management: claude-quota, reset-release, lane-autohold,
 * planner-tick, in that fixed order, through the real cmdFleetSelfTick against a temp runs
 * dir. The planner's spawn seam is always a fake — nothing real is spawned,
 * and a hold a person placed is never released.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSelfTick } from '../src/cli/fleet-self-tick.js';
import { cmdFleet } from '../src/cli/fleet.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import {
  acquireLocalStoreLockWithOutcome, releaseLocalStoreLock,
} from '../src/core/fleet/local-store-lock.js';
import type { SelfTickStep, SelfTickStepName } from '../src/core/fleet/self-tick.js';
import { SELF_TICK_LOCK } from '../src/core/fleet/self-tick.js';
import type { SpawnedPlannerProcess, SpawnLike } from '../src/core/fleet/planner-run.js';
import { readLaneTargets } from '../src/core/fleet/runs-lane-targets.js';
import { readResetReleases } from '../src/core/fleet/usage-reset-release.js';

const NOW_MS = Date.parse('2026-11-01T12:00:00Z'); // a whole-second boundary
const NOW_ISO = new Date(NOW_MS).toISOString();
const READING = '2026-11-01T11:50:00Z'; // ledger as-of, newer than the holds
const HELD_UNTIL = '2026-11-05T00:00:00Z'; // autobackoff's guess, far out
const HELD_SINCE = '2026-11-01T11:00:00Z';
const PROMPT = 'self-tick planner prompt fixture — plain fake text, not a secret\n';
const pad2 = (n: number): string => String(n).padStart(2, '0');
const localStamp = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const LOCK = () => join(runsDir, SELF_TICK_LOCK);
const SLOTS = () => join(runsDir, 'queue', 'slots.json');
const EVENTS = () => join(runsDir, 'dispatch-events.log');
const QUEUE_EVENTS = () => join(runsDir, 'queue', 'dispatch-events.log');

let runsDir: string;
const lane = async (id: string) =>
  (await readLaneTargets({ runsDir })).lanes.find((l) => l.lane === id);

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'self-tick-'));
  await mkdir(join(runsDir, 'queue'));
  await writeFile(SLOTS(), JSON.stringify({
    devin: { target: 2, floor: 0, ceiling: 4, held: true,
      held_reason: `autobackoff fake job=j-1 until=${HELD_UNTIL} src=fake`,
      held_until: HELD_UNTIL, held_by: 'autobackoff',
      last_change: Date.parse(HELD_SINCE) / 1000 },
    'codex-personal': { target: 1, floor: 0, ceiling: 2, held: true,
      held_reason: 'manual: operator', held_by: 'Mason t1221u',
      last_change: Date.parse(HELD_SINCE) / 1000 },
  }));
  await writeFile(join(runsDir, 'queue', 'status.json'), JSON.stringify({
    last_tick: READING, paused: false, mem_free_pct: 50,
    lanes: {
      devin: { running: 0, target: 2, queued: 0, floor: null, ceiling: null, held: true },
      'codex-personal': { running: 0, target: 1, queued: 0, floor: null, ceiling: null, held: true },
      claude: { running: 0, target: 1, queued: 0, floor: null, ceiling: null, held: false },
    },
    budget: { devin: { weekly_used_pct: 3 }, 'codex-personal': { weekly_used_pct: 0 } },
  }));
  await writeFile(join(runsDir, 'queue', 'ready.tsv'), 'RQ-PHX-AAA\tphantom\tdevin\twork\t/q/p/a.md\n');
  // The lane-autohold step needs a readable events log; one finished launch.
  await writeFile(EVENTS(), [
    '2026-11-01 05:30:00 LAUNCH RQ-T01A1101X8 repo-x claude mid',
    '2026-11-01 05:30:30 PUBLISHED RQ-T01A1101X8 pr-1',
    '',
  ].join('\n'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(runsDir, { recursive: true, force: true });
});

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

interface Deps {
  steps?: Partial<Record<SelfTickStepName, SelfTickStep>>;
  spawn?: SpawnLike;
  claudeFindCommand?: () => string | null;
}
const run = async (args: string[], deps: Deps = {}) => {
  const out: string[] = [], err: string[] = [];
  const code = await cmdFleetSelfTick(args, {
    now: () => NOW_MS, claudeFindCommand: () => null, ...deps,
    output: (text) => out.push(text), error: (text) => err.push(text),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n'),
    report: out[0]?.startsWith('{') ? JSON.parse(out[0]!) as {
      v: number; at: string; mode: string; state: string;
      steps: { step: string; state: string; exitCode: number; report: unknown }[];
    } : null };
};

/** Stubs recording call order and argv; each yields a parseable ok report. */
const recording = () => {
  const order: string[] = [];
  const argvs: Record<string, string[]> = {};
  const stub = (name: SelfTickStepName, exitCode = 0, output?: string): SelfTickStep => async (args) => {
    order.push(name);
    argvs[name] = [...args];
    return { exitCode, output: output ?? JSON.stringify({ ok: name }) };
  };
  const steps = {
    'claude-quota': stub('claude-quota'),
    'reset-release': stub('reset-release'),
    'lane-autohold': stub('lane-autohold'),
    'planner-tick': stub('planner-tick'),
  };
  return { order, argvs, stub, steps };
};

describe('fleet self-tick', () => {
  it('resolves through the fleet convention and owns its --help', async () => {
    expect(resolveFleetSubcommand('self-tick'))
      .toEqual({ module: './fleet-self-tick.js', exportName: 'cmdFleetSelfTick' });
    expect(Object.hasOwn(FLEET_SUBCOMMAND_LOADERS, 'self-tick')).toBe(true);
    const loaded = await FLEET_SUBCOMMAND_LOADERS['self-tick']!();
    expect(typeof loaded['cmdFleetSelfTick']).toBe('function');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleet(['self-tick', '--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: ashlr fleet self-tick'));
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('PLANNER_TICK');
  });

  it('runs the steps in order: claude quota, reset release, autohold, planner', async () => {
    const rec = recording();
    const { code, report } = await run(['--json', '--runs-dir', runsDir], { steps: rec.steps });
    expect(code).toBe(0);
    expect(rec.order).toEqual(['claude-quota', 'reset-release', 'lane-autohold', 'planner-tick']);
    expect(report).toMatchObject({ v: 1, at: NOW_ISO, mode: 'dry-run', state: 'ran' });
    expect(report!.steps.map((s) => s.step)).toEqual(rec.order);
    expect(report!.steps.every((s) => s.state === 'ok' && s.exitCode === 0
      && (s.report as { ok: string }).ok === s.step)).toBe(true);
  });

  it('a throwing first step still runs the later three and exits 1', async () => {
    const rec = recording();
    const throwing: SelfTickStep = async (args) => {
      await rec.steps['claude-quota'](args);
      throw new Error('boom');
    };
    const { code, report } = await run(['--json', '--runs-dir', runsDir], {
      steps: { ...rec.steps, 'claude-quota': throwing },
    });
    expect(code).toBe(1);
    expect(rec.order).toEqual(['claude-quota', 'reset-release', 'lane-autohold', 'planner-tick']);
    expect(report!.steps[0]).toMatchObject({ step: 'claude-quota', state: 'failed', exitCode: 1, report: null });
    expect(report!.steps.slice(1).every((s) => s.state === 'ok')).toBe(true);
  });

  it('a nonzero step is failed, never fatal, and marks the run 1', async () => {
    const rec = recording();
    const { code, report } = await run(['--json', '--runs-dir', runsDir], {
      steps: { ...rec.steps, 'lane-autohold': rec.stub('lane-autohold', 1, 'not json') },
    });
    expect(code).toBe(1);
    expect(rec.order).toEqual(['claude-quota', 'reset-release', 'lane-autohold', 'planner-tick']);
    expect(report!.steps[2]).toMatchObject({ step: 'lane-autohold', state: 'failed', exitCode: 1, report: null });
  });

  it('dry-run writes no change to slots.json; planner still logs PLANNER_TICK', async () => {
    const before = await readFile(SLOTS(), 'utf8');
    const { code, report } = await run(['--json', '--runs-dir', runsDir]);
    expect(code).toBe(0);
    expect(report!.mode).toBe('dry-run');
    expect(await readFile(SLOTS(), 'utf8')).toBe(before);
    expect(await lane('devin')).toMatchObject({ held: true });
    const tick = (await readFile(QUEUE_EVENTS(), 'utf8')).trim().split('\n').at(-1)!;
    expect(tick).toContain('PLANNER_TICK run reason=low-supply');
    expect(existsSync(join(runsDir, 'queue', 'reset-releases.jsonl'))).toBe(false);
  });

  it('--apply reaches each step with --apply', async () => {
    const rec = recording();
    const { code, report } = await run(['--apply', '--json', '--runs-dir', runsDir], { steps: rec.steps });
    expect(code).toBe(0);
    expect(report!.mode).toBe('apply');
    for (const name of ['claude-quota', 'reset-release', 'lane-autohold', 'planner-tick']) {
      expect(rec.argvs[name]).toContain('--apply');
      expect(rec.argvs[name]).toContain('--json');
      expect(rec.argvs[name]).toEqual(expect.arrayContaining(['--runs-dir', runsDir]));
    }
  });

  it('--apply releases the reset autobackoff hold and leaves the manual hold held', async () => {
    const { code, report } = await run(['--apply', '--json', '--runs-dir', runsDir]);
    expect(code).toBe(0);
    const release = report!.steps[1]!.report as { mode: string; released: { lane: string }[]; errors: unknown[] };
    expect(release.mode).toBe('apply');
    expect(release.released.map((r) => r.lane)).toEqual(['devin']);
    expect(release.errors).toEqual([]);
    expect(await lane('devin')).toMatchObject({ held: false, changedBy: expect.stringContaining('reset-detect') });
    expect(await lane('codex-personal')).toMatchObject({ held: true, heldReason: 'manual: operator' });
    expect((await readResetReleases(runsDir)).map((r) => r.lane)).toEqual(['devin']);
    expect(await readFile(EVENTS(), 'utf8')).toContain('LANE_HOLD released devin by reset-detect');
    expect((await readFile(QUEUE_EVENTS(), 'utf8')).trim().split('\n').at(-1))
      .toContain('PLANNER_TICK');
    expect(existsSync(LOCK())).toBe(false);
  });

  it('--apply fires the planner pass through the injected fake spawn', async () => {
    const promptPath = join(runsDir, 'prompt.md');
    await writeFile(promptPath, PROMPT);
    await writeFile(join(runsDir, 'queue', 'planner-candidates.json'), JSON.stringify({
      v: 1, candidates: [{ provider: 'cmp', argv: ['fake-planner', '--plan'] }],
      lastProvider: 'cmp', promptPath,
    }));
    await mkdir(join(runsDir, 'leader', 'drop'), { recursive: true });
    await writeFile(join(runsDir, 'leader', 'drop', 'ingested.tsv'),
      `${localStamp(NOW_MS)}\tRQ-PHX-ING01\tclaude\tclaude\twork\tfixture\n`);
    const calls: string[] = [];
    const children: FakeChild[] = [];
    const spawn: SpawnLike = (program, args) => {
      calls.push([program, ...args].join(' '));
      const child = new FakeChild(0);
      children.push(child);
      return child as unknown as SpawnedPlannerProcess;
    };
    const { code, report } = await run(['--apply', '--json', '--runs-dir', runsDir], { spawn });
    expect(code).toBe(0);
    expect(calls).toEqual(['fake-planner --plan']);
    expect(children[0]!.stdinText).toBe(PROMPT);
    expect(report!.steps[3]).toMatchObject({ step: 'planner-tick', state: 'ok', exitCode: 0 });
    expect(report!.steps[3]!.report).toMatchObject({ outcome: 'ran', verdict: 'productive' });
  });

  it('a held lock reports busy, exits 0 and runs no step', async () => {
    const held = acquireLocalStoreLockWithOutcome(LOCK(), 0, { anchorPath: runsDir, exactPrivateStorage: true });
    expect(held.state).toBe('acquired');
    try {
      const rec = recording();
      const { code, report } = await run(['--json', '--runs-dir', runsDir], { steps: rec.steps });
      expect(code).toBe(0);
      expect(rec.order).toEqual([]);
      expect(report).toMatchObject({ state: 'busy', mode: 'dry-run', steps: [] });
      const human = await run(['--runs-dir', runsDir]);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain('BUSY');
    } finally {
      releaseLocalStoreLock(held.state === 'acquired' ? held.lock : null);
    }
  });

  it('the lock is released even when a step throws', async () => {
    const { code } = await run(['--json', '--runs-dir', runsDir], {
      steps: { 'reset-release': async () => { throw new Error('boom'); } },
    });
    expect(code).toBe(1);
    expect(existsSync(LOCK())).toBe(false);
  });

  it('bad arguments exit 2 before any step or lock', async () => {
    const rec = recording();
    for (const args of [
      ['--bogus'], ['positional'], ['--json', '--json'], ['--apply', '--apply'],
      ['--runs-dir'], ['--runs-dir', '--json'], ['--runs-dir', 'relative/dir'],
      ['--runs-dir', runsDir, '--runs-dir', runsDir], ['--json=1'], ['--apply=x'],
    ]) {
      const { code, stderr } = await run(args, { steps: rec.steps });
      expect(code, `args ${args.join(' ')}`).toBe(2);
      expect(stderr).toContain('Usage: ashlr fleet self-tick');
    }
    expect(rec.order).toEqual([]);
    expect(existsSync(LOCK())).toBe(false);
  });
});
