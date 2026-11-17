import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdRelease } from '../src/cli/release.js';
import { buildReleaseNotes, collectReleaseNotes, formatReleaseNotes, parseNotesLog, writeReleaseNotes } from '../src/core/release/notes.js';

const record = (id: number, subject: string, file = 'src/core/search.ts', author = 'Developer') =>
  `\x1e${id.toString(16).padStart(40, '0')}\0${author}\0${subject}\0\0\n${file}\0`;
const fixture = record(1, 'feat: add offline search (#11)') + record(2, 'perf: speed up search (#12)')
  + record(3, 'fix: restore saved searches (#13)') + record(4, 'fix: verify search fixtures (#14)', 'test/search.test.ts')
  + record(5, 'bridge(RQ-RECUT): recut: feat: add offline search (#15)')
  + record(6, 'Merge branch topic') + record(7, 'chore(deps): bump tools (#17)', 'package-lock.json', 'dependabot[bot]')
  + record(8, 'fix: preserve empty searches (#18)', 'src/core/search.ts', 'repair[bot]');
const report = () => buildReleaseNotes('v1.0.0', 'head', parseNotesLog(fixture));
const directories: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'release-notes-')); directories.push(path); return path; };
afterEach(() => { vi.restoreAllMocks(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('release notes', () => {
  it('groups fake Git records, collapses recuts, and drops merge and bot chore noise', () => {
    const notes = report();
    expect(notes.groups.New).toMatchObject([{ text: 'Add offline search', prs: [11, 15] }]);
    expect(notes.groups.Improved).toMatchObject([{ text: 'Speed up search', prs: [12] }]);
    expect(notes.groups.Fixed.map(change => change.prs)).toEqual([[18], [13]]);
    expect(notes.groups.Internal).toMatchObject([{ prs: [14] }]);
    expect(notes.summary).toEqual(['5 changes since v1.0.0.', '1 new, 1 improved, 2 fixed, 1 internal.', 'Highlights: Add offline search; Preserve empty searches.']);
    expect(formatReleaseNotes(notes)).toContain('- Add offline search (#11, #15).');
    expect(JSON.stringify(notes)).not.toMatch(/#16|bump tools|Merge pull/);
  });
  it('has stable JSON group, entry and provenance order regardless of log order', () => {
    expect(JSON.stringify(buildReleaseNotes('v1.0.0', 'head', parseNotesLog(fixture).reverse()))).toBe(JSON.stringify(report()));
    expect(Object.keys(report().groups)).toEqual(['New', 'Improved', 'Fixed', 'Internal']);
  });
  it('renders an empty range and rejects malformed log records', () => {
    expect(formatReleaseNotes(buildReleaseNotes('v1.0.0', 'head', []))).toBe('Nothing new since v1.0.0\n');
    expect(() => parseNotesLog('\x1einvalid\0author\0subject\0')).toThrow('Invalid Git log');
  });
  it('keeps opaque changes distinct and links recuts to their original PR', () => {
    const notes = buildReleaseNotes('v1.0.0', 'head', parseNotesLog(record(1, 'bridge(RQ-A): (#20)') + record(2, 'bridge(RQ-B): (#21)') + record(3, 'bridge(RQ-C): Recut of #20 (#22)')));
    expect(notes.groups.Improved.map(change => change.prs)).toEqual([[20, 22], [21]]);
  });
  it('keeps descriptive originals across reversed and chained recuts, including clock code', () => {
    const notes = buildReleaseNotes('v1.0.0', 'head', parseNotesLog(record(1, 'bridge: Recut of #22 (#23)') + record(2, 'bridge: Recut of #20 (#22)') + record(3, 'feat: add clock (#20)', 'src/core/clock.ts')));
    expect(notes.groups.New).toMatchObject([{ text: 'Add clock', prs: [20, 22, 23] }]);
    expect(notes.groups.Improved).toEqual([]);
  });
  it('prepends once, preserves historical/handwritten bytes and CRLF, and refuses unsafe files', () => {
    const root = temp(), path = join(root, 'CHANGELOG.md');
    const old = '# Changelog\r\n\r\n## [Unreleased]\r\n\r\n### Added\r\n\r\n- Existing.\r\n\r\n## [1.0.0] - 2026-01-01\r\n\r\nFrozen.\r\n';
    writeFileSync(path, old); writeReleaseNotes(root, report());
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('### Added\r\n\r\n- Add offline search');
    expect(written.endsWith(old.slice(old.indexOf('\r\n\r\n### Added')))).toBe(true);
    writeReleaseNotes(root, report()); expect(readFileSync(path, 'utf8')).toBe(written);
    writeFileSync(path, written.replace('<!-- release-notes:end -->', '<!-- release-notes:end --><!-- release-notes:start -->'));
    expect(() => writeReleaseNotes(root, report())).toThrow('Invalid generated');
    writeFileSync(path, '# Changelog\n## [1.0.0]\n');
    expect(() => writeReleaseNotes(root, report())).toThrow('Unreleased');
    rmSync(path); symlinkSync(join(root, 'outside.md'), path);
    expect(() => writeReleaseNotes(root, report())).toThrow('regular file');
  });
  it('collects squash and ordinary PR merges and exercises the CLI JSON/write path', { timeout: 30_000 }, () => {
    const root = temp();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    git('commit', '--allow-empty', '-qm', 'initial'); git('tag', 'v1.0.0');
    expect(collectReleaseNotes(root).summary).toEqual(['Nothing new since v1.0.0']);
    writeFileSync(join(root, 'search.ts'), 'export {};'); git('add', '.'); git('commit', '-qm', 'feat: add search (#30)');
    git('tag', 'v2.0.0-rc.1');
    expect(collectReleaseNotes(root).groups.New[0]?.prs).toEqual([30]);
    expect(() => collectReleaseNotes(root, '--all')).toThrow('Invalid release tag');
    expect(() => collectReleaseNotes(root, 'missing')).toThrow('Cannot read Git history');
    expect(() => collectReleaseNotes(root, 'v2.0.0-rc.1', 'v1.0.0')).toThrow('mainline');
    git('checkout', '-qb', 'topic'); writeFileSync(join(root, 'clock.ts'), 'export {};'); git('add', '.'); git('commit', '-qm', 'implementation');
    git('checkout', '-q', 'main'); git('merge', '--no-ff', 'topic', '-m', 'Merge pull request #31 from topic\n\nfix: restore clock');
    expect(collectReleaseNotes(root).groups.Fixed).toMatchObject([{ text: 'Restore clock', prs: [31] }]);
    writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\nKeep this.\n');
    const cli = execFileSync(fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)), [fileURLToPath(new URL('../src/cli/index.ts', import.meta.url)), 'release', 'notes', '--json', '--write'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    expect(JSON.parse(cli)).toEqual(collectReleaseNotes(root));
    expect(readFileSync(join(root, 'CHANGELOG.md'), 'utf8')).toContain('Restore clock (#31)');
  });
  it('validates CLI arguments before any write and preserves status usage', async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(text => { output.push(String(text)); return true; });
    expect(await cmdRelease(['notes', '--json', '--write', '--since'])).toBe(2);
    expect(JSON.parse(output.pop()!).ok).toBe(false);
    expect(await cmdRelease(['notes', '--json', '--write', '--write'])).toBe(2);
    expect(await cmdRelease(['--help'])).toBe(0);
    expect(output.pop()).toContain('release status');
  });
});
