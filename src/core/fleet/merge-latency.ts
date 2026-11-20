/**
 * `phm merges latency`: how long PRs really take to merge (RQ-MERGELATN21IQ8).
 *
 * The merge outcome row lands when a poller notices the merge, about every ten
 * minutes, so "publish to observed" measures the poller. When the outcome row
 * also carries the PR's own created and merged times (`createdAt` and `mergedAt`,
 * or `prCreatedAt`/`pr_created_at` and `pr_merged_at`), "open to merge" is the true
 * time. Both are reported side by side with how many merged PRs each covers.
 * A PR missing either time is unknown for that timing, never zero and never
 * guessed from the other one. Pure: the CLI and the status digest read the file.
 */
import { ledgerRows, readText } from './empty-cause.js';
import { outcomePercentile } from './outcome-metrics.js';
import { parseLedgerTs } from '../metrics/loop.js';

export const MERGES_LATENCY_SCHEMA = 'merges.latency.v1' as const;
export const MERGES_LATENCY_BY = ['lane', 'repo'] as const;
export type MergesLatencyBy = (typeof MERGES_LATENCY_BY)[number];
export const MERGES_LATENCY_MAX_HOURS = 24 * 30;

/** One timing over the merged PRs in the window. `unknown` PRs are left out of the percentiles. */
export interface TimingStats { known: number; unknown: number; coverage_pct: number | null; p50_s: number | null; p90_s: number | null }
export interface MergeLatencyGroup { name: string; merged: number; open_to_merge: TimingStats; publish_to_observed: TimingStats }
export interface MergeLatencyReport {
  schema: typeof MERGES_LATENCY_SCHEMA;
  as_of: string; since: string; hours: number; by: MergesLatencyBy;
  metrics_path: string;
  metrics: 'ok' | 'unreadable';
  malformed_lines: number | null;
  /** What each timing starts and stops at, so a reader never mistakes one for the other. */
  basis: { open_to_merge: 'pr_created_to_pr_merged'; publish_to_observed: 'pr_publication_to_merge_observation' };
  merged: number | null;
  /** The true time. */
  open_to_merge: TimingStats | null;
  /** The old, poller-bound time. */
  publish_to_observed: TimingStats | null;
  headline: string;
  groups: MergeLatencyGroup[];
}

const HOUR = 3_600_000;
const LOOKBACK_HOURS = 168;
const LEDGER_TAIL_BYTES = 32 * 1024 * 1024;
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/i;
const label = (value: unknown): string | null => typeof value === 'string' && /^[\w][\w.:@/-]{0,79}$/.test(value.trim()) ? value.trim() : null;

interface Pr { key: string; repo: string; observed: number; published: number | null; created: number | null; merged: number | null; lane: string | null }

/** Pure: validate the CLI window and grouping. Null when invalid. */
export function mergesLatencyOptions(hours?: number, by?: string | null): { hours: number; by: MergesLatencyBy } | null {
  const window = hours ?? 24, group = MERGES_LATENCY_BY.find(name => name === (by ?? 'lane'));
  return Number.isFinite(window) && window > 0 && window <= MERGES_LATENCY_MAX_HOURS && group ? { hours: window, by: group } : null;
}

const stats = (seconds: readonly (number | null)[]): TimingStats => {
  const known = seconds.filter((s): s is number => s !== null);
  const round = (p: number): number | null => { const v = outcomePercentile(known, p); return v === null ? null : Math.round(v); };
  return { known: known.length, unknown: seconds.length - known.length, coverage_pct: seconds.length ? Math.round((known.length / seconds.length) * 100) : null, p50_s: round(0.5), p90_s: round(0.9) };
};

/** Seconds from `from` to `to`; null when either is missing or the order is impossible. */
const span = (from: number | null, to: number | null): number | null => from === null || to === null || to < from ? null : (to - from) / 1000;

/** "4m 10s"; null is "unknown". */
export function spanText(seconds: number | null): string {
  if (seconds === null) return 'unknown';
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  return whole < 3600 ? `${Math.floor(whole / 60)}m ${whole % 60}s` : `${Math.floor(whole / 3600)}h ${Math.floor((whole % 3600) / 60)}m`;
}

/** Pure: one record per merged PR, with the PR's own times when an outcome row carried them. */
function mergedPrs(ledger: string, now: number, hours: number): { prs: Pr[]; malformed: number } {
  const { rows, malformed } = ledgerRows(ledger, now, hours + LOOKBACK_HOURS, true);
  const lanes = new Map<string, string>(), jobOfUrl = new Map<string, string>(), published = new Map<string, number>();
  const urlOf = (row: Record<string, unknown>) => PR_URL.exec(String(row.url ?? row.prUrl ?? row.pr_url ?? row.pr ?? ''));
  for (const { row, id, at } of rows) {
    const lane = label(row.lane ?? row.pool), event = row.event;
    // The launch row decides a job's lane; other rows only fill gaps.
    if (id && lane && (event === 'launch' || !lanes.has(id))) lanes.set(id, lane);
    const url = urlOf(row);
    if (!url) continue;
    const key = `${url[1]}#${url[2]}`.toLowerCase();
    if (id) jobOfUrl.set(key, id);
    if (event === 'publish' || event === 'published') published.set(key, Math.min(published.get(key) ?? Infinity, at));
  }
  const prs = new Map<string, Pr>();
  for (const { row, id, at } of rows) {
    const merged = row.event === 'merged' || ((row.event === 'outcome' || row.source === 'metrics-outcomes-reconciler') && (row.state ?? row.outcome ?? row.status) === 'MERGED');
    const url = merged ? urlOf(row) : null;
    if (!url) continue;
    const key = `${url[1]}#${url[2]}`.toLowerCase();
    const created = parseLedgerTs(row.createdAt ?? row.prCreatedAt ?? row.pr_created_at);
    const mergedAt = parseLedgerTs(row.mergedAt ?? row.pr_merged_at);
    const prev = prs.get(key);
    // Re-emitted rows for one PR count once, at the earliest observation; a later row may still supply the PR's own times.
    prs.set(key, {
      key, repo: url[1]!.split('/').pop()!.toLowerCase(), observed: Math.min(prev?.observed ?? Infinity, at),
      published: published.get(key) ?? null, created: prev?.created ?? created,
      merged: prev?.merged ?? (mergedAt !== null && mergedAt <= now ? mergedAt : null),
      lane: prev?.lane ?? lanes.get(id || jobOfUrl.get(key) || '') ?? null,
    });
  }
  return { prs: [...prs.values()], malformed };
}

/** Pure: the report. `ledger` null means the metrics file was unreadable, so nothing is measured. */
export function buildMergeLatency(input: { ledger: string | null; now: number; hours: number; by: MergesLatencyBy; metricsPath: string }): MergeLatencyReport {
  const { now, hours, by } = input, since = now - hours * HOUR;
  const window = hours === 1 ? 'the last hour' : `the last ${hours} hours`;
  const base = {
    schema: MERGES_LATENCY_SCHEMA, as_of: new Date(now).toISOString(), since: new Date(since).toISOString(), hours, by,
    metrics_path: input.metricsPath, basis: { open_to_merge: 'pr_created_to_pr_merged', publish_to_observed: 'pr_publication_to_merge_observation' },
  } as const;
  if (input.ledger === null) {
    return { ...base, metrics: 'unreadable', malformed_lines: null, merged: null, open_to_merge: null, publish_to_observed: null,
      headline: `Time to merge in ${window}: unknown (cannot read the job metrics file)`, groups: [] };
  }
  const read = mergedPrs(input.ledger, now, hours);
  // A merge belongs to the window by when GitHub merged it, else by when it was seen.
  const inWindow = read.prs.filter(pr => { const at = pr.merged ?? pr.observed; return at >= since && at <= now; });
  const timings = (prs: readonly Pr[]) => ({
    open_to_merge: stats(prs.map(pr => span(pr.created, pr.merged))),
    publish_to_observed: stats(prs.map(pr => span(pr.published, pr.observed))),
  });
  const total = timings(inWindow);
  const names = [...new Set(inWindow.map(pr => (by === 'lane' ? pr.lane : pr.repo) ?? 'unknown'))].sort((a, b) => a.localeCompare(b));
  const headline = !inWindow.length ? `No PR merged in ${window}`
    : `${inWindow.length} merged in ${window}; open to merge ${total.open_to_merge.p50_s === null ? 'unknown (no merged PR carries its own created and merged times yet)' : `median ${spanText(total.open_to_merge.p50_s)} (${total.open_to_merge.coverage_pct}% known)`}; publish to observed median ${spanText(total.publish_to_observed.p50_s)}`;
  return { ...base, metrics: 'ok', malformed_lines: read.malformed, merged: inWindow.length, ...total, headline,
    groups: names.map(name => { const prs = inWindow.filter(pr => ((by === 'lane' ? pr.lane : pr.repo) ?? 'unknown') === name); return { name, merged: prs.length, ...timings(prs) }; }) };
}

const row = (name: string, t: TimingStats) => `${name}: median ${spanText(t.p50_s)}, p90 ${spanText(t.p90_s)}, ${t.coverage_pct === null ? 'no PRs' : `${t.coverage_pct}% known (${t.known} of ${t.known + t.unknown})`}`;

/** Pure: the plain-words view. */
export function mergeLatencyText(report: MergeLatencyReport): string[] {
  const lines = [`${report.headline}.`];
  if (report.metrics !== 'ok' || !report.open_to_merge || !report.publish_to_observed) return [...lines, `Cannot read the job metrics file ${report.metrics_path}.`];
  if (!report.merged) return lines;
  lines.push(`  ${row('Open to merge (true)', report.open_to_merge)}`, `  ${row('Publish to observed (current, includes polling delay)', report.publish_to_observed)}`);
  if (report.groups.length > 1 || report.groups[0]?.name !== 'unknown') {
    lines.push(`By ${report.by}:`, ...report.groups.map(g => `  ${g.name} (${g.merged} merged): open to merge median ${spanText(g.open_to_merge.p50_s)}, p90 ${spanText(g.open_to_merge.p90_s)}; publish to observed median ${spanText(g.publish_to_observed.p50_s)}, p90 ${spanText(g.publish_to_observed.p90_s)}`));
  }
  if (report.malformed_lines) lines.push(`Metrics lines that could not be read and were skipped: ${report.malformed_lines}.`);
  return lines;
}

/** Read the job metrics file. Read-only; never throws. */
export async function readMergeLatency(opts: { metricsPath: string; hours: number; by: MergesLatencyBy; now: number }): Promise<MergeLatencyReport> {
  return buildMergeLatency({ ledger: await readText(opts.metricsPath, LEDGER_TAIL_BYTES), now: opts.now, hours: opts.hours, by: opts.by, metricsPath: opts.metricsPath });
}
