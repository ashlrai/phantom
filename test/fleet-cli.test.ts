import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); dirs.length = 0; });
// The executable fixture uses /bin/sh; schema and command-dispatch unit tests
// remain cross-platform, while this POSIX smoke exercises real PATH lookup.
it.runIf(process.platform !== 'win32')('default fleet status --json publishes fleet.v1 end to end independently of legacy status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phantom-fleet-cli-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // Deterministic successful read-only GitHub fixture, never a live API call.
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\n[ "$1" = "pr" ] && [ "$2" = "list" ] || exit 5\nprintf "[]"\n', { mode: 0o700 });
  const path = join(dir, 'fleet.json');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ASHLR_HOME: dir, PHANTOM_FLEET_PATH: path, PRIVATE_FLEET_TEST_TOKEN: 'unshaped-private-canary-4751', NO_COLOR: '1' };
  const run = (args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'fleet', ...args], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 30_000 });
  const output = run(['status', '--json']);
  const snapshot = JSON.parse(output);
  expect(snapshot).toEqual(JSON.parse(readFileSync(path, 'utf8')));
  expect(snapshot.schema).toBe('fleet.v1');
  expect(snapshot.pools).toHaveLength(8);
  expect(snapshot.pools.find((p: { id: string }) => p.id === 'codex-cmp')).toMatchObject({ used_pct: null, projected_pct: null, source: 'unknown' });
  expect(snapshot.repos.every((r: { open: unknown[]; merged: unknown[] }) => r.open.length === 0 && r.merged.length === 0)).toBe(true);
  expect(output).not.toContain(env.PRIVATE_FLEET_TEST_TOKEN);
  expect(run(['status'])).toContain('unknown');
  expect(run(['claim', '--help'])).toContain('--lease');
  expect(existsSync(join(dir, 'fleet', 'coordination.jsonl'))).toBe(false);
});

it.each([
  { args: ['setup', '--dry-run'], code: 1, text: 'worker setup is temporarily unavailable' },
  { args: ['status', '--dry-run'], code: 0, text: 'ashlr worker status' },
  { args: ['unknown', '--dry-run'], code: 1, text: 'unknown worker subcommand: unknown' },
])('worker $args keeps its subcommand when --dry-run follows it', ({ args, code, text }) => {
  const dir = mkdtempSync(join(tmpdir(), 'phantom-worker-cli-'));
  dirs.push(dir);
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'worker', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: dir, USERPROFILE: dir, ASHLR_HOME: dir, NO_COLOR: '1' },
    encoding: 'utf8', timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(code);
  expect(result.stdout + result.stderr).toContain(text);
  expect(result.stdout).not.toContain('spawned: no');
  expect(existsSync(join(dir, 'config.toml'))).toBe(false);
});

it.each([['--dry-run', '--json'], ['plan', '--dry-run', '--json'], ['drain', '--dry-run', '--json']])(
  'worker %j prints the read-only queue plan', (...args) => {
    const dir = mkdtempSync(join(tmpdir(), 'phantom-worker-plan-'));
    dirs.push(dir);
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'worker', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: dir, USERPROFILE: dir, ASHLR_HOME: dir, NO_COLOR: '1' },
      encoding: 'utf8', timeout: 30_000,
    });
    expect(JSON.parse(output)).toEqual({ dryRun: true, meteredEnabled: false, steps: [] });
    expect(existsSync(join(dir, 'config.toml'))).toBe(false);
  },
);
