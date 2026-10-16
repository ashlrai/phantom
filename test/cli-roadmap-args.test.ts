/**
 * `ashlr roadmap` argument handling.
 *
 * Only a leading `--help` was honoured, so `ashlr roadmap run --help` ignored
 * the flag and started the Goal Loop, which executes milestones in fresh
 * agent processes. Unknown flags and typos (`--dry_run`, `--jsn`) were also
 * dropped silently, so a mistyped `--dry-run` ran for real. Help now wins
 * anywhere, and unknown or valueless flags are a usage error (exit 2) before
 * anything runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runGoalLoop, parseRoadmap, loadState } = vi.hoisted(() => ({
  runGoalLoop: vi.fn(async () => ({ outcomes: [], allComplete: true, stoppedAt: null, stopReason: null })),
  parseRoadmap: vi.fn(() => ({ dir: '/r', path: '/r/ROADMAP.md', milestones: [] })),
  loadState: vi.fn(() => ({ milestones: {} })),
}));

vi.mock('../src/core/goal-loop/runner.js', () => ({ runGoalLoop }));
vi.mock('../src/core/goal-loop/parse.js', () => ({ parseRoadmap }));
vi.mock('../src/core/goal-loop/state.js', () => ({ loadState }));
vi.mock('../src/core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/config.js')>();
  return { ...actual, loadConfig: () => actual.defaultConfig() };
});

import { cmdRoadmap } from '../src/cli/roadmap.js';

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ashlr roadmap arguments', () => {
  it.each([
    [['run', '--help']],
    [['resume', '-h']],
    [['status', '--json', '--help']],
    [['--help']],
    [['help']],
  ])('%j prints usage, exits 0 and runs nothing', async (args) => {
    expect(await cmdRoadmap(args)).toBe(0);
    expect(out.join('\n')).toContain('Usage: ashlr roadmap');
    expect(runGoalLoop).not.toHaveBeenCalled();
    expect(parseRoadmap).not.toHaveBeenCalled();
  });

  it.each([
    [['run', '--dry_run'], /Unknown argument: --dry_run/],
    [['run', '--jsn'], /Unknown argument: --jsn/],
    [['status', 'extra'], /Unknown argument: extra/],
    [['run', '--engine'], /--engine needs a value/],
    [['run', '--dir', '--dry-run'], /--dir needs a value/],
  ])('%j is a usage error (exit 2) and runs nothing', async (args, message) => {
    expect(await cmdRoadmap(args)).toBe(2);
    expect(err.join('\n')).toMatch(message);
    expect(runGoalLoop).not.toHaveBeenCalled();
    expect(parseRoadmap).not.toHaveBeenCalled();
  });

  it('no subcommand prints usage on stderr and exits 2', async () => {
    expect(await cmdRoadmap([])).toBe(2);
    expect(err.join('\n')).toContain('Usage: ashlr roadmap');
    expect(out).toEqual([]);
  });

  it('valid flags still reach the loop', async () => {
    expect(await cmdRoadmap(['run', '--dry-run', '--engine', 'codex', '--roadmap', 'R.md', '--json'])).toBe(0);
    expect(runGoalLoop).toHaveBeenCalledTimes(1);
    expect(runGoalLoop.mock.calls[0]![0]).toMatchObject({ dryRun: true, engine: 'codex', roadmapFile: 'R.md' });
  });
});
