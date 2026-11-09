import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { foldJobsLedger, parseGhPullRequests } from '../fleet/eval-report.js';

export const LEVERAGE_CLASSES = ['test-only', 'docs', 'feature', 'fleet/self-improvement', 'fix', 'unknown'] as const;
export type LeverageClass = typeof LEVERAGE_CLASSES[number];

/** Precedence: exclusively tests, exclusively documentation, fleet, fix, feature, unknown. */
export function classifyLeverage(paths: readonly string[], jobId: string | null): LeverageClass {
  const test = (p: string): boolean => /(^|\/)(__tests__|tests?|fixtures?)(\/|$)|\.(test|spec)\.[^/]+$/i.test(p);
  const docs = (p: string): boolean => /(^|\/)docs?\//i.test(p) || /(^|\/)(readme|changelog|contributing|license)(\.|$)/i.test(p) || /\.mdx?$/i.test(p);
  if (paths.length && paths.every(test)) return 'test-only';
  if (paths.length && paths.every(p => test(p) || docs(p)) && paths.some(docs)) return 'docs';
  const id = (jobId ?? '').toLowerCase();
  if (/fleet|router|queue|dispatch|steward|self.improv|agentnet/.test(id) || paths.some(p => /^(src\/core\/fleet\/|contrib\/mac\/|fleet\/)/.test(p))) return 'fleet/self-improvement';
  if (/fix|bug|repair|regression|recover|harden/.test(id)) return 'fix';
  if (/feature|add|build|implement/.test(id)) return 'feature';
  return 'unknown';
}

export function buildLeverageMix(jobsText: string | null, prsText: string | null, nowMs = Date.now()) {
  const since = nowMs - 24 * 60 * 60 * 1000;
  const ledger = jobsText === null ? null : foldJobsLedger(jobsText, since, nowMs);
  const prs = prsText === null ? null : parseGhPullRequests(prsText);
  const merges = new Map<string, { jobId: string | null; paths: string[] }>();
  for (const [key, row] of ledger?.outcomes ?? []) {
    if (row.state === 'MERGED' && row.atMs !== null && row.atMs >= since && row.atMs < nowMs) merges.set(key, { jobId: row.jobId, paths: [] });
  }
  for (const pr of prs?.rows ?? []) {
    if (pr.mergedAtMs === null || pr.mergedAtMs < since || pr.mergedAtMs >= nowMs) continue;
    const previous = merges.get(pr.key);
    // PR exports enrich fleet ledger rows; unrelated PRs are not fleet evidence.
    if (previous) merges.set(pr.key, { jobId: previous.jobId ?? ledger?.jobByUrl.get(pr.key) ?? null, paths: pr.files });
  }
  const counts = Object.fromEntries(LEVERAGE_CLASSES.map(k => [k, 0])) as Record<LeverageClass, number>;
  for (const merge of merges.values()) counts[classifyLeverage(merge.paths, merge.jobId)]++;
  const total = merges.size;
  const available = ledger !== null;
  return {
    schema: 'metrics.leverage-mix.v1' as const, window: { since: new Date(since).toISOString(), until: new Date(nowMs).toISOString() },
    sources: { jobs: !ledger ? 'missing' : ledger.counts.ignored ? 'degraded' : 'available', pullRequests: !prs ? 'missing' : prs.ignored ? 'degraded' : 'available' },
    total: available ? total : null,
    classes: LEVERAGE_CLASSES.map(name => ({ name, count: available ? counts[name] : null, share: available && total ? counts[name] / total : null })),
    improvedShare: available && total && counts.unknown < total ? (counts.feature + counts['fleet/self-improvement'] + counts.fix) / total : null,
  };
}

export function readLeverageMix(prsPath?: string) {
  const read = (path: string): string | null => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
  return buildLeverageMix(read(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl')), prsPath ? read(prsPath) : null);
}
