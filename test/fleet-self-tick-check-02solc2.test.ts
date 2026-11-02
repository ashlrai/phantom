/**
 * RQ-PHX-SELFTICKCHECK02SOLC2 — `ashlr fleet self-tick-check` gives a host
 * supervisor a process exit status for the self-management timer: 0 only for
 * a readable, fresh, ran self-tick-last record with no failed steps (and an
 * apply pass under --require-apply), 1 for missing/unreadable/future/stale/
 * busy/failed/dry-run, 2 for usage. Records are plain fakes in a temp dir,
 * the clock is injected, and the check never touches the real home directory.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSelfTickCheck } from '../src/cli/fleet-self-tick-check.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { SELF_TICK_LAST } from '../src/core/fleet/self-tick-last.js';

const NOW_MS = Date.parse('2026-11-02T12:00:00Z'); // a whole-second boundary
const at = (offsetSeconds: number): string => new Date(NOW_MS + offsetSeconds * 1_000).toISOString();

interface CheckJson {
  v: number; healthy: boolean; reason: string; at: string | null;
  ageSeconds: number | null; mode: string | null; ranState: string | null;
  failedSteps: string[]; maxAgeSeconds: number; requireApply: boolean;
}

let runsDir: string;
const RECORD = (): string => join(runsDir, SELF_TICK_LAST);

const seed = async (over: Record<string, unknown> = {}): Promise<void> => {
  await mkdir(join(runsDir, 'queue'), { recursive: true });
  await writeFile(RECORD(), JSON.stringify({
    v: 1,
    at: at(-120),
    mode: 'apply',
    state: 'ran',
    steps: [
      { step: 'reset-release', state: 'ok', exitCode: 0, report: { fake: true } },
      { step: 'planner-tick', state: 'ok', exitCode: 0, report: null },
    ],
    ...over,
  }));
};

const run = async (args: string[], deps: { home?: string; now?: () => number } = {}) => {
  const out: string[] = [], err: string[] = [];
  const code = await cmdFleetSelfTickCheck(args, {
    now: () => NOW_MS, ...deps,
    output: (text) => out.push(text), error: (text) => err.push(text),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n'),
    json: out[0]?.startsWith('{') ? JSON.parse(out[0]!) as CheckJson : null };
};

const withDir = (args: string[] = []): string[] => ['--runs-dir', runsDir, ...args];

/** Every file under root with its content, deepest first — a mutation snapshot. */
const snapshot = (root: string): [string, string][] => {
  const entries: [string, string][] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path);
      else entries.push([path.slice(root.length), readFileSync(path, 'utf8')]);
    }
  };
  walk(root);
  return entries.sort(([a], [b]) => a.localeCompare(b));
};

beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'self-tick-check-')); });
afterEach(async () => { vi.restoreAllMocks(); await rm(runsDir, { recursive: true, force: true }); });

describe('fleet self-tick-check', () => {
  it('resolves through the fleet convention and owns its --help', async () => {
    expect(resolveFleetSubcommand('self-tick-check'))
      .toEqual({ module: './fleet-self-tick-check.js', exportName: 'cmdFleetSelfTickCheck' });
    const module = await import('../src/cli/fleet-self-tick-check.js');
    expect(typeof module.cmdFleetSelfTickCheck).toBe('function');
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: ashlr fleet self-tick-check');
    expect(help.stdout).toContain('--require-apply');
    expect(help.stdout).toContain('--max-age-seconds');
  });

  it('a fresh ran apply record is healthy: exit 0, human and JSON', async () => {
    await seed();
    const human = await run(withDir());
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('fleet self-tick-check: healthy');
    expect(human.stdout).toContain('failed=none');
    const machine = await run(withDir(['--json']));
    expect(machine.code).toBe(0);
    expect(machine.json).toEqual({
      v: 1, healthy: true, reason: 'ok', at: at(-120), ageSeconds: 120,
      mode: 'apply', ranState: 'ran', failedSteps: [], maxAgeSeconds: 1800, requireApply: false,
    });
  });

  it('no record exits 1 with reason=missing', async () => {
    const human = await run(withDir());
    expect(human.code).toBe(1);
    expect(human.stdout).toContain('UNHEALTHY');
    expect(human.stdout).toContain('reason=missing');
    const machine = await run(withDir(['--json']));
    expect(machine.code).toBe(1);
    expect(machine.json).toMatchObject({
      healthy: false, reason: 'missing', at: null, ageSeconds: null,
      mode: null, ranState: null, failedSteps: [],
    });
  });

  it.each([
    ['not json at all', 'reason=unreadable'],
    ['{"at": 5}', 'reason=unreadable'],
    ['{"at": "2026-11-02T11:58:00.000Z", "mode": "apply"}', 'reason=unreadable'],
  ])('an unreadable record (%s) exits 1', async (content, needle) => {
    await mkdir(join(runsDir, 'queue'), { recursive: true });
    await writeFile(RECORD(), content);
    const { code, stdout } = await run(withDir());
    expect(code).toBe(1);
    expect(stdout).toContain(needle);
  });

  it('the default 1800s threshold is inclusive at the boundary', async () => {
    await seed({ at: at(-1800) });
    expect((await run(withDir())).code).toBe(0);
    await seed({ at: at(-1801) });
    const stale = await run(withDir(['--json']));
    expect(stale.code).toBe(1);
    expect(stale.json).toMatchObject({ healthy: false, reason: 'stale', ageSeconds: 1801 });
    expect((await run(withDir())).stdout).toContain('1801s old');
  });

  it('a custom --max-age-seconds is inclusive at its boundary', async () => {
    await seed({ at: at(-60) });
    expect((await run(withDir(['--max-age-seconds', '60', '--json']))).json)
      .toMatchObject({ healthy: true, maxAgeSeconds: 60 });
    await seed({ at: at(-61) });
    const stale = await run(withDir(['--max-age-seconds', '60']));
    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain('reason=stale');
  });

  it('a far-future timestamp is unhealthy even though its age clamps to 0', async () => {
    await seed({ at: at(+3600) });
    const machine = await run(withDir(['--json']));
    expect(machine.code).toBe(1);
    expect(machine.json).toMatchObject({ healthy: false, reason: 'future', ageSeconds: 0 });
    expect((await run(withDir())).stdout).toContain('reason=future');
  });

  it('small clock skew inside the 60s allowance still counts as healthy', async () => {
    await seed({ at: at(+30) });
    expect((await run(withDir())).code).toBe(0);
    await seed({ at: at(+61) });
    expect((await run(withDir(['--json']))).json).toMatchObject({ healthy: false, reason: 'future' });
  });

  it('a recorded busy run exits 1 with reason=busy', async () => {
    await seed({ state: 'busy', steps: [] });
    const machine = await run(withDir(['--json']));
    expect(machine.code).toBe(1);
    expect(machine.json).toMatchObject({ healthy: false, reason: 'busy', ranState: 'busy' });
    expect((await run(withDir())).stdout).toContain('no step ran');
  });

  it('a fresh record with failed steps exits 1 with reason=failed', async () => {
    await seed({ steps: [
      { step: 'reset-release', state: 'failed', exitCode: 1, report: null },
      { step: 'lane-autohold', state: 'ok', exitCode: 0, report: null },
    ] });
    const machine = await run(withDir(['--json']));
    expect(machine.code).toBe(1);
    expect(machine.json).toMatchObject({ healthy: false, reason: 'failed', failedSteps: ['reset-release'] });
    expect((await run(withDir())).stdout).toContain('failed steps: reset-release');
  });

  it('--require-apply: a dry-run record is unhealthy, an apply record stays healthy', async () => {
    await seed({ mode: 'dry-run' });
    const dry = await run(withDir(['--require-apply', '--json']));
    expect(dry.code).toBe(1);
    expect(dry.json).toMatchObject({ healthy: false, reason: 'dry-run', mode: 'dry-run', requireApply: true });
    // Without the gate a fresh dry-run record is still a working timer.
    expect((await run(withDir())).code).toBe(0);
    await seed({ mode: 'apply' });
    const applied = await run(withDir(['--require-apply']));
    expect(applied.code).toBe(0);
  });

  it('staleness wins over busy, and busy wins over failed', async () => {
    await seed({ at: at(-7200), state: 'busy', steps: [{ step: 'x', state: 'failed', exitCode: 1, report: null }] });
    expect((await run(withDir(['--json']))).json).toMatchObject({ reason: 'stale' });
    await seed({ state: 'busy', steps: [{ step: 'x', state: 'failed', exitCode: 1, report: null }] });
    expect((await run(withDir(['--json']))).json).toMatchObject({ reason: 'busy' });
  });

  it('bad arguments exit 2 with usage before any read', async () => {
    const ghost = join(runsDir, 'never-read');
    for (const args of [
      ['--bogus'], ['positional'], ['--json', '--json'],
      ['--require-apply', '--require-apply'], ['--json=1'], ['--require-apply=yes'],
      ['--runs-dir'], ['--runs-dir', '--json'], ['--runs-dir', 'relative/dir'],
      ['--runs-dir', runsDir, '--runs-dir', runsDir],
      ['--max-age-seconds'], ['--max-age-seconds', '0'], ['--max-age-seconds', '-5'],
      ['--max-age-seconds', 'abc'], ['--max-age-seconds', '1.5'], ['--max-age-seconds', '1e3'],
      ['--max-age-seconds', '60', '--max-age-seconds', '120'],
      ['--runs-dir', ghost, '--max-age-seconds', 'x'],
    ]) {
      const { code, stderr, stdout } = await run(args);
      expect(code, `args ${args.join(' ')}`).toBe(2);
      expect(stderr).toContain('Usage: ashlr fleet self-tick-check');
      expect(stdout).toBe('');
    }
    expect(existsSync(ghost)).toBe(false);
  });

  it('runs no work and writes nothing, healthy or not', async () => {
    expect(snapshot(runsDir)).toEqual([]);
    await seed();
    const before = snapshot(runsDir);
    for (const args of [
      withDir(), withDir(['--json']), withDir(['--require-apply']), withDir(['--max-age-seconds', '1']),
    ]) {
      await run(args);
      expect(snapshot(runsDir)).toEqual(before);
    }
    // A missing record is probed without the queue directory being created.
    const empty = join(runsDir, 'elsewhere');
    await run(['--runs-dir', empty]);
    expect(existsSync(empty)).toBe(false);
  });

  it('falls back to <home>/.ashlr-runs when --runs-dir is not given', async () => {
    const home = join(runsDir, 'fake-home');
    const saved = process.env.ASHLR_RUNS_DIR;
    delete process.env.ASHLR_RUNS_DIR;
    try {
      await mkdir(join(home, '.ashlr-runs', 'queue'), { recursive: true });
      await writeFile(join(home, '.ashlr-runs', SELF_TICK_LAST), JSON.stringify({
        v: 1, at: at(-5), mode: 'apply', state: 'ran', steps: [],
      }));
      const { code, json } = await run(['--json'], { home });
      expect(code).toBe(0);
      expect(json).toMatchObject({ healthy: true, at: at(-5) });
    } finally {
      if (saved === undefined) delete process.env.ASHLR_RUNS_DIR;
      else process.env.ASHLR_RUNS_DIR = saved;
    }
  });
});
