/**
 * Cross-review journal recurring findings → self-improvement backlog items.
 *
 * Every cross-model review appends one CrossReviewRecord — the isolated
 * reviewer process's verdict (`approve`/`reject`/`failed`/`skipped`), its
 * closed reason codes, the producer and reviewer pools and families — to
 * <ashlr>/fleet/cross-review.jsonl, the audit journal `phm fleet xreview`
 * and the merge-time decide step share. foldCrossReviews already joins
 * each job's newest verdict through its PR claim, but the journal's
 * *recurring findings* — one producer's pull requests keep failing
 * independent review for the same reason, or reviews keep failing before
 * a verdict — only ever reached `phm router outcomes`/`router-weights`
 * tallies and the audit log itself: reports someone had to run and read.
 * crossReviewBacklogItems carries the recurring cells into discoverBacklog,
 * so `phm improve discover` and the scheduler's autoDiscover queue them
 * exactly like the fleet outcome-learning, nightly retro, policy,
 * local-gate, pass^k and friction sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail (ROUTER_OUTCOME_LEDGER_LIMIT — the same bound
 *    readRouterOutcomes applies to this file); nothing is written and no
 *    network is touched.
 *  - The canonical reader's tolerance. foldCrossReviews — the fold the
 *    outcome join already trusts for this file — skips unparseable lines
 *    and foreign record kinds, so this fold applies the same rule: a
 *    crash-torn tail line or a `kind:'decision'` row never poisons the
 *    read. Every consumed row is still fully validated — schema version,
 *    kind, bounded repo/pr/outcome shapes and the closed vocabularies —
 *    so evidence can only under-count (a hidden row delays a cell crossing
 *    the bar), never invent a finding.
 *  - Recurring means recorded and current. A cell emits only with at
 *    least XREVIEW_MIN_ROWS contributing rows spanning at least
 *    XREVIEW_MIN_PRS distinct pull requests whose newest row lands inside
 *    XREVIEW_WINDOW_MS — the fleet's RECURRING_FAILURES convention applied
 *    to review evidence, so one PR's repeated re-reviews, or a stale
 *    journal on a fleet whose reviews stopped, never queue a session.
 *  - Repo attribution is exact. Review rows carry the pull request's
 *    owner/repo; an item emits only when it matches the backlog target
 *    case-insensitively — findings on another repository's pull requests
 *    never land on this one (the nightly source's rule).
 *  - Dedup is downstream. The item id embeds a stable hash of the cell
 *    identity (kind + repo + producer pool + reason, or kind + repo +
 *    failure code — never the counts or timestamps), so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what is
 *    new; shifted tallies do not spawn twin items.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, recorded labels are scrubbed and flattened to one
 *    line, example PR refs are bounded, and the brief carries the usual
 *    no-change escape when the window no longer reproduces.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { ashlrHome, CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail, ROUTER_CROSS_REVIEW_LEDGER_RELATIVE } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; finding cells are bounded upstream but unbounded in practice. */
export const XREVIEW_MAX_ITEMS = 8;
const XREVIEW_ITEM_HARD_MAX = 25;
/** Contributing rows a cell needs before it counts as recurring — the fleet's RECURRING_FAILURES convention. */
export const XREVIEW_MIN_ROWS = 3;
/** Distinct pull requests the same evidence must span — one PR's re-reviews are one job's problem. */
export const XREVIEW_MIN_PRS = 2;
/** Review evidence older than this never emits; the nightly cadence makes a month generous. */
export const XREVIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Example PR refs named inside one prompt before the remainder is summarized. */
const PROMPT_EXAMPLE_PRS = 5;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded labels are bounded upstream; flatten, scrub and cap before they reach a prompt. */
const MAX_FIELD_CHARS = 96;

// Local copies of the cross-review ledger's closed vocabularies — the same
// precedent outcomes.ts sets for this file (its schema version and verdict
// set are local copies too). Importing src/core/fleet/cross-review.ts would
// grow the Tier-1 authority closure with merge-authority machinery for two
// string sets.
const CROSS_REVIEW_SCHEMA = 1;
const REVIEW_OUTCOMES: ReadonlySet<string> = new Set(['approve', 'reject', 'failed', 'skipped']);
const REVIEW_REASON_CODES: ReadonlySet<string> = new Set([
  'correct-and-scoped', 'tests-adequate', 'incorrect-logic', 'missing-tests',
  'weakens-tests', 'weakens-security', 'out-of-scope', 'incomplete',
  'unsafe-side-effects', 'suspicious-instructions', 'unreadable-diff', 'other',
]);

const REPO_LABEL = /^[\w.-]+\/[\w.-]+$/;
const IDENTIFIER_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const FAILURE_LABEL = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface XreviewItemsOptions {
  /** Backlog target in owner/name form; review rows must name the same repository. */
  repo: string;
  /** ASHLR home root holding fleet/cross-review.jsonl (default: ashlrHome(), ASHLR_HOME honored). */
  ashlarDir?: string;
  /** Recency window for review evidence in ms (default XREVIEW_WINDOW_MS). */
  windowMs?: number;
  /** Most items one call emits (default XREVIEW_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock for the recency window (default: now). */
  now?: Date;
}

/** Journal-recorded fields are unbounded text; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = MAX_FIELD_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

function boundedLabel(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

/** `name:count` pairs, most jobs first — the recorded label tallies quoted into prompts. */
function tallyLine(tally: ReadonlyMap<string, number>, limit = 3): string {
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, n]) => `${fieldText(name, 48)}:${n}`)
    .join(', ');
}

interface ParsedReview {
  repo: string;
  repoKey: string;
  pr: number;
  atMs: number;
  atIso: string;
  outcome: 'reject' | 'failed';
  /** Valid reason codes on a reject row (deduped); empty on a failed row. */
  reasons: string[];
  /** Bounded failure label on a failed row; null on a reject row. */
  failure: string | null;
  producerPool: string | null;
  producerFamily: string | null;
  reviewerPool: string | null;
}

/** One validated kind:'review' row, or null when it is not reject/failed evidence this fold consumes. */
function parseReview(value: unknown): ParsedReview | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row['schemaVersion'] !== CROSS_REVIEW_SCHEMA || row['kind'] !== 'review') return null;
  const repo = row['repo'];
  const pr = row['pr'];
  const outcome = row['outcome'];
  const at = row['at'];
  if (typeof repo !== 'string' || !REPO_LABEL.test(repo)) return null;
  if (typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr < 1) return null;
  if (typeof outcome !== 'string' || !REVIEW_OUTCOMES.has(outcome)) return null;
  if (outcome !== 'reject' && outcome !== 'failed') return null;
  if (typeof at !== 'string') return null;
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return null;
  const producerPool = boundedLabel(row['producerPool'], IDENTIFIER_LABEL);
  const producerFamily = boundedLabel(row['producerFamily'], IDENTIFIER_LABEL);
  const reviewerPool = boundedLabel(row['reviewerPool'], IDENTIFIER_LABEL);
  const base = { repo, repoKey: repo.toLowerCase(), pr, atMs, atIso: at, producerPool, producerFamily, reviewerPool };
  if (outcome === 'reject') {
    const reasons = Array.isArray(row['reasons'])
      ? [...new Set(row['reasons'].filter((r): r is string => typeof r === 'string' && REVIEW_REASON_CODES.has(r)))]
      : [];
    // A reject without a recorded producer pool or a usable reason code
    // cannot be attributed — skipped, never guessed into a cell.
    if (reasons.length === 0 || producerPool === null) return null;
    return { ...base, outcome, reasons, failure: null };
  }
  const failure = boundedLabel(row['failure'], FAILURE_LABEL);
  if (failure === null) return null;
  return { ...base, outcome, reasons: [], failure };
}

interface FindingCell {
  kind: 'reject' | 'failure';
  /** The recorded reason code (reject) or failure code (failure) the cell groups on. */
  code: string;
  /** The recorded producer pool (reject cells only). */
  producerPool: string | null;
  repo: string;
  repoKey: string;
  rows: number;
  prs: Set<number>;
  examples: string[];
  newestMs: number;
  newestIso: string;
  producerFamilies: Map<string, number>;
  reviewerPools: Map<string, number>;
  /** Rows recorded with no reviewer pool — the failure happened before or during reviewer selection. */
  noReviewer: number;
}

function addToCell(cells: Map<string, FindingCell>, cellId: string, row: ParsedReview, code: string): void {
  let cell = cells.get(cellId);
  if (cell === undefined) {
    cell = {
      kind: row.outcome === 'reject' ? 'reject' : 'failure',
      code,
      producerPool: row.outcome === 'reject' ? row.producerPool : null,
      repo: row.repo,
      repoKey: row.repoKey,
      rows: 0,
      prs: new Set<number>(),
      examples: [],
      newestMs: -Infinity,
      newestIso: '',
      producerFamilies: new Map<string, number>(),
      reviewerPools: new Map<string, number>(),
      noReviewer: 0,
    };
    cells.set(cellId, cell);
  }
  cell.rows += 1;
  cell.prs.add(row.pr);
  const ref = `${row.repo}#${row.pr}`;
  if (cell.examples.length < PROMPT_EXAMPLE_PRS && !cell.examples.includes(ref)) cell.examples.push(ref);
  if (row.atMs > cell.newestMs) {
    cell.newestMs = row.atMs;
    cell.newestIso = row.atIso;
  }
  if (row.producerFamily !== null) {
    cell.producerFamilies.set(row.producerFamily, (cell.producerFamilies.get(row.producerFamily) ?? 0) + 1);
  }
  if (row.reviewerPool !== null) {
    cell.reviewerPools.set(row.reviewerPool, (cell.reviewerPools.get(row.reviewerPool) ?? 0) + 1);
  } else {
    cell.noReviewer += 1;
  }
}

const cellIdentity = (cell: FindingCell): string =>
  JSON.stringify(cell.kind === 'reject'
    ? ['reject', cell.repoKey, cell.producerPool, cell.code]
    : ['failure', cell.repoKey, cell.code]);

function xreviewRejectItem(cell: FindingCell, repo: string): CloudBacklogItem {
  const id = `xreview-reject-${createHash('sha256').update(cellIdentity(cell)).digest('hex').slice(0, 16)}`;
  const producer = fieldText(cell.producerPool ?? '');
  const reason = fieldText(cell.code);
  const repoName = fieldText(cell.repo, 120);
  const families = tallyLine(cell.producerFamilies);
  const reviewers = tallyLine(cell.reviewerPools);
  const title = `Cross-review: '${producer}' pull requests on ${repoName} keep failing review ('${reason}')`.slice(0, MAX_TITLE_CHARS);
  const prompt = [
    `Phantom's cross-model review journal recorded recurring rejections of ${repoName} pull requests produced by pool '${producer}' — independent reviewers keep citing reason '${reason}' — the self-improvement work this backlog exists for.`,
    '',
    `Evidence: ${cell.rows} recorded reject rows across ${cell.prs.size} distinct pull requests (${cell.examples.join(', ')}); newest ${fieldText(cell.newestIso, 64)}.` +
      (families !== '' ? ` Producer families seen: ${families}.` : '') +
      (reviewers !== '' ? ` Reviewer pools seen: ${reviewers}.` : '') +
      (cell.noReviewer > 0 ? ` ${cell.noReviewer} row(s) recorded no reviewer pool.` : ''),
    '',
    'The journal is fleet/cross-review.jsonl under the Phantom state directory (~/.ashlr or $ASHLR_HOME); `phm router outcomes --json` joins each job\'s newest recorded verdict and `phm fleet router-weights --json` tallies verdict outcomes over the same ledger. Find why this producer\'s diffs keep failing independent review for the recorded reason: the lane\'s prompt template or scope rules in this repository\'s fleet machinery, a repo convention the reviewer enforces that the job brief never states (tests, diff size, claimed-versus-actual scope), or a systematic mismatch between what the job asks and what the change does. Fix the cause in this repository. If reviews recorded since this window passed, or the pattern no longer reproduces on the default branch, report no-change and name the evidence.',
  ].join('\n');
  return {
    id,
    title,
    prompt,
    area: 'cross-review',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function xreviewFailureItem(cell: FindingCell, repo: string): CloudBacklogItem {
  const id = `xreview-failure-${createHash('sha256').update(cellIdentity(cell)).digest('hex').slice(0, 16)}`;
  const code = fieldText(cell.code);
  const repoName = fieldText(cell.repo, 120);
  const reviewers = tallyLine(cell.reviewerPools);
  const title = `Cross-review: ${repoName} reviews keep failing ('${code}')`.slice(0, MAX_TITLE_CHARS);
  const prompt = [
    `Phantom's cross-model review journal recorded recurring review failures on ${repoName} pull requests — the reviewer pipeline keeps failing before it can return a verdict ('${code}') — the self-improvement work this backlog exists for.`,
    '',
    `Evidence: ${cell.rows} recorded failed-review rows across ${cell.prs.size} distinct pull requests (${cell.examples.join(', ')}); newest ${fieldText(cell.newestIso, 64)}.` +
      (reviewers !== '' ? ` Reviewer pools seen: ${reviewers}.` : '') +
      (cell.noReviewer > 0 ? ` ${cell.noReviewer} row(s) recorded no reviewer pool — the failure happened before or during reviewer selection.` : ''),
    '',
    'The journal is fleet/cross-review.jsonl under the Phantom state directory (~/.ashlr or $ASHLR_HOME); `phm fleet xreview` runs the reviews and `phm router outcomes --json` joins each job\'s newest recorded verdict. Find whether the reviewer seat\'s availability, its timeout or output bound, the isolated spawn path, or the policy\'s reviewer selection is at fault — a repository whose reviews keep failing escalates every pull request it touches instead of auto-merging. Fix the cause in this repository. If the failures were a transient window that no longer reproduces on the default branch, report no-change and name the evidence.',
  ].join('\n');
  return {
    id,
    title,
    prompt,
    area: 'cross-review',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the cross-review journal's recurring findings on `repo`,
 * strongest evidence first. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function crossReviewBacklogItems(opts: XreviewItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '') return [];
    const repoKey = repo.toLowerCase();
    const root = opts.ashlarDir ?? ashlrHome();
    const read = await readLedgerTail(join(root, ROUTER_CROSS_REVIEW_LEDGER_RELATIVE));
    if (read.state !== 'read') return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? XREVIEW_WINDOW_MS;
    const cells = new Map<string, FindingCell>();
    for (const line of read.text.split('\n')) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const row = parseReview(value);
      if (row === null) continue;
      if (nowMs - row.atMs > windowMs) continue;
      if (row.repoKey !== repoKey) continue;
      if (row.outcome === 'reject') {
        for (const reason of row.reasons) {
          addToCell(cells, JSON.stringify(['reject', row.repoKey, row.producerPool, reason]), row, reason);
        }
      } else if (row.failure !== null) {
        addToCell(cells, JSON.stringify(['failure', row.repoKey, row.failure]), row, row.failure);
      }
    }
    const candidates = [...cells.values()]
      .filter((cell) => cell.rows >= XREVIEW_MIN_ROWS && cell.prs.size >= XREVIEW_MIN_PRS);
    // Strongest recorded evidence first; identity fields last so the order is total.
    candidates.sort((a, b) =>
      b.rows - a.rows
      || b.newestMs - a.newestMs
      || a.kind.localeCompare(b.kind)
      || a.code.localeCompare(b.code)
      || (a.producerPool ?? '').localeCompare(b.producerPool ?? ''));
    const limit = Math.max(1, Math.min(opts.limit ?? XREVIEW_MAX_ITEMS, XREVIEW_ITEM_HARD_MAX));
    return candidates.slice(0, limit).map((cell) =>
      cell.kind === 'reject' ? xreviewRejectItem(cell, repo) : xreviewFailureItem(cell, repo));
  } catch {
    return [];
  }
}
