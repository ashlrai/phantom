import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatReleases, getReleases, parseMergedPrs, releaseCadence, releaseDueLine } from '../src/core/release/status.js';

const now = Date.parse('2026-11-18T12:00:00Z');
const day = (n: number) => new Date(now - n * 86_400_000).toISOString();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A clone with a tag and `subjects` merged after it, oldest first. */
function clone(subjects: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'release-titles-')); roots.push(root);
  const path = join(root, 'locus');
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: day(1), GIT_COMMITTER_DATE: day(1) } });
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('commit', '--allow-empty', '-qm', 'release'); git('tag', 'v1.0.0');
  for (const subject of subjects) git('commit', '--allow-empty', '-qm', subject);
  git('update-ref', 'refs/remotes/origin/main', 'HEAD'); git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  return root;
}
const read = (subjects: string[]) => getReleases({ root: clone(subjects), repos: ['locus'], now, installed: () => ({ version: null }) as never }).repos[0]!;

describe('merged PR titles in the release report', () => {
  it('has an empty list when nothing merged since the tag', () => {
    expect(read([])).toMatchObject({ mergedPrsSince: 0, recentPrs: [] });
  });
  it('lists three PRs newest first, as plain number and title', () => {
    const row = read(['add tags (#1)', 'fix links (#2)', 'Merge pull request #3 from team/more-docs', 'direct commit']);
    expect(row.recentPrs).toEqual([{ number: 3, title: 'team/more-docs' }, { number: 2, title: 'fix links' }, { number: 1, title: 'add tags' }]);
    expect(row.mergedPrsSince).toBe(3);
  });
  it('shows only the newest five when more merged, and says how many are left', () => {
    const subjects = Array.from({ length: 8 }, (_, i) => `change ${i + 1} (#${i + 1})`);
    const report = getReleases({ root: clone(subjects), repos: ['locus'], now, installed: () => ({ version: null }) as never });
    const row = report.repos[0]!;
    expect(row.recentPrs?.map(pr => pr.number)).toEqual([8, 7, 6, 5, 4]);
    expect(row.mergedPrsSince).toBe(8);
    expect(formatReleases(report)).toContain('    #8 change 8\n');
    expect(formatReleases(report)).toContain('    and 3 more\n');
  });
  it('reads unknown as null, never as an empty list', () => {
    expect(getReleases({ root: tmpdir(), repos: ['no-such-clone'], now }).repos[0]?.recentPrs).toBeNull();
    expect(releaseCadence([{ repo: 'ashlrai/locus', latestTag: 'v1', taggedAt: day(2), mergedPrsSinceTag: null }], now).repos[0]?.recentPrs).toBeNull();
  });
  it('parses squash and merge subjects once per number and keeps titles to plain text', () => {
    expect(parseMergedPrs('a (#7)\nb (#7)\n(#9)\nplain\nMerge pull request #4 from x/y')).toEqual([
      { number: 7, title: 'a' }, { number: 9, title: 'PR #9' }, { number: 4, title: 'x/y' }]);
    expect(parseMergedPrs(`${'long '.repeat(40)} (#5)`)[0]?.title).toHaveLength(100);
  });
});

describe('release digest line', () => {
  const input = (repo: string, tag: string | null, ago: number | null, prs: number | null, readable = true) =>
    ({ repo: `ashlrai/${repo}`, latestTag: tag, taggedAt: ago === null ? null : day(ago), mergedPrsSinceTag: prs, readable });
  it('names the most overdue repo when a release is due', () => {
    expect(releaseDueLine(releaseCadence([input('phantom', 'v3.1.0', 1, 2), input('locus', 'v0.9.1', 11, 62)], now))).toBe('Release due: locus, 62 PRs since v0.9.1, 11 days');
    expect(releaseDueLine(releaseCadence([input('locus', 'v0.9.1', 8, 1)], now))).toBe('Release due: locus, 1 PR since v0.9.1, 8 days');
  });
  it('says none when nothing is due', () => {
    expect(releaseDueLine(releaseCadence([input('phantom', 'v3.1.0', 1, 2)], now))).toBe('Release due: none');
    expect(releaseDueLine(releaseCadence([input('phantom', 'v3.1.0', 1, 2), input('lexicon', null, null, null, false)], now))).toBe('Release due: none (1 unknown)');
  });
  it('says unknown when nothing could be read', () => {
    expect(releaseDueLine(releaseCadence([input('locus', null, null, null, false)], now))).toBe('Release due: unknown');
    expect(releaseDueLine(releaseCadence([], now))).toBe('Release due: unknown');
    expect(releaseDueLine(null)).toBe('Release due: unknown');
  });
});
