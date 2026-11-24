import { copyFile, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdJobs } from '../src/cli/jobs-empty.js';
import { cmdJobsStranded } from '../src/cli/jobs-stranded.js';
import { nextStep, parseSinceHours, readStrandedBranches, recoverCommand, strandedDigestLine } from '../src/core/fleet/stranded-branches.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function runsDir(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'stranded-jobs-')); dirs.push(dir);
  for (const [job, fixture] of Object.entries(files)) await copyFile(`test/fixtures/stranded/${fixture}.publish`, join(dir, `${job}.publish`));
  return dir;
}
const all = { 'RQ-RESULT': 'result-abort', 'RQ-BARE': 'bare-abort', 'RQ-OTHER': 'other-abort', 'RQ-UNPUSHED': 'unpushed', 'RQ-DONE': 'published', 'RQ-FIXED': 'recovered' };

const NOW = Date.UTC(2026, 10, 19, 12);
async function aged(dir: string, job: string, hours: number) { const t = new Date(NOW - hours * 3600_000); await utimes(join(dir, `${job}.publish`), t, t); }

it('lists every abort after a push with repo, age, files and next step; skips unpushed and published logs', async () => {
  const dir = await runsDir(all);
  await writeFile(join(dir, 'RQ-RESULT.publish'), `${(await import('node:fs')).readFileSync('test/fixtures/stranded/result-abort.publish', 'utf8')} 3 files changed, 9 insertions(+)\nRESULT ABORT default-fetch\n`);
  await aged(dir, 'RQ-RESULT', 2); await aged(dir, 'RQ-BARE', 30); await aged(dir, 'RQ-OTHER', 1);
  const report = await readStrandedBranches(dir, { now: NOW });
  expect(report).toMatchObject({ schema: 'jobs.stranded.v1', readOnly: true, status: 'ok', sinceHours: null, unreadable: [] });
  expect(report.branches.map(b => b.job)).toEqual(['RQ-BARE', 'RQ-OTHER', 'RQ-RESULT']);
  expect(report.branches[2]).toEqual({
    job: 'RQ-RESULT', branch: 'codex-bridge/RQ-RESULT', shape: 'result-abort', reason: 'default-fetch', repo: 'example/phantom', ageHours: 2, filesChanged: 3,
    next: nextStep('codex-bridge/RQ-RESULT'), recover: recoverCommand('codex-bridge/RQ-RESULT'),
  });
  expect(report.branches[0]).toMatchObject({ shape: 'bare-abort', repo: 'example/phantom', ageHours: 30, filesChanged: null });
  expect(report.branches[1]).toMatchObject({ reason: 'gh-pr-create', repo: null, filesChanged: null });
  expect(nextStep('codex-bridge/RQ-X')).toBe('Re-queue as a recovery job: fetch codex-bridge/RQ-X from the fork and re-publish.');
  expect(report.recovered).toEqual([{ job: 'RQ-FIXED', branch: 'codex-bridge/RQ-FIXED', pr: 'https://github.com/example/phantom/pull/2' }]);
});

it('a clean publish, an abort before the push and an empty directory are not stranded', async () => {
  for (const files of [{ 'RQ-DONE': 'published' }, { 'RQ-UNPUSHED': 'unpushed' }, {}]) {
    const report = await readStrandedBranches(await runsDir(files), { now: NOW });
    expect(report).toMatchObject({ status: 'ok', branches: [], unreadable: [] });
    expect(strandedDigestLine(report)).toBeNull();
  }
});

it('--since keeps only recent jobs and parses m, h and d', async () => {
  const dir = await runsDir({ 'RQ-RESULT': 'result-abort', 'RQ-BARE': 'bare-abort' });
  await aged(dir, 'RQ-RESULT', 2); await aged(dir, 'RQ-BARE', 30);
  const report = await readStrandedBranches(dir, { now: NOW, sinceHours: parseSinceHours('24h') });
  expect(report.sinceHours).toBe(24);
  expect(report.branches.map(b => b.job)).toEqual(['RQ-RESULT']);
  expect([parseSinceHours('90m'), parseSinceHours('2d'), parseSinceHours('x'), parseSinceHours('0h')]).toEqual([1.5, 48, null, null]);
});

it('digest line appears only above zero', async () => {
  const report = await readStrandedBranches(await runsDir({ 'RQ-RESULT': 'result-abort', 'RQ-BARE': 'bare-abort' }), { now: NOW });
  expect(strandedDigestLine(report)).toBe('stranded: 2 finished jobs pushed a branch but opened no PR (phm jobs stranded)');
  expect(strandedDigestLine({ branches: report.branches.slice(0, 1) })).toContain('1 finished job pushed');
  expect(strandedDigestLine(null)).toBeNull();
});

it('recovery command is idempotent: it only creates a PR when none exists', () => {
  const cmd = recoverCommand('codex-bridge/RQ-X');
  expect(cmd).toBe("gh pr view 'codex-bridge/RQ-X' >/dev/null 2>&1 || gh pr create --head 'codex-bridge/RQ-X' --fill");
});

it('marks unreadable logs unknown instead of clean', async () => {
  const dir = await runsDir({ 'RQ-RESULT': 'result-abort' });
  await writeFile(join(dir, 'RQ-BIG.publish'), 'x'.repeat(2 * 1024 * 1024 + 1));
  await symlink(join(dir, 'RQ-RESULT.publish'), join(dir, 'RQ-LINK.publish'));
  await mkdir(join(dir, 'RQ-DIR.publish'));
  const report = await readStrandedBranches(dir);
  expect(report.status).toBe('unknown');
  expect(report.unreadable).toEqual(['RQ-BIG', 'RQ-DIR', 'RQ-LINK']);
  expect(report.branches.map(b => b.job)).toEqual(['RQ-RESULT']);
});

it('prints JSON through phm jobs stranded and prints job and branch as text', async () => {
  const dir = await runsDir(all), log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdJobs(['stranded', '--runs-dir', dir, '--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0]).branches).toHaveLength(3);
  expect(await cmdJobsStranded(['--runs-dir', dir, '--since', '24h'])).toBe(0);
  const text = String(log.mock.calls[1]![0]);
  expect(text).toContain(`RQ-BARE\texample/phantom\tcodex-bridge/RQ-BARE\t`);
  expect(text).toContain(`\tunknown\t${nextStep('codex-bridge/RQ-BARE')}`);
  expect(await cmdJobsStranded(['--since', 'soon'])).toBe(2);
  expect(log).toHaveBeenLastCalledWith('already recovered: RQ-FIXED');
  expect(await cmdJobsStranded(['--runs-dir', await runsDir({ 'RQ-DONE': 'published' })])).toBe(0);
  expect(log).toHaveBeenLastCalledWith('No stranded branches.');
});

it('exits 1 with unknown for unreadable input, 2 for bad arguments, 0 for help', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {}), err = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdJobsStranded(['--runs-dir', join(tmpdir(), 'no-such-stranded-dir'), '--json'])).toBe(1);
  expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ status: 'unknown', branches: null });
  expect(await cmdJobsStranded(['--bad'])).toBe(2);
  expect(err).toHaveBeenCalled();
  expect(await cmdJobsStranded(['--help'])).toBe(0);
});
