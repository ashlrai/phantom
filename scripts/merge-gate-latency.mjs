import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Input: matched merged PRs and GitHub jobs API responses, without credentials.
// These are job execution times, not finish-to-merged telemetry or queue forecasts.
export function percentiles(values) {
  if (!values.length || values.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error('Expected nonempty finite nonnegative measurements');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p) => sorted[Math.ceil(p * sorted.length) - 1];
  return { n: sorted.length, p50: rank(0.5), p90: rank(0.9) };
}

export function summarizeMergeGate(samples) {
  const rows = samples.map(({ jobs }) => {
    const seconds = (name) => {
      const matches = jobs.filter((job) => job.name === name);
      if (matches.length !== 1 || matches[0].conclusion !== 'success') {
        throw new Error(`Expected exactly one successful ${name}`);
      }
      const job = matches[0];
      if (!job.started_at || !job.completed_at) throw new Error('Missing job timestamps');
      const duration = (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000;
      if (!Number.isFinite(duration) || duration < 0) throw new Error('Invalid job timestamps');
      return duration;
    };
    const classify = seconds('Classify PR site lane');
    const quick = seconds('Quick typecheck');
    const secret = seconds('Secret-shape scan');
    // Execution-only comparison holds each measured duration constant and omits
    // runner scheduling, job transitions and the final Merge Gate job itself.
    return { classify, quick, secret, serial: Math.max(secret, classify + quick),
      parallel: Math.max(secret, classify, quick) };
  });
  return Object.fromEntries(['classify', 'quick', 'secret', 'serial', 'parallel']
    .map((key) => [key, percentiles(rows.map((row) => row[key]))]));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(summarizeMergeGate(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2));
}
