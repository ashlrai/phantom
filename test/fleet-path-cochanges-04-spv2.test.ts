import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { pathCochanges } from '../src/core/fleet/path-cochanges.js';
import { cmdFleetPathCochanges } from '../src/cli/fleet-path-cochanges.js';

it('reads literal paths and ranks bridge cochanges using a resolved snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cochanges-'));
  const cwd = process.cwd();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = (subject: string, files: string[]) => {
    for (const name of files) writeFileSync(join(dir, name), `${subject}\n`);
    git('add', '--all'); git('commit', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
    const old = commit('bridge(RQ-OLD): first', ['literal[1].txt', 'shared space.txt', 'z.txt']);
    const latest = commit('bridge(RQ-NEW): second', ['literal[1].txt', 'shared space.txt', 'a.txt']);
    commit('plain commit', ['literal[1].txt', 'plain.txt']);
    commit('bridge(RQ-OTHER): wildcard trap', ['literal1.txt', 'wrong.txt']);
    git('update-ref', 'refs/remotes/origin/master', 'HEAD');
    const snapshot = git('rev-parse', 'origin/master');
    process.chdir(dir);
    const result = await pathCochanges('literal[1].txt');
    expect(result).toMatchObject({ resolvedRef: snapshot, sampledCount: 3, examinedCount: 2,
      paths: [
        { path: 'shared space.txt', count: 2, evidence: [{ sha: latest, jobId: 'RQ-NEW' }, { sha: old, jobId: 'RQ-OLD' }] },
        { path: 'a.txt', count: 1 }, { path: 'z.txt', count: 1 },
      ] });
    expect(JSON.stringify(result)).not.toContain('plain.txt');
    expect(JSON.stringify(result)).not.toContain('wrong.txt');
    expect(result.notice).toMatch(/does not prove/i);
    const limited = await pathCochanges('literal[1].txt', { limit: 1 });
    expect(limited).toMatchObject({ pathsTruncated: true, omittedPaths: 2, paths: [{ path: 'shared space.txt' }] });
    expect((await pathCochanges('missing file')).paths).toEqual([]);
    const newer = commit('bridge(RQ-MOVED): moved', ['literal[1].txt', 'moved.txt']);
    const moved = await pathCochanges('literal[1].txt', { git: async (args: string[]) => {
      const value = git(...args);
      if (args[0] === 'rev-parse') git('update-ref', 'refs/remotes/origin/master', newer);
      return value;
    } });
    expect(moved.resolvedRef).toBe(snapshot);
    expect(JSON.stringify(moved.paths)).not.toContain('moved.txt');
    git('update-ref', '-d', 'refs/remotes/origin/master');
    await expect(pathCochanges('missing file')).rejects.toThrow();
  } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
});

it('bounds sampling and matching commit inspection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cochanges-bound-'));
  const cwd = process.cwd();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    git('init'); git('config', 'user.name', 'Fake'); git('config', 'user.email', 'fake@example.invalid');
    for (let i = 0; i < 101; i++) {
      writeFileSync(join(dir, 'input'), String(i)); writeFileSync(join(dir, 'companion'), String(i));
      git('add', '--all'); git('commit', '-m', `bridge(RQ-${i}): fixture`);
    }
    git('update-ref', 'refs/remotes/origin/master', 'HEAD'); process.chdir(dir);
    const result = await pathCochanges('input');
    expect(result).toMatchObject({ sampledCount: 100, examinedCount: 20, commitsTruncated: true, matchesTruncated: true,
      paths: [{ path: 'companion', count: 20 }] });
    expect(result.paths[0]!.evidence.length).toBeLessThanOrEqual(20);
  } finally { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

it('rejects malformed CLI flags and unsafe repository paths', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const args of [[], ['x', '--limit'], ['x', '--limit', '0'], ['x', '--limit', '101'],
      ['x', '--limit', '1.5'], ['x', '--limit', '1', '--limit', '2'], ['x', '--json', '--json'],
      ['x', '--ref', 'HEAD'], ['x', 'extra'], ['/absolute'], ['../outside'], ['a/../b'], ['']]) {
      expect(await cmdFleetPathCochanges(args)).toBe(2);
    }
  } finally { error.mockRestore(); }
});
