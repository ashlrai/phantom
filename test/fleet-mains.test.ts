import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetMains } from '../src/cli/fleet-mains.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

afterEach(() => vi.restoreAllMocks());
const fixture = () => readFile(new URL('./fixtures/fleet-mains.md', import.meta.url), 'utf8');

it('reads the guardian path through injection and returns every field in red-first JSON', async () => {
  const read = vi.fn(fixture);
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetMains(['--json'], { read })).toBe(1);
  expect(read).toHaveBeenCalledWith(join(homedir(), '.ashlr-runs/supervisor/status-main-guardian.md'));
  const report = JSON.parse(out.mock.calls[0]![0]);
  expect(report.source).toBe('ok');
  expect(report.repos.map((row: { repo: string }) => row.repo)).toEqual(['phantom', 'lexicon', 'locus']);
  expect(report.repos[0]).toEqual({ repo: 'phantom', branch: 'master', sha: 'abcdef2', state: 'red',
    checkedAt: expect.stringMatching(/^2026-11-03T11:58:00/), failingCheck: 'typecheck',
    fixJobs: ['FIX-A', 'FIX-B'], nightlyRed: 'nightly tests' });
  expect((await FLEET_SUBCOMMAND_LOADERS.mains!()).cmdFleetMains).toBe(cmdFleetMains);
});

it('prints one plain line per repo, red first, and exits zero for all green', async () => {
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  expect(await cmdFleetMains([], { read: fixture })).toBe(1);
  expect(out.mock.calls).toHaveLength(3);
  expect(out.mock.calls[0]![0]).toMatch(/^phantom\/master: red; SHA abcdef2; checked .*; failing check typecheck; open fix jobs FIX-A, FIX-B; nightly CI red nightly tests$/);
  expect(out.mock.calls[1]![0]).toContain('lexicon/main: green');
  for (const args of [[], ['--json']]) {
    expect(await cmdFleetMains(args, { read: async () => (await fixture()).replace('| red |', '| green |') })).toBe(0);
  }
});

it('reports missing or empty status without leaking reader errors', async () => {
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  expect(await cmdFleetMains(['--json'], { read: async () => { throw new Error('private detail'); } })).toBe(1);
  expect(JSON.parse(out.mock.calls[0]![0])).toEqual({ source: 'unavailable', repos: [] });
  expect(await cmdFleetMains([], { read: async () => '# no table' })).toBe(1);
});

it('handles help and rejects invalid arguments before reading', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const read = vi.fn(fixture);
  expect(await cmdFleetMains(['--help'], { read })).toBe(0);
  for (const args of [['--wat'], ['extra'], ['--json', '--json']]) {
    expect(await cmdFleetMains(args, { read })).toBe(2);
  }
  expect(read).not.toHaveBeenCalled();
});
