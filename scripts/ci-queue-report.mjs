#!/usr/bin/env node
// Offline only: capture GitHub evidence through Locus before invoking this report.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
function timestamp(value) {
  // GitHub emits UTC timestamps. Round-trip validation rejects normalized dates (Feb 30).
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === canonical ? parsed : null;
}

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

/** Every envelope is one complete, immutable run-attempt capture, not a latest/all mixture. */
export function buildQueueReport(captures) {
  requireEvidence(Array.isArray(captures) && captures.length > 0, 'Provide at least one capture.');
  const scopes = new Set();
  const groups = new Map();
  const jobs = [];
  for (const capture of captures) {
    requireEvidence(capture && typeof capture.repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(capture.repository)
      && positiveInteger(capture.runId) && positiveInteger(capture.runAttempt)
      && timestamp(capture.observedAt) !== null, 'Invalid capture identity or observedAt.');
    const scope = `${capture.repository.toLowerCase()}/${capture.runId}/${capture.runAttempt}`;
    requireEvidence(!scopes.has(scope), 'Duplicate run-attempt capture.');
    scopes.add(scope);
    requireEvidence(Array.isArray(capture.pages) && capture.pages.length > 0, 'Missing jobs pages.');
    const count = capture.pages[0]?.total_count;
    requireEvidence(Number.isSafeInteger(count) && count >= 0, 'Invalid jobs total_count.');
    const ids = new Set();
    const rows = [];
    for (const page of capture.pages) {
      requireEvidence(page?.total_count === count && Array.isArray(page.jobs), 'Inconsistent jobs pages.');
      for (const job of page.jobs) {
        requireEvidence(job && positiveInteger(job.id) && !ids.has(job.id), 'Missing or duplicate job ID.');
        requireEvidence(job.run_id === capture.runId && job.run_attempt === capture.runAttempt,
          'Job belongs to a different run or attempt.');
        ids.add(job.id);
        rows.push(job);
      }
    }
    requireEvidence(rows.length === count, 'Incomplete jobs pagination.');
    for (const job of rows) {
      const observed = timestamp(capture.observedAt);
      const created = timestamp(job.created_at);
      const started = timestamp(job.started_at);
      const completed = timestamp(job.completed_at);
      const executed = positiveInteger(job.runner_id) && Array.isArray(job.steps)
        && job.steps.some(step => step && step.conclusion !== 'skipped'
          && ['in_progress', 'completed'].includes(step.status)
          && timestamp(step.started_at) !== null && started !== null
          && timestamp(step.started_at) >= started && timestamp(step.started_at) <= observed
          && (job.status !== 'completed' || (completed !== null && timestamp(step.started_at) <= completed)));
      let state = 'unknown';
      let queueMs = null;
      let queuedAgeMs = null;
      let executionMs = null;
      if (job.status === 'completed' && job.conclusion === 'skipped') {
        state = 'skipped';
      } else if (job.status === 'completed' && job.conclusion === 'cancelled' && Array.isArray(job.steps) && job.steps.length === 0) {
        state = 'cancelledWithoutSteps';
      } else if (created !== null && created <= observed) {
        if (['queued', 'waiting', 'pending', 'requested'].includes(job.status) && !executed) {
          state = 'queued';
          queuedAgeMs = observed - created;
        } else if (executed && ['in_progress', 'completed'].includes(job.status)
          && started !== null && started >= created && started <= observed
          && (job.status !== 'completed' || (completed !== null && completed >= started && completed <= observed))) {
          state = 'started';
          queueMs = started - created;
          if (job.status === 'completed') executionMs = completed - started;
        }
      }
      const labels = Array.isArray(job.labels) && job.labels.length > 0
        && job.labels.every(label => typeof label === 'string' && label.trim().length > 0)
        ? [...new Set(job.labels)].sort() : [];
      // Emit only measurement fields, never arbitrary API descriptions, logs or payloads.
      const measurement = { repository: capture.repository, runId: capture.runId,
        runAttempt: capture.runAttempt, jobId: job.id, labels, state, queueMs, queuedAgeMs, executionMs };
      jobs.push(measurement);
      for (const label of labels.length ? labels : [null]) {
        if (!groups.has(label)) groups.set(label, { label, jobs: 0, started: 0, queued: 0,
          cancelledWithoutSteps: 0, skipped: 0, unknown: 0, delays: [], ages: [], execution: [] });
        const group = groups.get(label);
        group.jobs++;
        group[state]++;
        if (queueMs !== null) group.delays.push(queueMs);
        if (queuedAgeMs !== null) group.ages.push(queuedAgeMs);
        if (executionMs !== null) group.execution.push(executionMs);
      }
    }
  }
  return { schemaVersion: 1, captures: captures.map(({ repository, runId, runAttempt, observedAt }) =>
    ({ repository, runId, runAttempt, observedAt })), totalJobs: jobs.length,
  labels: [...groups.values()].sort((a, b) => (a.label ?? '').localeCompare(b.label ?? '')).map(group => {
    const { delays, ages, execution, ...counts } = group;
    return { ...counts, queueMs: distribution(delays), queuedAgeMs: distribution(ages),
      executionMs: distribution(execution) };
  }), jobs };
}

function distribution(values) {
  if (!values.length) return { samples: 0, p50: null, p95: null, max: null };
  const ordered = values.toSorted((a, b) => a - b);
  return { samples: values.length, p50: ordered[Math.ceil(values.length * 0.5) - 1],
    p95: ordered[Math.ceil(values.length * 0.95) - 1], max: ordered.at(-1) };
}

const cell = value => String(value).replace(/[&<>|\r\n`\\[\]()*_]/g,
  character => `&#${character.charCodeAt(0)};`);
const seconds = value => value === null ? 'unknown' : (value / 1000).toFixed(1);

export function renderQueueReport(report) {
  return [
    '# RQ-QUEUE: CI queue observations', '',
    `${report.totalJobs} unique jobs across ${report.captures.length} complete run-attempt captures.`, '',
    'Delay = job created_at to started_at; it can include dependency, approval and concurrency waits.',
    'Queued age is a lower bound at capture time, reported separately from started-job delay.',
    'Labels overlap: a multi-label job appears in each label row; do not sum label counts.',
    'No-step cancellations are not zero-delay samples. Missing evidence stays unknown.', '',
    '| Runner label | Jobs | Started | Queued | Cancelled without steps | Skipped | Unknown | Delay p50 s | Delay p95 s | Delay max s | Queued age max s | Execution p95 s |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.labels.map(row => `| ${cell(row.label ?? '(unknown label)')} | ${row.jobs} | ${row.started} | ${row.queued} | ${row.cancelledWithoutSteps} | ${row.skipped} | ${row.unknown} | ${seconds(row.queueMs.p50)} | ${seconds(row.queueMs.p95)} | ${seconds(row.queueMs.max)} | ${seconds(row.queuedAgeMs.max)} | ${seconds(row.executionMs.p95)} |`),
    '', 'Captures:', '', ...report.captures.map(capture =>
      `- ${capture.repository} run ${capture.runId}, attempt ${capture.runAttempt}, observed ${capture.observedAt}`),
    '', 'This report measures supplied evidence; it does not verify PR heads, required checks, or a macOS critical path.', '',
  ].join('\n');
}

export async function main(argv, io = { readFile,
  stdout: value => process.stdout.write(value), stderr: value => process.stderr.write(value) }) {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.stdout('Usage: node scripts/ci-queue-report.mjs [--json] <capture.json>...\nSee RQ-QUEUE.md for the capture format.\n');
    return 0;
  }
  const files = argv.filter(arg => arg !== '--json');
  if (!files.length || files.some(arg => arg.startsWith('-'))) {
    io.stderr('Provide capture files and optional --json; use --help for usage.\n');
    return 2;
  }
  try {
    const captures = [];
    for (const file of files) {
      let capture;
      try { capture = JSON.parse(await io.readFile(file, 'utf8')); }
      catch { throw new Error('Capture file could not be read as JSON.'); }
      captures.push(capture);
    }
    const report = buildQueueReport(captures);
    io.stdout(argv.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : renderQueueReport(report));
    return 0;
  } catch (error) {
    io.stderr(`Queue report unavailable: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
