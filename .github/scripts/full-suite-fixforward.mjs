// RELEASE-GATE-SPLIT-1: full-suite result -> P0 fix-forward issue. Pure
// planning functions are exported for tests; main() does the API calls.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { requireProducerEnvironment } from './github-repository-binding.mjs';

export const LABEL = 'p0-fix-forward';
export const TITLE_PREFIX = '[P0 fix-forward] full suite red on';
const MATRIX = 'CI (Node 22,';
const MAC = 'Mac exhaustive (';
const REPOSITORY_ID = 1263526319;

// A full attempt ran the platform matrix. Half-hour release prep and
// release-gate dispatches never do, and are ignored.
export function classifyRun(run, jobs) {
  assert.ok(run && Array.isArray(jobs), 'missing run or job inventory');
  assert.ok(run.head_branch === 'master' && run.path === '.github/workflows/ci.yml' &&
    run.head_repository?.id === REPOSITORY_ID && /^[0-9a-f]{40}$/.test(run.head_sha ?? ''), 'CI run identity differs');
  const full = jobs.some(job => (job.name?.startsWith(MATRIX) || job.name?.startsWith(MAC)) && job.conclusion !== 'skipped');
  if (!full || run.status !== 'completed') return { kind: 'ignore' };
  const failed = jobs.filter(job => job.conclusion === 'failure' || job.conclusion === 'cancelled' || job.conclusion === 'timed_out')
    .map(job => ({ name: job.name, conclusion: job.conclusion }));
  if (run.conclusion === 'success' && failed.length === 0) return { kind: 'green' };
  return { kind: 'red', failed };
}

export function fixupLines(run, failed) {
  const sha7 = run.head_sha.slice(0, 7);
  const url = `https://github.com/ashlrai/phantom/actions/runs/${run.id}`;
  return failed.map((job, i) => `- READY RQ-FIXUP-PHANTOM-${sha7}-${i + 1} (P0, pool=any, tier=work, repo=phantom, lead=CI-Efficiency, owner=ci-efficiency, job=${job.name}, result=${job.conclusion}, run=${url}, sha=${sha7}): full suite job concluded ${job.conclusion}; fix forward, does not block release (RELEASE-GATE-SPLIT-1).`);
}

// One open issue per failing SHA: same SHA -> comment, new SHA -> new issue.
export function planRed(run, failed, openIssues) {
  const sha7 = run.head_sha.slice(0, 7);
  const title = `${TITLE_PREFIX} ${sha7}`;
  const body = [`Full suite run ${run.id} attempt ${run.run_attempt} on master ${run.head_sha} is red.`,
    'This does not block Auto-tag in split mode. Fix forward:', '', ...fixupLines(run, failed)].join('\n');
  const same = openIssues.find(issue => issue.title === title);
  return same ? { action: 'comment', number: same.number, body } : { action: 'create', title, body };
}

export function planGreen(run, openIssues) {
  return openIssues.filter(issue => issue.title?.startsWith(TITLE_PREFIX)).map(issue => ({
    action: 'close', number: issue.number,
    body: `Full suite run ${run.id} on master ${run.head_sha} is green; closing.`,
  }));
}

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}
function scrub(text) {
  return execFileSync('perl', ['.github/tests/secret-shape/scrub.pl'], { encoding: 'utf8', input: text });
}

async function main() {
  requireProducerEnvironment(process.env);
  const repo = process.env.GITHUB_REPOSITORY;
  const id = process.env.CI_RUN_ID; const attempt = process.env.CI_RUN_ATTEMPT;
  assert.match(id ?? '', /^[1-9][0-9]*$/); assert.match(attempt ?? '', /^[1-9][0-9]*$/);
  const run = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${id}`]));
  const jobs = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`]))
    .flatMap(page => page.jobs ?? []);
  const verdict = classifyRun(run, jobs);
  if (verdict.kind === 'ignore') { console.log('not a full attempt; nothing to file'); return; }
  const open = JSON.parse(gh(['api', `repos/${repo}/issues?state=open&labels=${LABEL}&per_page=100`]))
    .filter(issue => !issue.pull_request);
  const plans = verdict.kind === 'red' ? [planRed(run, verdict.failed, open)] : planGreen(run, open);
  for (const plan of plans) {
    const body = scrub(plan.body);
    if (plan.action === 'create') {
      gh(['api', '--method', 'POST', `repos/${repo}/issues`, '--input', '-'], JSON.stringify({ title: plan.title, body, labels: [LABEL] }));
    } else {
      gh(['api', '--method', 'POST', `repos/${repo}/issues/${plan.number}/comments`, '--input', '-'], JSON.stringify({ body }));
      if (plan.action === 'close') gh(['api', '--method', 'PATCH', `repos/${repo}/issues/${plan.number}`, '--input', '-'], JSON.stringify({ state: 'closed', state_reason: 'completed' }));
    }
    console.log(`${plan.action} ${plan.number ?? plan.title}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
