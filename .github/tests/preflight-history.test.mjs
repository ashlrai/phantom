import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { boundedHistory, classifyFullJobs, ensureCommitReachable } from '../scripts/preflight-history.mjs';

const sha = (n) => n.repeat(40);
const repoId = 1263526319;

function run(id, head, extra = {}) {
  return {
    id, run_attempt: 1, event: 'schedule', status: 'completed', conclusion: 'failure',
    head_sha: sha(head), head_branch: 'master', path: '.github/workflows/ci.yml',
    head_repository: { id: repoId }, workflow_id: 9, ...extra,
  };
}
function jobs(kind) {
  if (kind === 'prep') {
    return [
      { name: 'CI (Node 22, ubuntu, authority 1/3)', conclusion: 'skipped' },
      { name: 'Desktop release smoke', conclusion: 'success' },
    ];
  }
  const matrix = { name: 'CI (Node 22, ubuntu, authority 1/3)', conclusion: kind === 'green' ? 'success' : 'failure' };
  const qual = { name: 'Master full qualification', conclusion: kind === 'green' ? 'success' : 'failure' };
  const smoke = { name: 'Desktop release smoke', conclusion: 'skipped' };
  return [matrix, qual, smoke];
}

test('release prep is not a full attempt and a green qualification is', () => {
  assert.equal(classifyFullJobs(run(1, 'a'), jobs('prep')), 'ignore');
  assert.equal(classifyFullJobs(run(2, 'b'), jobs('red')), 'red');
  assert.equal(classifyFullJobs(run(3, 'c', { conclusion: 'success' }), jobs('green')), 'green');
});

test('history deepens one page at a time and stops at the first green', async () => {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.endsWith('/workflows/ci.yml')) return { id: 9, path: '.github/workflows/ci.yml' };
    if (path.endsWith('page=1')) return { workflow_runs: [run(3, 'c'), run(2, 'b')] };
    if (path.endsWith('page=2')) return { workflow_runs: [run(1, 'a', { conclusion: 'success' })] };
    if (path.includes('/runs/3/')) return { jobs: jobs('prep') };
    if (path.includes('/runs/2/')) return { jobs: jobs('red') };
    if (path.includes('/runs/1/')) return { jobs: jobs('green') };
    throw new Error(path);
  };
  const found = await boundedHistory({ repo: 'ashlrai/phantom', api, pageSize: 2, maxPages: 4, budgetMs: 5_000 });
  assert.equal(found.green.id, 1);
  assert.equal(found.latest.id, 2);
  assert.equal(found.capped, false);
  assert.ok(calls.some((path) => path.includes('page=2')));
  assert.ok(!calls.some((path) => path.includes('page=3')));
  assert.doesNotMatch(calls.join('\n'), /full history deadline exceeded/);
});

test('a spent budget stops without the full-history deadline error', async () => {
  let clock = 0;
  const now = () => { clock += 1; return clock; };
  await assert.rejects(
    boundedHistory({ repo: 'ashlrai/phantom', api: async () => ({ id: 9, path: '.github/workflows/ci.yml' }), budgetMs: 0, now }),
    (error) => error.code === 'HISTORY_BUDGET' && !/full history deadline exceeded/.test(error.message),
  );
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('a shallow clone deepens to the merge base and unshallows only after the cap', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'preflight-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin');
  const shallow = join(root, 'shallow');
  const tiny = join(root, 'tiny');
  git(root, ['init', '-q', '-b', 'master', origin]);
  git(origin, ['config', 'user.email', 'ci@example.invalid']);
  git(origin, ['config', 'user.name', 'ci']);
  git(origin, ['config', 'commit.gpgsign', 'false']);
  const shas = [];
  for (let i = 0; i < 12; i += 1) {
    git(origin, ['commit', '-q', '--allow-empty', '-m', `c${i}`]);
    shas.push(git(origin, ['rev-parse', 'HEAD']).trim());
  }
  git(root, ['clone', '-q', '--depth', '2', `file://${origin}`, shallow]);
  const reached = ensureCommitReachable({ git: (args) => git(shallow, args), sha: shas[0], deepen: 5, cap: 4 });
  assert.equal(reached.unshallow, false);
  assert.ok(reached.deepens >= 1);
  assert.equal(reached.mode, 'deepen');
  git(root, ['clone', '-q', '--depth', '1', `file://${origin}`, tiny]);
  const full = ensureCommitReachable({ git: (args) => git(tiny, args), sha: shas[0], deepen: 1, cap: 1 });
  assert.equal(full.mode, 'unshallow');
  assert.equal(full.unshallow, true);
});
