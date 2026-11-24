// Scheduled full-run pass rate and merge-to-publish time.
// Read-only: workflow runs, jobs, releases and commits. It does not create,
// move, or edit tags, drafts, or releases.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { requireProducerEnvironment } from './github-repository-binding.mjs';

export const SCHEMA = 'phantom-release-flow-metrics/v1';
export const DEFAULT_WINDOW_DAYS = 7;
export const OUT_PATH = '.github/metrics/release-flow.json';
const REPO = 'ashlrai/phantom';
const DAY_MS = 24 * 60 * 60 * 1000;

export function isScheduledFull(run, jobs) {
  if (run?.event !== 'schedule' || run.status !== 'completed' || run.head_branch !== 'master') return false;
  if (run.path !== '.github/workflows/ci.yml') return false;
  const matrixRan = jobs.some((job) => typeof job.name === 'string' && job.name.startsWith('CI (Node 22,') && job.conclusion !== 'skipped');
  const smokeRan = jobs.some((job) => job.name === 'Desktop release smoke' && job.conclusion !== 'skipped');
  return matrixRan && !smokeRan;
}

export function isGreenFull(run, jobs) {
  return run.conclusion === 'success' && jobs.every((job) => job.conclusion === 'success' || job.conclusion === 'skipped');
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function inWindow(iso, startMs, endMs) {
  const time = Date.parse(iso ?? '');
  return Number.isFinite(time) && time >= startMs && time <= endMs;
}

export function buildReport({ generatedAt, windowDays, attempts, releaseRows, role = 'scheduled' }) {
  assert.ok(role === 'scheduled' || role === 'baseline', 'unknown metrics role');
  assert.ok(Number.isInteger(windowDays) && windowDays > 0 && windowDays <= 30, 'window out of range');
  const end = Date.parse(generatedAt);
  assert.ok(Number.isFinite(end), 'generatedAt is not a time');
  const start = end - windowDays * DAY_MS;
  const full = attempts
    .filter((row) => inWindow(row.created_at, start, end))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const green = full.filter((row) => row.green).length;
  const releases = [];
  const seen = new Set();
  for (const row of releaseRows) {
    if (row.draft || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(row.tag ?? '')) continue;
    if (!inWindow(row.published_at, start, end) || seen.has(row.tag)) continue;
    const merge = Date.parse(row.merge_at ?? '');
    const published = Date.parse(row.published_at);
    if (!Number.isFinite(merge) || published < merge) continue;
    seen.add(row.tag);
    releases.push({
      tag: row.tag,
      merge_at: new Date(merge).toISOString(),
      published_at: new Date(published).toISOString(),
      seconds: Math.round((published - merge) / 1000),
    });
  }
  releases.sort((a, b) => a.seconds - b.seconds || (a.tag < b.tag ? -1 : 1));
  const seconds = releases.map((row) => row.seconds);
  const passRate = full.length ? Math.round((green / full.length) * 10000) / 10000 : null;
  return {
    schema: SCHEMA,
    role,
    generated_at: new Date(end).toISOString(),
    window_days: windowDays,
    window_start: new Date(start).toISOString(),
    window_end: new Date(end).toISOString(),
    full_runs: {
      total: full.length,
      green,
      red: full.length - green,
      pass_rate: passRate,
      runs: full.map((row) => ({
        id: row.id, head_sha: row.head_sha, conclusion: row.conclusion, created_at: row.created_at, green: row.green === true,
      })),
    },
    merge_to_release: {
      samples: releases.length,
      median_seconds: median(seconds),
      min_seconds: seconds[0] ?? null,
      max_seconds: seconds.at(-1) ?? null,
      releases,
    },
  };
}

function gh(path) {
  assert.ok(path.startsWith(`repos/${REPO}/`) && !path.includes('..') && !/[\s`]/.test(path), 'unreviewed API path');
  return JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', path], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function windowDays() {
  const raw = process.env.METRICS_WINDOW_DAYS ?? String(DEFAULT_WINDOW_DAYS);
  assert.match(raw, /^[1-9][0-9]*$/);
  const days = Number(raw);
  assert.ok(days <= 30, 'window out of range');
  return days;
}

export async function collect({ now = new Date(), days = DEFAULT_WINDOW_DAYS, api = gh, role = 'scheduled' } = {}) {
  const end = now.getTime();
  const start = end - days * DAY_MS;
  const attempts = [];
  for (let page = 1; page <= 10; page += 1) {
    const data = api(`repos/${REPO}/actions/workflows/ci.yml/runs?event=schedule&branch=master&status=completed&per_page=100&page=${page}`);
    const batch = data.workflow_runs ?? [];
    assert.ok(Array.isArray(batch), 'missing scheduled run list');
    for (const run of batch) {
      if (run.path !== '.github/workflows/ci.yml' || run.head_repository?.id !== 1263526319) continue;
      if (Date.parse(run.created_at) < start) continue;
      const jobs = [];
      for (let jobPage = 1; jobPage <= 5; jobPage += 1) {
        const body = api(`repos/${REPO}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${jobPage}`);
        const rows = body.jobs ?? [];
        jobs.push(...rows);
        if (jobs.length >= body.total_count || rows.length < 100) break;
      }
      if (!isScheduledFull(run, jobs)) continue;
      attempts.push({
        id: run.id, head_sha: run.head_sha, conclusion: run.conclusion, created_at: run.created_at,
        green: isGreenFull(run, jobs),
      });
    }
    if (!batch.length || batch.length < 100 || Date.parse(batch.at(-1).created_at) < start) break;
  }
  const listed = api(`repos/${REPO}/releases?per_page=100`);
  assert.ok(Array.isArray(listed), 'missing release list');
  const releaseRows = [];
  for (const release of listed) {
    if (release.draft || typeof release.published_at !== 'string' || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(release.tag_name ?? '')) continue;
    if (!inWindow(release.published_at, start, end)) continue;
    const commit = api(`repos/${REPO}/commits/${release.tag_name}`);
    releaseRows.push({
      tag: release.tag_name,
      draft: false,
      published_at: release.published_at,
      merge_at: commit?.commit?.committer?.date ?? null,
    });
  }
  return buildReport({ generatedAt: now.toISOString(), windowDays: days, attempts, releaseRows, role });
}

function assertOut(path) {
  assert.equal(path, OUT_PATH, 'metrics are written only to .github/metrics/release-flow.json');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireProducerEnvironment(process.env);
    const write = process.argv[2] === '--write';
    if (process.argv[2] && !write) throw new Error('Usage: ci-release-metrics.mjs [--write .github/metrics/release-flow.json]');
    if (write) assertOut(process.argv[3]);
    const role = process.env.METRICS_ROLE ?? 'scheduled';
    const report = await collect({ days: windowDays(), role });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (write) {
      mkdirSync(dirname(process.argv[3]), { recursive: true });
      writeFileSync(process.argv[3], json);
    } else process.stdout.write(json);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
