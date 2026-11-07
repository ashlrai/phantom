import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdFleetPathHistory } from '../src/cli/fleet-path-history.js';

it('reads real git history as JSON newest first and supports text and limits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'path-history-'));
  const cwd = process.cwd();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    for (const [i, subject] of ['bridge(RQ-OLD): first (#1)', 'plain', 'bridge(FIXUP-CI-test-1): latest (#2)'].entries()) {
      writeFileSync(join(dir, 'file with spaces.txt'), String(i));
      git('add', '.'); git('commit', '-m', subject);
    }
    process.chdir(dir);
    expect(await cmdFleetPathHistory(['file with spaces.txt', '--ref', 'HEAD', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject([
      { jobId: 'FIXUP-CI-test-1', pr: 2, title: 'latest' }, { jobId: 'RQ-OLD', pr: 1, title: 'first' },
    ]);
    expect(await cmdFleetPathHistory(['file with spaces.txt', '--ref', 'HEAD', '--limit', '1'])).toBe(0);
    expect(log.mock.calls.at(-1)![0]).toMatch(/^#2 FIXUP-CI-test-1 .* latest$/);
    expect(await cmdFleetPathHistory(['absent', '--ref', 'HEAD'])).toBe(0);
    expect(log.mock.calls.at(-1)![0]).toBe('no fleet jobs touched absent');
    expect(await cmdFleetPathHistory(['file', '--limit', '0'])).toBe(2);
    expect(await cmdFleetPathHistory(['file', '--ref', 'missing-ref'])).toBe(1);
  } finally { process.chdir(cwd); log.mockRestore(); error.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});
