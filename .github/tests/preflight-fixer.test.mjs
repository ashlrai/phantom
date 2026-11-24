import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FULL_CRON } from '../scripts/ci-master-full.mjs';
import {
  CLOUD_CAP, SUMMARY_TITLE, affectedFromPaths, buildPreflightReport, chooseRunList,
  coveredByExistingRun, fixupLine, interpretRun, isRunnableTest, loadHistory, mergeRuns, planSummary,
  planTestIssues, preflightLineId, redsFromVitestReport, releaseOwed, repoTestPath, testPathsInText,
} from '../scripts/preflight-fixer.mjs';

const sha = 'a'.repeat(40);
const runUrl = 'https://github.com/ashlrai/phantom/actions/runs/42';
const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(join(here, '../workflows/preflight-fixer.yml'), 'utf8');

function leadsBefore(preflightCron, fullCron) {
  assert.equal(fullCron, '17 */6 * * *');
  const [minute, hours] = preflightCron.split(' ');
  const pres = hours.split(',').map((hour) => Number(hour) * 60 + Number(minute));
  return [0, 6, 12, 18].map((hour) => {
    const full = hour * 60 + 17;
    const leads = pres.map((pre) => (full - pre + 24 * 60) % (24 * 60)).filter((lead) => lead > 0);
    return Math.min(...leads);
  });
}

test('preflight starts 40 minutes before each scheduled full run', () => {
  const cron = workflow.match(/cron: "([^"]+)"/)?.[1];
  assert.equal(cron, '37 5,11,17,23 * * *');
  const leads = leadsBefore(cron, FULL_CRON);
  assert.deepEqual(leads, [40, 40, 40, 40]);
  assert.ok(leads.every((lead) => lead >= 30 && lead <= 45));
});

function assertRunBlocksClean(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const run = /^(\s*)run:\s*(.*)$/.exec(lines[i] ?? '');
    if (!run) continue;
    assert.doesNotMatch(run[2] ?? '', /\$\{\{/);
    if (run[2] !== '|' && run[2] !== '|-') continue;
    const indent = run[1]?.length ?? 0;
    for (let j = i + 1; j < lines.length; j += 1) {
      if ((lines[j] ?? '').trim() === '') continue;
      const leading = lines[j]?.match(/^ */)?.[0].length ?? 0;
      if (leading <= indent) break;
      assert.doesNotMatch(lines[j] ?? '', /\$\{\{/);
    }
  }
}

test('preflight workflow rejects workflow_run', () => {
  assert.doesNotMatch(workflow, /workflow_run/);
  assert.match(workflow, /^ {2}schedule:/m);
  assert.match(workflow, /^ {2}workflow_dispatch:/m);
  assert.match(workflow, /fetch-depth: 40/);
  assert.doesNotMatch(workflow, /fetch-depth: 0/);
  const autoTag = readFileSync(join(here, '../workflows/auto-tag.yml'), 'utf8');
  const start = autoTag.slice(autoTag.indexOf('Start preflight fixer on master'));
  assert.match(start, /preflight-fixer\.yml\/dispatches/);
  assert.match(start, /\{"ref":"master"\}/);
  assert.doesNotMatch(start.split('\n').slice(0, 12).join('\n'), /\$\{\{/);
});

test('workflow stays least privilege and does not interpolate the event into run', () => {
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.doesNotMatch(workflow, /secrets\.|persist-credentials:\s*true|release-train|release-desktop/);
  assertRunBlocksClean(workflow);
  assert.doesNotMatch(workflow, /\$\{\{\s*github\.event[.\s]/);
});

test('line ids are stable, router-shaped, and bounded', () => {
  const id = preflightLineId('test/m30.ci.test.ts');
  assert.equal(id, 'RQ-PREFLIGHT-test-m30.ci.test.ts');
  assert.equal(preflightLineId('test/m30.ci.test.ts'), id);
  assert.equal(preflightLineId('.github/tests/ci-release-metrics.test.mjs'), 'RQ-PREFLIGHT-github-tests-ci-release-metrics.test.mjs');
  const long = `test/${'a'.repeat(180)}.test.ts`;
  assert.ok(isRunnableTest(long));
  const hashed = preflightLineId(long);
  assert.ok(hashed.length <= 120);
  assert.match(hashed, /^RQ-PREFLIGHT-[A-Za-z0-9]/);
  assert.notEqual(hashed, preflightLineId(`test/${'b'.repeat(180)}.test.ts`));
  const line = fixupLine({ id, testPath: 'test/m30.ci.test.ts', sha, runUrl });
  assert.match(line, /^- READY RQ-PREFLIGHT-test-m30\.ci\.test\.ts \(P0, pool=any, tier=work, repo=phantom,.*\): preflight found this test red on master; fix it before the next scheduled full suite\.$/);
  const grammar = /^[ \t]{0,16}(?:-[ \t]{0,16})?(?:([A-Z][A-Z0-9-]{0,31})[ \t]+)?(RQ-[A-Za-z0-9][A-Za-z0-9:._-]{0,181})[ \t]*\(([^()\n]{0,2000})\)[ \t]*:[ \t]*(.{1,31000})$/;
  assert.match(line, grammar);
});

test('known reds run before affected tests and the cloud cap holds', () => {
  const known = ['test/known.test.ts'];
  const candidates = Array.from({ length: CLOUD_CAP + 5 }, (_, i) => `test/n${i}.test.ts`);
  const choice = chooseRunList({ knownReds: [...known, 'not a test', known[0]], candidates });
  assert.equal(choice.union[0], known[0]);
  assert.equal(choice.ran.length, CLOUD_CAP);
  assert.equal(choice.not_run.length, choice.union.length - CLOUD_CAP);
  assert.ok(choice.ran.includes(known[0]));
  assert.deepEqual(testPathsInText('failed test/known.test.ts and .github/tests/ci-fast-select.test.mjs'), [
    'test/known.test.ts', '.github/tests/ci-fast-select.test.mjs',
  ]);
});

test('auto-tag repeats for the same SHA do not stack preflights', () => {
  const now = Date.parse('2026-11-16T18:00:00.000Z');
  const head = 'b'.repeat(40);
  const runs = [
    { id: 9, head_sha: head, status: 'completed', updated_at: '2026-11-16T17:00:00.000Z' },
    { id: 8, head_sha: 'c'.repeat(40), status: 'in_progress', updated_at: '2026-11-16T17:50:00.000Z' },
  ];
  assert.equal(coveredByExistingRun({ runs, selfId: 10, headSha: head, now }), true);
  assert.equal(coveredByExistingRun({ runs, selfId: 9, headSha: head, now }), false);
  assert.equal(coveredByExistingRun({ runs: [{ id: 1, head_sha: head, status: 'completed', updated_at: '2026-11-16T10:00:00.000Z' }], selfId: 2, headSha: head, now }), false);
});

test('a release is owed until both the tag and the published release exist', () => {
  assert.equal(releaseOwed({ version: '1.2.3', tagExists: false, releasePublished: false }), true);
  assert.equal(releaseOwed({ version: '1.2.3', tagExists: true, releasePublished: false }), true);
  assert.equal(releaseOwed({ version: '1.2.3', tagExists: true, releasePublished: true }), false);
  assert.throws(() => releaseOwed({ version: '1.2', tagExists: true, releasePublished: true }));
});

test('vitest failures become repo paths and a green exit contributes none', () => {
  assert.equal(repoTestPath('/work/phantom/test/m30.ci.test.ts'), 'test/m30.ci.test.ts');
  const reds = redsFromVitestReport({ testResults: [
    { name: '/work/phantom/test/m30.ci.test.ts', status: 'failed' },
    { name: '/work/phantom/test/ok.test.ts', status: 'passed' },
  ] });
  assert.deepEqual(reds, ['test/m30.ci.test.ts']);
  assert.deepEqual(interpretRun({ exitCode: 0, log: 'FAIL test/m30.ci.test.ts', vitestReport: null }).reds, []);
  const missed = interpretRun({ exitCode: 1, log: 'boom', vitestReport: null });
  assert.equal(missed.unparsedFailure, true);
  assert.equal(mergeRuns([missed, interpretRun({ exitCode: 0, log: '', vitestReport: null })]).unparsedFailure, true);
});

test('one summary issue and one issue per red test, closed when a rerun passes', () => {
  const report = buildPreflightReport({
    cause: 'schedule', headSha: sha, generatedAt: '2026-11-16T18:00:00.000Z', runId: 42, runUrl,
    lastGreen: { sha, run_id: 7, run_attempt: 1 },
    latest: { sha, run_id: 8, status: 'completed', conclusion: 'failure', qualified: false, red_jobs: [] },
    changedCount: 2, selection: { mode: 'related', reason: 'changed sources' },
    affected: ['test/new.test.ts'], knownReds: ['test/old.test.ts'],
    choice: { union: ['test/old.test.ts', 'test/new.test.ts'], ran: ['test/old.test.ts', 'test/new.test.ts'], not_run: [] },
    reds: ['test/old.test.ts'], unparsedFailure: false,
  });
  assert.equal(report.schema, 'phantom-preflight-reds/v1');
  assert.equal(planSummary(report, []).action, 'create');
  assert.equal(planSummary(report, [{ number: 9, title: SUMMARY_TITLE }]).action, 'comment');
  const open = [
    { number: 3, title: '[P0 fix-forward] RQ-PREFLIGHT-test-old.test.ts' },
    { number: 4, title: '[P0 fix-forward] RQ-PREFLIGHT-test-new.test.ts' },
  ];
  const plans = planTestIssues({
    reds: ['test/old.test.ts', 'test/fresh.test.ts'], ran: ['test/old.test.ts', 'test/new.test.ts', 'test/fresh.test.ts'],
    unparsedFailure: false, headSha: sha, runUrl, openIssues: open,
  });
  assert.equal(plans.find((plan) => plan.title.endsWith('old.test.ts'))?.action, 'comment');
  assert.equal(plans.find((plan) => plan.title.endsWith('fresh.test.ts'))?.action, 'create');
  assert.equal(plans.find((plan) => plan.title.endsWith('new.test.ts'))?.action, 'close');
  const held = planTestIssues({
    reds: [], ran: ['test/old.test.ts'], unparsedFailure: true, headSha: sha, runUrl, openIssues: open,
  });
  assert.equal(held.length, 0);
});

test('docs-only diffs select no tests', () => {
  const selected = affectedFromPaths({ cwd: process.cwd(), paths: ['docs/RELEASING.md'] });
  assert.equal(selected.mode, 'docs');
  assert.deepEqual(selected.tests, []);
});

test('preflight writes issues and labels only', () => {
  const source = readFileSync(join(here, '../scripts/preflight-fixer.mjs'), 'utf8');
  const writes = [...source.matchAll(/--method', '([A-Z]+)', `([^`]+)`/g)];
  assert.ok(writes.length >= 3);
  for (const write of writes) assert.match(write[2] ?? '', /\/(?:issues|labels)/);
  assert.doesNotMatch(source, /git tag|tag-github-release/);
});

test('plan degrades to fallback selection when CI history is unavailable', async () => {
  const failing = async () => { throw new Error('CI metadata unavailable; refusing unverified full evidence'); };
  assert.deepEqual(await loadHistory('ashlrai/phantom', failing), { latest: null, green: null, evidence: [], capped: true });
});
