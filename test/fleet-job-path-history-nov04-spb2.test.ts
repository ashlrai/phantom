import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetPathHistory } from '../src/cli/fleet-path-history.js';
import { jobPathHistory } from '../src/core/fleet/job-path-history.js';

it('finds exact bridge jobs and renamed paths through real git, preserving path mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-path-'));
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  try {
    git('init'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
    writeFileSync(join(dir, 'old name.txt'), 'fake');
    git('add', '.'); git('commit', '-m', 'bridge(RQ-EXAMPLE): initial (#12)');
    renameSync(join(dir, 'old name.txt'), join(dir, 'new name.txt'));
    git('add', '-A'); git('commit', '-m', 'bridge(RQ-EXAMPLE-EXTRA): rename (#13)');
    writeFileSync(join(dir, 'plain.txt'), 'fake'); git('add', '.'); git('commit', '-m', 'plain');
    process.chdir(dir);
    expect(await cmdFleetPathHistory(['--job', 'RQ-EXAMPLE', '--ref', 'HEAD', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ scanned: 3, paths: ['old name.txt'], commits: [{ pr: 12 }] });
    expect(await cmdFleetPathHistory(['--job', 'RQ-EXAMPLE-EXTRA', '--ref', 'HEAD', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).paths).toEqual(['new name.txt', 'old name.txt']);
    expect(await cmdFleetPathHistory(['--job', 'RQ-MISSING', '--ref', 'HEAD'])).toBe(0);
    expect(log.mock.calls.at(-1)![0]).toContain('does not prove');
    expect(await cmdFleetPathHistory(['old name.txt', '--ref', 'HEAD', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)[0].jobId).toBe('RQ-EXAMPLE-EXTRA');
    for (const args of [['--job', 'RQ-X', 'path'], ['--job', 'RQ-X', '--job', 'RQ-Y'], ['--job', 'RQ-X', '--ref', 'HEAD~1'], ['--job', 'RQ-X', '--ref', '../main'], ['--job', 'RQ-', '--ref', 'HEAD'], ['--job', 'RQ-X', '--limit', '101']]) {
      expect(await cmdFleetPathHistory(args)).toBe(2);
    }
  } finally { process.chdir(cwd); log.mockRestore(); error.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

it('discloses a full scan and result truncation, and validates before invoking git', async () => {
  const oid = 'e'.repeat(40);
  const history = Array.from({ length: 1000 }, (_, i) => `${i.toString(16).padStart(40, '0')}\0date\0bridge(RQ-X): fake (#1)\0\n`).join('');
  const run = vi.fn(async (args: string[]) => args[0] === 'rev-parse' ? `${oid}\n` : args[0] === 'log' ? history : 'a path\0');
  const result = await jobPathHistory('RQ-X', 'HEAD', 1, run);
  expect(result).toMatchObject({ resolvedRef: oid, scanned: 1000, scanMayBeTruncated: true, matchesTruncated: true, paths: ['a path'] });
  expect(run).toHaveBeenCalledTimes(3); // resolve + one bounded log + one kept diff-tree
  await expect(jobPathHistory('RQ-X', 'HEAD^', 1, run)).rejects.toThrow();
  expect(run).toHaveBeenCalledTimes(3);
});
