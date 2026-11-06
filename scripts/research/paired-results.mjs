/** Offline research accounting only. No provider calls or runtime admission. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function invalid() { throw new Error('Invalid paired experiment data'); }
function observation(value) {
  if (!value || typeof value !== 'object') invalid();
  for (const field of ['elapsedMs', 'tokens', 'unsafeAccepts', 'staleAccepts']) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) invalid();
  }
  if (value.elapsedMs === 0 || typeof value.success !== 'boolean') invalid();
  return value;
}
function sum(values) {
  const total = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total)) invalid();
  return total;
}
function summarize(rows) {
  const times = rows.map((row) => row.elapsedMs).sort((a, b) => a - b);
  const successes = rows.filter((row) => row.success).length;
  const tokens = sum(rows.map((row) => row.tokens));
  return {
    successes, successRate: successes / rows.length,
    totalMs: sum(times), p95Ms: times[Math.ceil(times.length * 0.95) - 1], tokens,
    tokensPerSuccess: successes === 0 ? null : tokens / successes,
    unsafeAccepts: sum(rows.map((row) => row.unsafeAccepts)),
    staleAccepts: sum(rows.map((row) => row.staleAccepts)),
  };
}

/**
 * One row per task/seed pair, with full end-to-end accounting for both arms.
 * Unknown accounting rejects the dataset instead of silently dropping failures.
 * Thresholds are pilot screens, not statistical evidence or rollout authority.
 */
export function evaluatePairs(input) {
  if (!input || input.schemaVersion !== 1 || !['synthetic', 'measured'].includes(input.evidence) ||
      !Array.isArray(input.pairs) || input.pairs.length === 0) invalid();
  const ids = new Set();
  for (const row of input.pairs) {
    if (!row || typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id)) invalid();
    ids.add(row.id);
    observation(row.baseline);
    observation(row.candidate);
  }
  const baseline = summarize(input.pairs.map((row) => row.baseline));
  const candidate = summarize(input.pairs.map((row) => row.candidate));
  const reasons = [];
  if (input.evidence === 'synthetic') reasons.push('synthetic-evidence');
  if (input.pairs.length < 100) reasons.push('insufficient-pairs');
  if (baseline.successes === 0 || candidate.successes === 0) reasons.push('no-successful-comparison');
  if (candidate.successes < baseline.successes) reasons.push('success-regression');
  if (baseline.unsafeAccepts || candidate.unsafeAccepts || baseline.staleAccepts || candidate.staleAccepts) {
    reasons.push('unsafe-or-stale-accept');
  }
  const tokenRatio = baseline.tokens === 0 ? (candidate.tokens === 0 ? 1 : null) : candidate.tokens / baseline.tokens;
  if (tokenRatio === null || tokenRatio > 1) reasons.push('token-budget-regression');
  const p95Ratio = candidate.p95Ms / baseline.p95Ms;
  const totalTimeRatio = candidate.totalMs / baseline.totalMs;
  if (p95Ratio > 0.9) reasons.push('insufficient-tail-improvement');
  if (totalTimeRatio > 1) reasons.push('total-time-regression');
  return {
    schemaVersion: 1, evidence: input.evidence, pairs: input.pairs.length,
    baseline, candidate, tokenRatio, p95Ratio, totalTimeRatio,
    lostSuccesses: input.pairs.filter((row) => row.baseline.success && !row.candidate.success).length,
    gainedSuccesses: input.pairs.filter((row) => !row.baseline.success && row.candidate.success).length,
    verdict: reasons.length ? 'hold' : 'pilot-screen-pass', reasons,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('usage');
    const result = evaluatePairs(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.verdict === 'hold' ? 1 : 0;
  } catch {
    // Never echo input data or paths: datasets can contain private context.
    process.stderr.write('Expected one JSON file containing valid paired experiment data.\n');
    process.exitCode = 2;
  }
}
