import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetDiffScan, readDiffScan, scanAddedLines } from '../src/cli/fleet-diff-scan.js';

const hex = () => ['ab12', 'cd34', 'ef56', '7890'].join('').repeat(2);
const base64 = () => ['Ab9/', 'Cd8+', 'Ef7/', 'Gh6+'].join('').repeat(3);
const key = () => ['gh', 'p_', 'Ab12'.repeat(6)].join('');
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'diff-scan-'));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'base');
  return { root, git };
}

it('finds added lines by type and new line number without returning values', () => {
  const patch = ['@@ -1,2 +1,4 @@', '-old', ' keep', `+${hex()}`, `+${base64()}`, `+${key()}`].join('\n');
  expect(scanAddedLines('a.ts', patch)).toEqual([
    { file: 'a.ts', line: 2, kind: 'long hex' },
    { file: 'a.ts', line: 3, kind: 'long base64' },
    { file: 'a.ts', line: 4, kind: 'key prefix' },
  ]);
});

it('ignores headers, removed lines, context and ordinary words across hunks', () => {
  const patch = [`+++ b/${key()}`, '@@ -1 +1 @@', `-${key()}`, '+plain words', '@@ -9 +8,2 @@', ` ${hex()}`, `+${key()}`].join('\n');
  expect(scanAddedLines('a', patch)).toEqual([{ file: 'a', line: 9, kind: 'key prefix' }]);
  expect(scanAddedLines('a', '@@ -0,0 +1 @@\n+' + 'ordinary'.repeat(8))).toEqual([]);
});

it('reads staged and unstaged changes, literal odd paths, and leaves the worktree untouched', () => {
  const { root, git } = repo();
  const file = 'odd [name]\t.txt';
  writeFileSync(join(root, file), 'plain\n'); git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'file');
  writeFileSync(join(root, file), `plain\n${hex()}\n`); git('add', '.');
  writeFileSync(join(root, file), `plain\n${hex()}\n${key()}\n`);
  writeFileSync(join(root, 'untracked'), base64());
  const before = git('status', '--porcelain=v1').toString();
  expect(readDiffScan(root).findings).toEqual([
    { file, line: 2, kind: 'long hex' }, { file, line: 3, kind: 'key prefix' },
  ]);
  expect(git('status', '--porcelain=v1').toString()).toBe(before);
  expect(readFileSync(join(root, file), 'utf8')).toContain(key());
});

it('prints safe JSON, accepts a clean diff, and reports errors without git output', async () => {
  const { root, git } = repo();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetDiffScan(['--dir', root, '--json'])).toBe(0);
  expect(JSON.parse(String(log.mock.calls[0]![0]))).toEqual({ schema: 'fleet.diff-scan.v1', findings: [] });
  writeFileSync(join(root, 'added'), key()); git('add', '.');
  expect(await cmdFleetDiffScan(['--dir', root, '--json'])).toBe(0);
  expect(JSON.stringify(log.mock.calls)).not.toContain(key());
  expect(JSON.parse(String(log.mock.calls.at(-1)![0])).findings).toEqual([{ file: 'added', line: 1, kind: 'key prefix' }]);
  expect(await cmdFleetDiffScan(['--dir', join(root, key()), '--json'])).toBe(1);
  expect(JSON.stringify(error.mock.calls)).not.toContain(key());
  for (const args of [[], ['--dir'], ['--unknown'], ['--json', '--json']]) expect(await cmdFleetDiffScan(args)).toBe(2);
});

it('recognizes common key prefixes built from short parts', () => {
  const values = [
    ['sk', '-', 'Ab12'.repeat(6)], ['github', '_pat_', 'Ab12'.repeat(6)],
    ['AK', 'IA', 'AB12'.repeat(4)], ['xo', 'xb-', 'Ab12'.repeat(6)],
  ];
  for (const parts of values) expect(scanAddedLines('a', '@@ -0,0 +1 @@\n+' + parts.join('')))
    .toEqual([{ file: 'a', line: 1, kind: 'key prefix' }]);
});
