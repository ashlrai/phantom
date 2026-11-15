import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetWriteBudget } from '../src/cli/fleet-write-budget.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { planWriteBudget } from '../src/core/fleet/planner-write-budget.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const STATUS = {
  lanes: {
    devin: { running: 0, target: 2, queued: 184, held: false },
    'codex-personal': { running: 0, target: 4, queued: 22, held: false },
    gemini: { running: 1, target: 3, queued: 0, held: true },
    claude: { running: 4, target: 6, queued: 1, held: false },
  },
};

async function fixture(statusText: string | null = JSON.stringify(STATUS), claude = 'ok 2026-11-04 07:30:53') {
  const root = await mkdtemp(join(tmpdir(), 'write-budget-'));
  roots.push(root);
  await mkdir(join(root, 'queue'), { recursive: true });
  if (statusText !== null) await writeFile(join(root, 'queue', 'status.json'), statusText);
  await writeFile(join(root, 'queue', 'claude-lane.state'), claude);
  return root;
}

it('is registered and prints one line per lane plus a total', async () => {
  expect(resolveFleetSubcommand('write-budget')).toEqual({ module: './fleet-write-budget.js', exportName: 'cmdFleetWriteBudget' });
  expect((await FLEET_SUBCOMMAND_LOADERS['write-budget']!()).cmdFleetWriteBudget).toBe(cmdFleetWriteBudget);
  const root = await fixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetWriteBudget(['--runs-dir', root])).toBe(0);
  expect(log.mock.calls[0]![0]).toBe([
    'devin 2 (free 2, queued ignored)',
    'codex-personal 0 (free 4, queued 22 covers it)',
    'gemini 0 (held)',
    'claude 1 (free 2, queued 1)',
    'total 3',
  ].join('\n'));
  expect(err).not.toHaveBeenCalled();
  // Read-only: the status file is untouched.
  expect(await readFile(join(root, 'queue', 'status.json'), 'utf8')).toBe(JSON.stringify(STATUS));
});

it('prints the plan object with --json', async () => {
  const root = await fixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetWriteBudget(['--json', '--runs-dir', root])).toBe(0);
  const printed = JSON.parse(log.mock.calls[0]![0] as string);
  expect(printed).toEqual(planWriteBudget([
    { lane: 'devin', running: 0, target: 2, queued: 184, held: false },
    { lane: 'codex-personal', running: 0, target: 4, queued: 22, held: false },
    { lane: 'gemini', running: 1, target: 3, queued: 0, held: true },
    { lane: 'claude', running: 4, target: 6, queued: 1, held: false },
  ], { claudeLane: 'ok 2026-11-04 07:30:53' }));
  expect(printed.v).toBe(1);
  expect(printed.total).toBe(3);
});

it('reports the claude lane down when claude-lane.state is not ok', async () => {
  const root = await fixture(JSON.stringify(STATUS), 'down token rejected');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetWriteBudget(['--runs-dir', root])).toBe(0);
  expect(log.mock.calls[0]![0]).toContain('claude 0 (claude lane down)');
});

it('prints usage on --help and rejects unknown flags', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetWriteBudget(['--help'])).toBe(0);
  expect(log.mock.calls[0]![0]).toContain('Usage: ashlr fleet write-budget');
  for (const args of [['--nope'], ['--runs-dir'], ['--json', '--json'], ['extra'], ['--help', '--json']]) {
    expect(await cmdFleetWriteBudget(args)).toBe(2);
  }
  expect(err).toHaveBeenCalled();
});

it('exits 1 with one error line when status.json is missing, oversized or invalid', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const missing = await fixture(null);
  expect(await cmdFleetWriteBudget(['--runs-dir', missing])).toBe(1);
  expect(err.mock.calls.at(-1)![0]).toMatch(/^error: /);
  for (const bad of ['{', 'null', '{"lanes":{"a":7}}', '{"lanes":[]}']) {
    const root = await fixture(bad);
    expect(await cmdFleetWriteBudget(['--runs-dir', root])).toBe(1);
    expect(err.mock.calls.at(-1)![0]).toMatch(/^error: /);
  }
  const big = await fixture('x'.repeat(1024 * 1024 + 1));
  expect(await cmdFleetWriteBudget(['--runs-dir', big])).toBe(1);
  expect(log).not.toHaveBeenCalled();
});
