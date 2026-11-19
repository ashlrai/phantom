import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdJobs } from '../src/cli/jobs-empty.js';
import { cmdJobsStranded } from '../src/cli/jobs-stranded.js';
import { readStrandedBranches, recoverCommand } from '../src/core/fleet/stranded-branches.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function runsDir(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'stranded-jobs-')); dirs.push(dir);
  for (const [job, fixture] of Object.entries(files)) await copyFile(`test/fixtures/stranded/${fixture}.publish`, join(dir, `${job}.publish`));
  return dir;
}
const all = { 'RQ-RESULT': 'result-abort', 'RQ-BARE': 'bare-abort', 'RQ-OTHER': 'other-abort', 'RQ-UNPUSHED': 'unpushed', 'RQ-DONE': 'published', 'RQ-FIXED': 'recovered' };

it('reports both default-fetch log shapes and ignores other aborts, unpushed and published logs', async () => {
  expect(await readStrandedBranches(await runsDir(all))).toEqual({
    schema: 'jobs.stranded.v1', readOnly: true, status: 'ok', unreadable: [],
    branches: [
      { job: 'RQ-BARE', branch: 'codex-bridge/RQ-BARE', shape: 'bare-abort', recover: recoverCommand('codex-bridge/RQ-BARE') },
      { job: 'RQ-RESULT', branch: 'codex-bridge/RQ-RESULT', shape: 'result-abort', recover: recoverCommand('codex-bridge/RQ-RESULT') },
    ],
    recovered: [{ job: 'RQ-FIXED', branch: 'codex-bridge/RQ-FIXED', pr: 'https://github.com/example/phantom/pull/2' }],
  });
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
  expect(JSON.parse(log.mock.calls[0]![0]).branches).toHaveLength(2);
  expect(await cmdJobsStranded(['--runs-dir', dir])).toBe(0);
  expect(log).toHaveBeenNthCalledWith(2, `RQ-BARE\tcodex-bridge/RQ-BARE\t${recoverCommand('codex-bridge/RQ-BARE')}\nRQ-RESULT\tcodex-bridge/RQ-RESULT\t${recoverCommand('codex-bridge/RQ-RESULT')}`);
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
