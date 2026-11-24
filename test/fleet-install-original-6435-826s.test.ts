import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { previewFleetInstall } from '../src/core/fleet/install.js';
import { cmdFleet } from '../src/cli/fleet-entry.js';
const roots: string[] = [];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(() => { roots.forEach(root => rmSync(root, { recursive: true, force: true })); roots.length = 0; vi.restoreAllMocks(); });
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'fleet-install-')); roots.push(repo);
  const bin = join(repo, 'live');
  for (const dir of ['fleet', 'contrib/mac', 'live']) mkdirSync(join(repo, dir), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git('init'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  const names = ['same', 'drifted', 'unpinned', 'missing'];
  writeFileSync(join(repo, 'fleet/manifest.json'), JSON.stringify({ schema: 'fleet.machinery.v1', files: names.map(name => ({ src: `contrib/mac/${name}.py`, root: 'runs-bin', class: 'managed' })) }));
  writeFileSync(join(repo, 'contrib/mac/install.sh'), 'FILES="installer.py"\n');
  for (const name of [...names, 'installer', 'discovered']) writeFileSync(join(repo, `contrib/mac/${name}.py`), 'new\n');
  git('add', 'fleet', 'contrib'); git('commit', '-qm', 'merged fleet scripts');
  const masterSha = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/master', masterSha);
  for (const name of ['same', 'drifted', 'unpinned', 'discovered']) writeFileSync(join(bin, `${name}.py`), name === 'drifted' ? 'old\n' : 'new\n');
  const pins = join(bin, 'sandbox-pins.tsv'); writeFileSync(pins, `same.py\t${sha('new\n')}\ndrifted.py\t${sha('old\n')}\n`);
  return { repo, bin, pins, masterSha };
}
const snapshot = (dir: string) => readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')]);
it('reports same, drifted, unpinned and missing committed files and writes only the review bundle', async () => {
  const { repo, bin, masterSha } = fixture(); const before = snapshot(bin);
  writeFileSync(join(repo, 'contrib/mac/same.py'), 'dirty branch edit\n');
  const report = await previewFleetInstall(repo, bin);
  expect(report).toMatchObject({ schema: 'fleet.install.v1', masterSha, masterRef: 'refs/remotes/origin/master' });
  const row = (name: string) => report.files.find(file => file.name === `${name}.py`);
  expect(row('same')).toMatchObject({ state: 'same', pinState: 'matched', sourceSha256: sha('new\n'), liveSha256: sha('new\n'), pinSha256: sha('new\n') });
  expect(row('drifted')).toMatchObject({ state: 'drifted', pinState: 'matched', diff: expect.stringContaining('-old') });
  expect(row('drifted')?.diff).toContain('+new');
  expect(row('unpinned')).toMatchObject({ state: 'same', pinState: 'unpinned', pinSha256: null });
  expect(row('missing')).toMatchObject({ state: 'missing', liveSha256: null });
  expect(row('installer')?.state).toBe('missing'); expect(row('discovered')?.state).toBe('same');
  expect(row('dispatchd_guard')).toMatchObject({ source: null, state: 'unknown' });
  expect(report.bundle).toMatch(/^docs\/proposals\/fleet-install-\d{4}-\d{2}-\d{2}\.md$/);
  const bundle = readFileSync(join(repo, report.bundle), 'utf8');
  expect(bundle).toContain('| dispatchd_guard.py | unknown | unknown | unknown | unknown | unknown | unpinned |'); expect(bundle).toContain('-old'); expect(bundle).toMatch(/rollback/i); expect(bundle).toMatch(/tests/i);
  expect(snapshot(bin)).toEqual(before);
});
it('keeps unavailable pins unknown and identifies a mismatching pin', async () => {
  const { repo, bin, pins } = fixture();
  writeFileSync(pins, `same.py\t${sha('different')}\n`);
  expect((await previewFleetInstall(repo, bin)).files.find(file => file.name === 'same.py')?.pinState).toBe('mismatch');
  for (const invalid of [true, false]) {
    if (invalid) writeFileSync(pins, 'malformed\n'); else rmSync(pins);
    const report = await previewFleetInstall(repo, bin);
    expect(report.files.find(file => file.name === 'same.py')).toMatchObject({ pinState: 'unknown', pinSha256: null });
    expect(report.gaps.length).toBeGreaterThan(0);
  }
});
it('refuses live symlinks and a bundle directory pointing into the live bin', async () => {
  const { repo, bin } = fixture(); symlinkSync(join(bin, 'same.py'), join(bin, 'missing.py'));
  expect((await previewFleetInstall(repo, join(repo, 'unknown-bin'))).files.every(file => file.state === 'unknown')).toBe(true);
  await expect(previewFleetInstall(repo, tmpdir())).rejects.toThrow('Scratch overlaps live bin');
  expect((await previewFleetInstall(repo, bin)).files.find(file => file.name === 'missing.py')?.state).toBe('unknown');
  rmSync(join(repo, 'docs/proposals'), { recursive: true }); symlinkSync(bin, join(repo, 'docs/proposals'));
  const before = snapshot(bin); await expect(previewFleetInstall(repo, bin)).rejects.toThrow(); expect(snapshot(bin)).toEqual(before);
});
it('scrubs review diffs while preserving hashes of the original bytes', async () => {
  const { repo, bin } = fixture(); const content = `private path ${process.env.HOME}/private/file\n`;
  writeFileSync(join(bin, 'drifted.py'), content);
  const report = await previewFleetInstall(repo, bin); const row = report.files.find(file => file.name === 'drifted.py');
  expect(row?.liveSha256).toBe(sha(content)); expect(row?.diff).toContain('~/private/file');
  expect(JSON.stringify(report) + readFileSync(join(repo, report.bundle), 'utf8')).not.toContain(content.trim());
});
it('exposes JSON and a plain summary while rejecting install mutations', async () => {
  const { repo, bin } = fixture(); const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleet(['install', '--dry-run', '--repo', repo, '--bin', bin, '--json'])).toBe(1);
  expect(JSON.parse(String(output.mock.calls[0]?.[0])).schema).toBe('fleet.install.v1');
  expect(error.mock.calls.some(call => /bundle at/.test(String(call[0])))).toBe(true);
  expect(await cmdFleet(['install', '--apply'])).toBe(2); expect(await cmdFleet(['install', '--json'])).toBe(2);
  expect(await cmdFleet(['install', '--dry-run', '--dry-run'])).toBe(2);
  expect(await cmdFleet(['install', '--dry-run', '--unexpected'])).toBe(2);
  expect(readdirSync(join(repo, 'docs/proposals')).some(name => name.startsWith('.fleet-install-'))).toBe(false);
});
