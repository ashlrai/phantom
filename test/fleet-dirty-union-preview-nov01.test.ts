import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyDiff3, classifyUnionConflict } from '../src/core/fleet/dirty-union-preview.js';
import { cmdFleetUnionPreview, parseConflictEntry } from '../src/cli/fleet-union-preview.js';

describe('union conflict classifier', () => {
  it.each([
    ['', 'left\n', 'right\n', 'union-safe'],
    ['a\n', 'a\nleft\n', 'a\nright\n', 'union-safe'],
    ['a\nb\n', 'a\nleft\n', 'a\nb\nright\n', 'needs-model'],
    ['a\n', 'a\nleft\n', 'a\nleft\n', 'needs-model'],
    ['a\n', 'a\n', 'a\nright\n', 'needs-model'],
    ['a\n', 'changed\n', 'a\nright\n', 'needs-model'],
  ] as const)('classifies base %j, ours %j, theirs %j as %s', (base, ours, theirs, expected) => {
    expect(classifyUnionConflict(base, ours, theirs)).toBe(expected);
  });
  it('requires every well-formed conflict hunk to be safe', () => {
    const safe = '<<<<<<< ours\nleft\n||||||| base\n=======\nright\n>>>>>>> theirs\n';
    const deletion = '<<<<<<< ours\n||||||| base\nold\n=======\nold\nnew\n>>>>>>> theirs\n';
    expect(classifyDiff3(safe + safe)).toBe('union-safe');
    expect(classifyDiff3(safe + deletion)).toBe('needs-model');
    expect(classifyDiff3(safe + '<<<<<<< ours\n')).toBe('needs-model');
  });
});

describe('fleet union preview', () => {
  const dirs: string[] = [];
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  it('rejects an incomplete conflict entry', () => {
    const entry = `100644 ${'a'.repeat(40)} 1\t`;
    expect(parseConflictEntry(entry)).toBeNull();
    const shortMatch = /^(\d{6}) ([0-9a-f]{40}) ([123])/.exec(entry);
    vi.spyOn(RegExp.prototype, 'exec').mockReturnValueOnce(shortMatch);
    expect(parseConflictEntry(entry)).toBeNull();
  });
  it('inspects real merge-tree conflicts in an isolated store and rejects a moved head', async () => {
    // Keep this local Git fixture independent of an operator's Secrets CLI.
    const gitPath = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0]!.trim();
    vi.stubEnv('PATH', [dirname(gitPath), ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin'])].join(delimiter));
    const dir = mkdtempSync(join(tmpdir(), 'union-fixture-')); dirs.push(dir);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '-b', 'master'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
    writeFileSync(join(dir, 'index.txt'), 'start\nend\n'); git('add', '.'); git('commit', '-qm', 'base');
    git('checkout', '-qb', 'topic'); writeFileSync(join(dir, 'index.txt'), 'start\ntopic\nend\n'); git('commit', '-qam', 'topic');
    const head = git('rev-parse', 'HEAD'); git('update-ref', 'refs/pull/1/head', head); git('update-ref', 'refs/pull/2/head', head);
    git('checkout', '-q', 'master'); writeFileSync(join(dir, 'index.txt'), 'start\nmaster\nend\n'); git('commit', '-qam', 'master');
    const status = git('status', '--porcelain');
    const row = (number: number, headRefOid: string) => ({ number, state: 'OPEN', isDraft: false, headRefOid, baseRefName: 'master', mergeStateStatus: 'DIRTY' });
    const gh = vi.fn(async () => ({ ok: true, stdout: JSON.stringify([row(1, head), row(2, 'a'.repeat(40))]), stderr: '' }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetUnionPreview(['--json'], { gh, remote: dir })).toBe(0);
    const report = JSON.parse(String(log.mock.calls[0]![0]));
    expect(report.prs[0]).toMatchObject({ number: 1, verdict: 'union-safe', files: ['index.txt'] });
    expect(report.counts).toEqual({ 'union-safe': 1, 'needs-model': 1 });
    expect(report.prs[1]).toMatchObject({ number: 2, verdict: 'needs-model', reason: 'head moved or base unavailable' });
    expect(git('status', '--porcelain')).toBe(status);
    expect(gh).toHaveBeenCalledOnce();
  });
});
