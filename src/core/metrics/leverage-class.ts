import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { foldJobsLedger, parseGhPullRequests, type EvalReportJobsRead } from '../fleet/eval-report.js';
import { readLedgerTail } from '../router/outcomes.js';
import { runsRoot } from './loop-collect.js';

/** How much a merged PR moves the fleet or the product. `unknown` is shown as unknown, never guessed. */
export const MERGE_CLASSES = ['fleet', 'product', 'docs', 'filler', 'unknown'] as const;
export type MergeClass = typeof MERGE_CLASSES[number];
export interface MergeFacts { title?: string | null; jobId?: string | null; paths?: readonly string[] }

const HOUR = 3_600_000;
const isTest = (p: string): boolean => /(^|\/)(__tests__|tests?|fixtures?)(\/|$)|\.(test|spec)\.[^/]+$/i.test(p);
const isDoc = (p: string): boolean => /(^|\/)docs?\//i.test(p) || /(^|\/)(readme|changelog|contributing|license|llms)(\.|$)/i.test(p) || /\.mdx?$/i.test(p);
const FLEET_WORDS = /dispatch|router|routing|merge|pool|guardian|self.?improv|\brsi\b|fleet|\bbus\b|steward|queue|autopilot|agentnet|recut/i;
const PRODUCT_WORDS = /desktop|phone|mobile|channel|\bcli\b|verse|slack|sms|\bphm\b|\bui\b/i;
const DOC_WORDS = /\bdocs?\b|readme|changelog/i;
const FILLER_WORDS = /link.?check|one.?test|\bfiller\b/i;
const FLEET_PATH = /^(src\/core\/(fleet|dispatch\w*|router\w*|routing\w*|queue\w*|guardian|autonomy|autopilot|inbox|merge\w*|steward|agentnet|daemon|bridge|swarm|publish)\b|src\/fleet\/|contrib\/|scripts\/fleet)/;
const PRODUCT_PATH = /^(src\/(web-ui|cli|tui|raycast)\/|src\/core\/(desktop|mobile|comms\w*|connectors|verse|bots|ask\w*|app-)|apps?\/|desktop\/)/;

/**
 * Pure. Order of evidence: docs-only paths, one lone test or a link check (filler),
 * then job id and title words (intent), then changed paths. No evidence means unknown.
 */
export function classifyMerge(facts: MergeFacts): MergeClass {
  const paths = facts.paths ?? [];
  const words = `${facts.jobId ?? ''} ${facts.title ?? ''}`;
  if (paths.length && paths.every(isDoc)) return 'docs';
  if (FILLER_WORDS.test(words) || (paths.length === 1 && isTest(paths[0]!))) return 'filler';
  if (FLEET_WORDS.test(words)) return 'fleet';
  if (PRODUCT_WORDS.test(words)) return 'product';
  if (paths.some(p => !isTest(p) && FLEET_PATH.test(p))) return 'fleet';
  if (paths.some(p => !isTest(p) && PRODUCT_PATH.test(p))) return 'product';
  if (DOC_WORDS.test(words) && !paths.length) return 'docs';
  return 'unknown';
}

type Counts = Record<MergeClass, number>;
const empty = (): Counts => ({ fleet: 0, product: 0, docs: 0, filler: 0, unknown: 0 });

/**
 * What a jobsText input may carry: raw ledger text, or the newest bounded
 * tail plus its cut flag (`truncated` true exactly when older bytes were not
 * read). A bare string is a complete, untruncated read — the same union the
 * fleet eval report accepts.
 */
export type LeverageJobsText = string | EvalReportJobsRead | null;

/** Bare string means a complete read; { text, truncated } carries the tail cut flag; null is no ledger. */
export const normalizeLeverageJobs = (jobsText: LeverageJobsText): EvalReportJobsRead | null =>
  jobsText === null ? null
    : typeof jobsText === 'string' ? { text: jobsText, truncated: false }
    : jobsText;

/**
 * `phm metrics leverage`: merges in the last `hours` hours, counted per class per hour.
 * Titles and paths come from an optional gh export; without one only the job id is read, so more merges show as unknown.
 * `leverageShare` is (fleet + product) / all merges, unknowns included; null when nothing merged.
 * A bounded jobs tail reports `sources.jobsTruncated` — merge counts then cover only the newest ledger bytes.
 */
export function buildLeverageReport(jobsText: LeverageJobsText, prsText: string | null, nowMs = Date.now(), hours = 24) {
  const since = nowMs - hours * HOUR;
  const jobsRead = normalizeLeverageJobs(jobsText);
  const ledger = jobsRead === null ? null : foldJobsLedger(jobsRead.text, since, nowMs);
  const prs = prsText === null ? null : parseGhPullRequests(prsText);
  const merges = new Map<string, MergeFacts & { at: number }>();
  for (const [key, row] of ledger?.outcomes ?? []) {
    if (row.state === 'MERGED' && row.atMs !== null && row.atMs >= since && row.atMs < nowMs) merges.set(key, { at: row.atMs, jobId: row.jobId });
  }
  for (const pr of prs?.rows ?? []) {
    const known = merges.get(pr.key);
    if (known) merges.set(pr.key, { ...known, jobId: known.jobId ?? ledger?.jobByUrl.get(pr.key) ?? null, title: pr.title, paths: pr.files });
    else if (!ledger && pr.mergedAtMs !== null && pr.mergedAtMs >= since && pr.mergedAtMs < nowMs) merges.set(pr.key, { at: pr.mergedAtMs, title: pr.title, paths: pr.files });
  }
  const known = ledger !== null || prs !== null;
  const totals = empty();
  const buckets = Array.from({ length: hours }, (_, i) => ({ start: new Date(since + i * HOUR).toISOString(), counts: empty() }));
  for (const merge of merges.values()) {
    const cls = classifyMerge(merge);
    totals[cls]++;
    buckets[Math.min(hours - 1, Math.floor((merge.at - since) / HOUR))]!.counts[cls]++;
  }
  const total = merges.size;
  return {
    schema: 'metrics.leverage.v1' as const,
    known, hours, since: new Date(since).toISOString(), until: new Date(nowMs).toISOString(),
    sources: { jobs: !ledger ? 'missing' : ledger.counts.ignored ? 'degraded' : 'available',
      /** True when the jobs ledger exceeded the retained tail: merge counts cover only the newest bytes. */
      jobsTruncated: jobsRead?.truncated ?? false,
      pullRequests: !prs ? 'missing' : prs.ignored ? 'degraded' : 'available' },
    total: known ? total : null,
    totals: known ? totals : null,
    leverageShare: known && total ? (totals.fleet + totals.product) / total : null,
    perHour: known ? buckets : null,
  };
}
export type LeverageReport = ReturnType<typeof buildLeverageReport>;

export interface ReadLeverageReportOptions {
  hours?: number;
  prsPath?: string;
  runsDir?: string;
  now?: number;
  /**
   * Injected jobs-ledger read — raw text or a bounded tail plus its cut flag;
   * skips the jobs.jsonl read when set. Null reports an absent ledger.
   */
  jobs?: LeverageJobsText;
}

/**
 * Reads the jobs ledger's newest bounded tail (readLedgerTail, the same
 * 16 MiB window every other fleet reader uses) plus an optional gh export.
 * Unreadable files read as missing, never as zero; an oversized ledger reads
 * its tail and reports `sources.jobsTruncated` instead of implying full
 * coverage or refusing the read outright.
 */
export async function readLeverageReport(opts: ReadLeverageReportOptions = {}): Promise<LeverageReport> {
  const read = (path: string): string | null => { try { return readFileSync(path, 'utf8'); } catch { return null; } };
  let jobs = opts.jobs;
  if (jobs === undefined) {
    const tail = await readLedgerTail(join(opts.runsDir ?? runsRoot(), 'metrics', 'jobs.jsonl'));
    jobs = tail.state === 'read' ? { text: tail.text, truncated: tail.truncated } : null;
  }
  return buildLeverageReport(jobs, opts.prsPath ? read(opts.prsPath) : null, opts.now, opts.hours);
}
