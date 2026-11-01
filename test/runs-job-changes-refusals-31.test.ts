import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { getFleetJobChanges } from '../src/core/fleet/runs-job-changes.js';
import type { GitRunner } from '../src/core/verse/git-ops.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function setup() {
  const homeDir = await mkdtemp(join(tmpdir(), 'job-changes-refusals-'));
  roots.push(homeDir);
  const runsDir = join(homeDir, 'runs');
  const worktree = join(homeDir, 'worktree');
  await mkdir(runsDir);
  await mkdir(worktree);
  await writeFile(join(runsDir, 'RQ-TEST.base'), `a60908e branch ${worktree}\n`);
  return { homeDir, runsDir };
}

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false });
const modified = (path: string) => `1 M. N... 100644 100644 100644 abc abc ${path}\0`;

it('flags singleton and lockfile edits and keeps the rest of the payload byte-identical', async () => {
  const { homeDir, runsDir } = await setup();
  const paths = ['CHANGELOG.md', 'README.md', 'package-lock.json', 'src/ok.ts'];
  const numstat = paths.map((path, index) => `${index + 1}\t${index}\t${path}\0`).join('');
  const runner = vi.fn<GitRunner>(async (_bin, args) => ok(args[0] === 'diff' ? numstat : paths.map(modified).join('')));
  const result = await getFleetJobChanges('RQ-TEST', { homeDir, runsDir, runner });

  expect(result.refusals).toEqual([
    { path: 'CHANGELOG.md', rule: 'changelog-singleton' },
    { path: 'README.md', rule: 'readme-singleton' },
    { path: 'package-lock.json', rule: 'lockfile' },
  ]);
  expect(result.refusals.map(refusal => refusal.path)).not.toContain('src/ok.ts');

  // Apart from the added field the response is byte-identical to the
  // pre-refusals payload.
  const { refusals: _refusals, ...before } = result;
  const expected = {
    schema: 'fleet.job.changes.v1', generatedAt: result.generatedAt, job: 'RQ-TEST', state: 'live', baseSha: 'a60908e',
    files: paths.map((path, index) => ({ path, added: index + 1, removed: index, status: 'modified' })),
    totals: { files: 4, added: 10, removed: 6 }, truncated: false,
  };
  expect(JSON.stringify(before)).toBe(JSON.stringify(expected));
  expect(JSON.stringify(result)).not.toContain(homeDir);
});

it('yields an empty refusal list for an empty change set', async () => {
  const { homeDir, runsDir } = await setup();
  const runner: GitRunner = async () => ok();
  const result = await getFleetJobChanges('RQ-TEST', { homeDir, runsDir, runner });
  expect(result.state).toBe('live');
  expect(result.files).toEqual([]);
  expect(result.refusals).toEqual([]);
});

it('yields an empty refusal list and a missing state when nothing refused is touched', async () => {
  const { homeDir, runsDir } = await setup();
  const runner: GitRunner = async (_bin, args) => ok(args[0] === 'diff' ? '1\t0\tsrc/ok.ts\0' : modified('src/ok.ts'));
  const plain = await getFleetJobChanges('RQ-TEST', { homeDir, runsDir, runner });
  expect(plain.files.map(file => file.path)).toEqual(['src/ok.ts']);
  expect(plain.refusals).toEqual([]);

  const absentRunner = vi.fn<GitRunner>();
  await rm(join(runsDir, 'RQ-TEST.base'));
  const missing = await getFleetJobChanges('RQ-TEST', { homeDir, runsDir, runner: absentRunner });
  expect(missing.state).toBe('missing');
  expect(missing.refusals).toEqual([]);
  expect(absentRunner).not.toHaveBeenCalled();
});
