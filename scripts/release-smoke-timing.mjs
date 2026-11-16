#!/usr/bin/env node
/**
 * release-smoke-timing.mjs — measure the CI "Desktop release smoke" job.
 *
 *   node scripts/release-smoke-timing.mjs list [--limit 10] [--json]
 *   node scripts/release-smoke-timing.mjs append [--doc docs/release/SMOKE-TIMING.md] [--dry-run]
 *
 * `list` reads completed ci.yml runs (workflow_dispatch and schedule) through
 * `gh api` and prints the newest release smoke attempts: duration, result,
 * whether the job built or reused the immutable input, and the failing step.
 * Eligibility no-ops (nothing built, downloaded or smoked) are not smokes and
 * are skipped.
 *
 * `append` adds every newer attempt that the doc does not already name to its
 * tracked table, oldest first, and rewrites the tracked summary line. Output
 * depends only on the API rows: no generation timestamp, stable ordering.
 * Read-only against GitHub; it writes only the doc.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const JOB_NAME = 'Desktop release smoke';
export const TRACK_TARGET = 5;
const REPOSITORY = 'ashlrai/phantom';
const BUILD_STEP = 'Build unsigned desktop and original package once';
const REUSE_STEP = 'Download existing immutable build';
const SMOKE_STEP = 'Smoke desktop release artifact';
const START = '<!-- smoke-timing:tracked:start -->';
const END = '<!-- smoke-timing:tracked:end -->';
const DEFAULT_DOC = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'release', 'SMOKE-TIMING.md');

const ran = (job, name) => job.steps?.some((step) => step.name === name && step.conclusion && step.conclusion !== 'skipped');
const seconds = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 1000);

/** One release smoke attempt, or null for a skipped job or an eligibility no-op. */
export function smokeRow(run, job) {
  if (!job || job.name !== JOB_NAME || job.status !== 'completed' || job.conclusion === 'skipped') return null;
  const built = ran(job, BUILD_STEP); const reused = ran(job, REUSE_STEP) || ran(job, SMOKE_STEP);
  // A green job that built, downloaded and smoked nothing found no eligible push CI.
  if (!built && !reused && job.conclusion === 'success') return null;
  const path = built ? 'built' : reused ? 'reused' : 'none';
  const failed = job.steps?.find((step) => step.conclusion === 'failure');
  return {
    runId: run.id, attempt: run.run_attempt, event: run.event, ref: run.head_branch, sha: run.head_sha,
    startedAt: job.started_at, seconds: seconds(job.started_at, job.completed_at), result: job.conclusion, path,
    failedStep: failed ? `${failed.number}: ${failed.name}` : '',
  };
}

export function collectSmokeRuns({ read, repository = REPOSITORY, perEvent = 30 }) {
  const rows = [];
  for (const event of ['workflow_dispatch', 'schedule']) {
    const listing = read(`repos/${repository}/actions/workflows/ci.yml/runs?event=${event}&status=completed&per_page=${perEvent}`);
    assert.ok(Array.isArray(listing?.workflow_runs), 'invalid workflow run listing');
    for (const run of listing.workflow_runs) {
      const { jobs } = read(`repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
      assert.ok(Array.isArray(jobs), 'invalid job listing');
      const row = smokeRow(run, jobs.find((job) => job.name === JOB_NAME));
      if (row) rows.push(row);
    }
  }
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId - a.runId);
}

/** Linear-interpolated quantile (the method CI Efficiency's baseline uses). */
export function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q; const low = Math.floor(at);
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (at - low);
}

export function summarize(rows) {
  const durations = rows.map((row) => row.seconds);
  const passes = rows.filter((row) => row.result === 'success').length;
  const fixed = (value) => value === null ? 'n/a' : `${Number(value.toFixed(1))} s`;
  return { runs: rows.length, passes, median: fixed(quantile(durations, 0.5)), p95: fixed(quantile(durations, 0.95)) };
}

export function renderRow(row, repository = REPOSITORY) {
  return `| [${row.runId}](https://github.com/${repository}/actions/runs/${row.runId}/attempts/${row.attempt}) | ${row.startedAt} | ${row.event} | ${row.ref} | \`${row.sha.slice(0, 10)}\` | ${row.path} | ${row.seconds} | ${row.result} | ${row.failedStep} |`;
}

export const TABLE_HEAD = '| Run | Job started (UTC) | Event | Ref | Commit | Input | Seconds | Result | Failed step |\n|---|---|---|---|---|---|---:|---|---|';

export function trackedSummary(rows) {
  const s = summarize(rows);
  return `Tracked ${s.runs} of the next ${TRACK_TARGET} release smokes: pass ${s.passes}/${s.runs}, median ${s.median}, p95 ${s.p95}.`;
}

const ROW_ID = /actions\/runs\/(\d+)\/attempts\/(\d+)/;

/** Doc with every newer, unnamed attempt appended to the tracked table. */
export function appendTracked(doc, rows, repository = REPOSITORY) {
  const start = doc.indexOf(START); const end = doc.indexOf(END);
  assert.ok(start >= 0 && end > start, 'tracked markers missing');
  const named = new Set([...doc.matchAll(new RegExp(ROW_ID, 'g'))].map((match) => `${match[1]}/${match[2]}`));
  const newest = [...doc.slice(0, start).matchAll(/\| (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) \|/g)].map((m) => m[1]).sort().at(-1) ?? '';
  const block = doc.slice(start + START.length, end);
  const existing = block.split('\n').filter((line) => ROW_ID.test(line));
  const parsed = existing.map((line) => {
    const cells = line.split('|').map((cell) => cell.trim());
    return { seconds: Number(cells[7]), result: cells[8] };
  });
  const fresh = rows.filter((row) => row.startedAt > newest && !named.has(`${row.runId}/${row.attempt}`))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.runId - b.runId);
  const lines = [...existing, ...fresh.map((row) => renderRow(row, repository))];
  const all = [...parsed, ...fresh];
  const body = `\n${TABLE_HEAD}\n${lines.join('\n')}${lines.length ? '\n' : ''}\n${trackedSummary(all)}\n`;
  return { doc: `${doc.slice(0, start + START.length)}${body}${doc.slice(end)}`, added: fresh.length };
}

const ghRead = (endpoint) => JSON.parse(execFileSync('gh', ['api', endpoint],
  { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }));

function main(argv) {
  const [verb, ...rest] = argv;
  if (!verb || verb === '-h' || verb === '--help') {
    console.log('Usage: node scripts/release-smoke-timing.mjs list [--limit N] [--json] | append [--doc PATH] [--dry-run]');
    return 0;
  }
  assert.ok(verb === 'list' || verb === 'append', 'expected list or append');
  const flag = (name) => rest.includes(name);
  const value = (name, fallback) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : fallback; };
  const rows = collectSmokeRuns({ read: ghRead });
  if (verb === 'list') {
    const limit = Number(value('--limit', '10'));
    assert.ok(Number.isSafeInteger(limit) && limit > 0, '--limit must be a positive integer');
    const newest = rows.slice(0, limit);
    if (flag('--json')) console.log(JSON.stringify({ rows: newest, summary: summarize(newest) }, null, 2));
    else console.log([TABLE_HEAD, ...newest.map((row) => renderRow(row)), '', JSON.stringify(summarize(newest))].join('\n'));
    return 0;
  }
  const path = resolve(value('--doc', DEFAULT_DOC));
  const { doc, added } = appendTracked(readFileSync(path, 'utf8'), rows);
  if (!flag('--dry-run') && added) writeFileSync(path, doc);
  console.log(`${added} new release smoke run(s) ${flag('--dry-run') ? 'would be ' : ''}appended to ${path}`);
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (error) {
    console.error(`release smoke timing failed: ${error.message}`); process.exitCode = 1;
  }
}
