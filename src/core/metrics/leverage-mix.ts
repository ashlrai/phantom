import {
  isTestPath, parseLeverageSources, readLeverageInputs,
  type LeverageJobsText, type LeverageSourceOptions,
} from './leverage-class.js';

const LEVERAGE_CLASSES = ['test-only', 'docs', 'feature', 'fleet/self-improvement', 'fix', 'unknown'] as const;
export type LeverageClass = (typeof LEVERAGE_CLASSES)[number];

/** Precedence: exclusively tests, exclusively documentation, fleet, fix, feature, unknown. */
export function classifyLeverage(paths: readonly string[], jobId: string | null): LeverageClass {
  const docs = (p: string): boolean => /(^|\/)docs?\//i.test(p) || /(^|\/)(readme|changelog|contributing|license)(\.|$)/i.test(p) || /\.mdx?$/i.test(p);
  if (paths.length && paths.every(isTestPath)) return 'test-only';
  if (paths.length && paths.every(p => isTestPath(p) || docs(p)) && paths.some(docs)) return 'docs';
  const id = (jobId ?? '').toLowerCase();
  if (/fleet|router|queue|dispatch|steward|self.improv|agentnet/.test(id) || paths.some(p => /^(src\/core\/fleet\/|contrib\/mac\/|fleet\/)/.test(p))) return 'fleet/self-improvement';
  if (/fix|bug|repair|regression|recover|harden/.test(id)) return 'fix';
  if (/feature|add|build|implement/.test(id)) return 'feature';
  return 'unknown';
}

/**
 * The 24-hour fleet merge mix. `jobsText` accepts the same bounded-tail union
 * as `phm metrics leverage`: a { text, truncated } read reports
 * `sources.jobsTruncated` so counts never imply coverage they do not have.
 */
export function buildLeverageMix(jobsText: LeverageJobsText, prsText: string | null, nowMs = Date.now()) {
  const since = nowMs - 24 * 60 * 60 * 1000;
  const { ledger, prs, sources } = parseLeverageSources(jobsText, prsText, since, nowMs);
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
    sources,
    total: available ? total : null,
    classes: LEVERAGE_CLASSES.map(name => ({ name, count: available ? counts[name] : null, share: available && total ? counts[name] / total : null })),
    improvedShare: available && total && counts.unknown < total ? (counts.feature + counts['fleet/self-improvement'] + counts.fix) / total : null,
  };
}
export type LeverageMix = ReturnType<typeof buildLeverageMix>;

/**
 * Reads the jobs ledger's newest bounded tail (readLedgerTail, the same
 * 16 MiB window every other fleet reader uses) plus an optional gh export.
 * Unreadable files read as missing, never as zero; an oversized ledger reads
 * its tail and reports `sources.jobsTruncated` instead of implying full
 * coverage or refusing the read outright.
 */
export async function readLeverageMix(opts: LeverageSourceOptions = {}): Promise<LeverageMix> {
  const { jobs, prsText } = await readLeverageInputs(opts);
  return buildLeverageMix(jobs, prsText, opts.now);
}
