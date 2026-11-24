import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildReport, collect, isGreenFull, isScheduledFull, median,
} from '../scripts/ci-release-metrics.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(join(here, '../workflows/release-flow-metrics.yml'), 'utf8');
const now = '2026-11-16T18:00:00.000Z';

function attempt(id, created_at, green) {
  return { id, head_sha: 'b'.repeat(40), conclusion: green ? 'success' : 'failure', created_at, green };
}

test('weekly metrics cron is not the full-suite cron', () => {
  assert.match(workflow, /cron: "17 9 \* \* 1"/);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.doesNotMatch(workflow, /secrets\.|persist-credentials:\s*true|issues: write/);
  assert.doesNotMatch(workflow, /\$\{\{\s*github\.event[.\s]/);
  const lines = workflow.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const run = /^(\s*)run:\s*(.*)$/.exec(lines[i] ?? '');
    if (!run) continue;
    assert.doesNotMatch(run[2] ?? '', /\$\{\{/);
  }
});

test('pass rate counts scheduled full attempts and skips release prep', () => {
  const fullJobs = [
    { name: 'CI (Node 22, ubuntu, authority 1/3)', conclusion: 'failure' },
    { name: 'Desktop release smoke', conclusion: 'skipped' },
  ];
  const prepJobs = [
    { name: 'CI (Node 22, ubuntu, authority 1/3)', conclusion: 'skipped' },
    { name: 'Desktop release smoke', conclusion: 'success' },
  ];
  const run = { event: 'schedule', status: 'completed', head_branch: 'master', path: '.github/workflows/ci.yml', conclusion: 'failure' };
  assert.equal(isScheduledFull(run, fullJobs), true);
  assert.equal(isScheduledFull(run, prepJobs), false);
  assert.equal(isScheduledFull({ ...run, event: 'workflow_dispatch' }, fullJobs), false);
  assert.equal(isGreenFull({ conclusion: 'success' }, [{ conclusion: 'success' }, { conclusion: 'skipped' }]), true);
  assert.equal(isGreenFull({ conclusion: 'success' }, [{ conclusion: 'failure' }]), false);
  const report = buildReport({
    generatedAt: now, windowDays: 7, role: 'baseline',
    attempts: [
      attempt(1, '2026-11-10T00:17:00.000Z', true),
      attempt(2, '2026-11-12T06:17:00.000Z', false),
      attempt(3, '2026-11-01T00:17:00.000Z', true),
    ],
    releaseRows: [],
  });
  assert.equal(report.role, 'baseline');
  assert.deepEqual([report.full_runs.total, report.full_runs.green, report.full_runs.red, report.full_runs.pass_rate], [2, 1, 1, 0.5]);
  assert.equal(report.merge_to_release.samples, 0);
  assert.equal(report.merge_to_release.median_seconds, null);
});

test('merge-to-publish uses committer time and drops drafts and negative spans', () => {
  const report = buildReport({
    generatedAt: now, windowDays: 7,
    attempts: [],
    releaseRows: [
      { tag: 'v1.2.3', draft: false, published_at: '2026-11-14T12:00:00.000Z', merge_at: '2026-11-14T11:00:00.000Z' },
      { tag: 'v1.2.4', draft: false, published_at: '2026-11-15T12:00:00.000Z', merge_at: '2026-11-15T10:00:00.000Z' },
      { tag: 'v1.2.4', draft: false, published_at: '2026-11-15T12:00:00.000Z', merge_at: '2026-11-15T10:00:00.000Z' },
      { tag: 'v9.9.9', draft: true, published_at: '2026-11-15T12:00:00.000Z', merge_at: '2026-11-15T11:00:00.000Z' },
      { tag: 'v1.0.0', draft: false, published_at: '2026-11-01T00:00:00.000Z', merge_at: '2026-10-31T00:00:00.000Z' },
      { tag: 'v1.2.5', draft: false, published_at: '2026-11-15T10:00:00.000Z', merge_at: '2026-11-15T11:00:00.000Z' },
    ],
  });
  assert.deepEqual(report.merge_to_release.releases.map((row) => row.tag), ['v1.2.3', 'v1.2.4']);
  assert.equal(report.merge_to_release.median_seconds, median([3600, 7200]));
  assert.equal(report.merge_to_release.min_seconds, 3600);
  assert.equal(report.merge_to_release.max_seconds, 7200);
  assert.equal(median([]), null);
  assert.equal(median([10, 30]), 20);
  assert.equal(median([10, 20, 40]), 20);
});

test('collect reads full attempts and published releases through the injected API', async () => {
  const calls = [];
  const api = (path) => {
    calls.push(path);
    if (path.includes('/workflows/ci.yml/runs')) {
      return { workflow_runs: [
        { id: 5, run_attempt: 1, event: 'schedule', status: 'completed', head_branch: 'master', path: '.github/workflows/ci.yml', head_repository: { id: 1263526319 }, head_sha: 'c'.repeat(40), conclusion: 'success', created_at: '2026-11-16T06:17:00.000Z' },
        { id: 4, run_attempt: 1, event: 'schedule', status: 'completed', head_branch: 'master', path: '.github/workflows/ci.yml', head_repository: { id: 1263526319 }, head_sha: 'd'.repeat(40), conclusion: 'success', created_at: '2026-11-16T06:00:00.000Z' },
      ] };
    }
    if (path.includes('/runs/5/')) {
      return { total_count: 2, jobs: [
        { name: 'CI (Node 22, ubuntu, authority 1/3)', conclusion: 'success' },
        { name: 'Desktop release smoke', conclusion: 'skipped' },
      ] };
    }
    if (path.includes('/runs/4/')) {
      return { total_count: 1, jobs: [{ name: 'Desktop release smoke', conclusion: 'success' }] };
    }
    if (path.endsWith('/releases?per_page=100')) {
      return [
        { tag_name: 'v1.2.3', draft: false, published_at: '2026-11-15T12:00:00.000Z' },
        { tag_name: 'v9.9.9', draft: true, published_at: null },
      ];
    }
    if (path.endsWith('/commits/v1.2.3')) return { commit: { committer: { date: '2026-11-15T11:00:00.000Z' } } };
    throw new Error(`unexpected ${path}`);
  };
  const report = await collect({ now: new Date(now), days: 7, api, role: 'baseline' });
  assert.equal(report.full_runs.total, 1);
  assert.equal(report.full_runs.pass_rate, 1);
  assert.equal(report.merge_to_release.releases[0].tag, 'v1.2.3');
  assert.equal(report.merge_to_release.median_seconds, 3600);
  assert.ok(calls.some((path) => path.includes('/runs/5/')));
  assert.ok(!calls.some((path) => path.includes('/commits/v9.9.9')));
});

test('metrics script does not write tags or releases', () => {
  const source = readFileSync(join(here, '../scripts/ci-release-metrics.mjs'), 'utf8');
  assert.doesNotMatch(source, /--method/);
});
