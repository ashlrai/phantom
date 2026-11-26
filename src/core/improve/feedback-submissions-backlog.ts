/**
 * Community feedback submission outcomes → self-improvement backlog items.
 *
 * `phm fleet feedback scan --apply` (src/core/fleet/feedback-cycle.ts) is
 * the community intake: ingestFeedback folds GitHub issues, PR comments,
 * comms receipts, CI failures, master reverts and self-reports into
 * triaged signals, and each admitted signal becomes an RQ-PHX-FB<hash>
 * drop job whose admission is journaled to
 * <runs>/feedback/feedback-queued.jsonl by recordFeedbackQueued. The
 * per-submission outcome fold already exists — feedbackDigest reads the
 * same jobs-ledger tail plus the journal and assigns every submission a
 * state (queued, under-review, action-required, merged, shipped) — but
 * its only caller is `phm fleet feedback digest`, a report someone had
 * to run and read. A community bug report whose job failed, was
 * precheck-declined, gave up or closed unmerged, and a report that sat
 * admitted-but-unresolved past any reasonable queue wait, produced no
 * work item: the ARC loop ingests community contributions but never
 * learned which ones the fleet could not resolve.
 *
 * feedbackSubmissionsBacklogItems carries that fold into discoverBacklog
 * by calling feedbackDigest itself — the backlog classifies submissions
 * exactly the way the operator-facing digest does, never a second
 * opinion. The digest's gh-verified 'shipped' refinement needs the
 * ingest's network reads, so this feed passes an empty shipped set:
 * a ledger MERGED stays 'merged', which is non-adverse either way and
 * honestly never upgrades without gh evidence.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. feedback-queued.jsonl is read through
 *    readFeedbackQueued's bounded tail and metrics/jobs.jsonl through
 *    the same ROUTER_OUTCOME_LEDGER_LIMIT window the router outcome
 *    fold and the sibling feeds read; nothing is written and no
 *    network is touched. The jobs ledger is required evidence, not
 *    enrichment: withheld or missing, every submission would fabricate
 *    'queued', so the source stays quiet rather than emitting cells it
 *    cannot prove.
 *  - Recurring means recorded across days: an outcome class emits only
 *    at FEEDBACK_SUBMISSION_MIN_SUBMISSIONS distinct job ids across
 *    FEEDBACK_SUBMISSION_MIN_DAYS distinct UTC days inside the
 *    FEEDBACK_SUBMISSIONS_WINDOW_HOURS window — the fleet's
 *    RECURRING_FAILURES convention the sibling feeds apply. Each
 *    submission lands in exactly one class by the digest's own state:
 *    'action-required' is the digest's verdict that the job failed,
 *    gave up, was gate-declined, finished without an outcome or
 *    closed unmerged; 'stalled' is the digest's 'queued' state aged
 *    past FEEDBACK_STALLED_GRACE_HOURS — admitted (or last touched)
 *    but unresolved. Younger 'queued' rows are normal intake latency,
 *    'under-review'/'merged'/'shipped' are in-flight or held work —
 *    all context, never cells.
 *  - 'stalled' is the only absence claim, so it is the most guarded:
 *    the submission's own recorded `at` — the newest of its journal
 *    admission stamp and its latest jobs-ledger row — must be at least
 *    the grace old. A submission with no dated evidence cannot prove
 *    its age and folds to context, never a cell.
 *  - The digest bounds submissions to its newest
 *    MAX_SUBMISSIONS (50) rows; cells quote counts over that retained
 *    set and prompts state the jobs-tail truncation as a lower bound.
 *    A missing or unavailable journal contributes no entries — the
 *    same degradation `phm fleet feedback digest` applies — while
 *    ledger-only FB rows still fold with unattributed source/kind.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository (the same last-segment rule the sibling
 *    fleet-evidence sources apply) — the feedback scan, its drop-job
 *    queue and the triage that mints RQ-PHX-FB ids are this install's
 *    machinery. Submission text and request refs never reach a prompt:
 *    only job ids, source/kind tallies and counts, all journal-shaped.
 *    Dedup is downstream: the item id hashes the class plus the
 *    repository — never the counts or timestamps — so a refresh
 *    re-derives the same id and a class that recovers simply stops
 *    re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, example job ids must match the
 *    pipeline's own RQ-PHX-FB id shape before they are quoted, and
 *    source/kind tallies admit only the writer's fixed vocabularies —
 *    anything else folds to 'unrecorded', so no journal free text ever
 *    reaches a prompt. The brief names the journals, the writer and
 *    the handoff stages with the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { feedbackDigest, type FeedbackSubmission } from '../fleet/feedback-cycle.js';
import { readFeedbackQueued, type FeedbackQueuedEntry } from '../fleet/feedback-queue-record.js';
import {
  readLedgerTail,
  ROUTER_OUTCOME_LEDGER_LIMIT,
  ROUTER_OUTCOME_LEDGER_RELATIVE,
} from '../router/outcomes.js';

/** Items one call may emit; the adverse-class set is small and closed. */
export const FEEDBACK_SUBMISSIONS_BACKLOG_MAX_ITEMS = 4;
const FEEDBACK_SUBMISSIONS_BACKLOG_ITEM_HARD_MAX = 10;
/** Evidence window: the sibling fleet-evidence convention. */
export const FEEDBACK_SUBMISSIONS_WINDOW_HOURS = 168;
/** An outcome class emits only at this many distinct submissions inside the window... */
export const FEEDBACK_SUBMISSION_MIN_SUBMISSIONS = 3;
/** ...spread across at least this many distinct UTC days. */
export const FEEDBACK_SUBMISSION_MIN_DAYS = 2;
/**
 * A 'queued' submission only reads 'stalled' once its last recorded
 * activity is this old — drop jobs queue behind DROP_JOB_QUEUE_LIMIT
 * and the fleet's own backlog, so a day-old admission is still normal
 * intake latency; three days unresolved is recorded evidence the
 * pipeline is not draining community work.
 */
export const FEEDBACK_STALLED_GRACE_HOURS = 72;
/** The jobs ledger shares the router outcome fold's bounded tail. */
const FEEDBACK_JOBS_TAIL_BYTES = ROUTER_OUTCOME_LEDGER_LIMIT;
/** The fleet's own repository label: feedback evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Submission job ids are the pipeline's own mint: RQ-PHX-FB<dedupe hash>. */
const SAFE_SUBMISSION_ID = /^RQ-PHX-FB[A-Z0-9]{3,40}$/;
/** The writer's recorded source vocabulary (feedback-queue-record.ts SOURCES). */
const SUBMISSION_SOURCES = new Set(['github-issue', 'pr-comment', 'comms', 'ci-failure', 'revert', 'self-report']);
/** The writer's recorded kind vocabulary (feedback-queue-record.ts KINDS). */
const SUBMISSION_KINDS = new Set(['bug', 'regression', 'feature', 'flake']);
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on ledger timestamps. */
const SKEW_MS = 300_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Example job ids quoted inside one prompt. */
const MAX_PROMPT_EXAMPLES = 3;
/** Text tallies (source, kind) quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;

export interface FeedbackSubmissionsItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding feedback/feedback-queued.jsonl and metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default FEEDBACK_SUBMISSIONS_WINDOW_HOURS). */
  windowHours?: number;
  /** 'queued' submissions stall only after this many hours unresolved (default FEEDBACK_STALLED_GRACE_HOURS). */
  stalledGraceHours?: number;
  /**
   * Test injection for the admission journal: undefined reads
   * <runsDir>/feedback/feedback-queued.jsonl live, an array stands in
   * for a healthy read, and null stands in for a missing or
   * unavailable journal — the digest's own degradation either way.
   */
  queuedEntries?: readonly FeedbackQueuedEntry[] | null;
  /**
   * Test injection for the jobs-ledger tail: undefined reads
   * metrics/jobs.jsonl live, a string stands in for a healthy bounded
   * read (treated as untruncated), and null stands in for a withheld
   * ledger — which suppresses the whole source.
   */
  jobsText?: string | null;
  /** Most items one call emits (default FEEDBACK_SUBMISSIONS_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Fold — the digest's own classification over the two local journals
// ---------------------------------------------------------------------------

/** The digest states that become work; the rest are window context. */
export type FeedbackSubmissionClass = 'action-required' | 'stalled';

export interface FeedbackSubmissionTally {
  /** Sanitized recorded text (a source or kind label, or 'unrecorded'). */
  text: string;
  count: number;
}

/** One emitted recurring outcome class: the submission fold plus journal tallies. */
export interface FeedbackSubmissionCell {
  cls: FeedbackSubmissionClass;
  /** Distinct submission job ids in the class inside the window. */
  submissions: number;
  /** Sorted distinct UTC days the submissions' last activity landed on. */
  days: string[];
  /** Up to MAX_PROMPT_EXAMPLES job ids, sorted — each already matched SAFE_SUBMISSION_ID. */
  examples: string[];
  /** Recorded journal source tallies, most frequent first ('unrecorded' for ledger-only rows). */
  sources: FeedbackSubmissionTally[];
  /** Recorded journal kind tallies, most frequent first ('unrecorded' for ledger-only rows). */
  kinds: FeedbackSubmissionTally[];
  /** Submissions whose fold recorded a PR url — opened work that did not hold. */
  withPr: number;
  /** ISO bounds of the class's submissions; null when none carried a usable timestamp (unreachable while a cell exists). */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the jobs ledger's bounded tail was truncated: tallies are a lower bound. */
  jobsLowerBound: boolean;
}

/** Window-wide state counts quoted inside every prompt — the honest denominator. */
export interface FeedbackSubmissionsWindow {
  /** Dated submissions inside the window. */
  total: number;
  /** Submissions with no usable timestamp — excluded from every count. */
  undated: number;
  /** Digest state 'queued' inside the window (stalled is a subset of this). */
  queued: number;
  /** Digest state 'under-review' inside the window. */
  underReview: number;
  /** Digest state 'action-required' inside the window. */
  actionRequired: number;
  /** Digest states 'merged' or 'shipped' inside the window ('shipped' unreachable without gh). */
  merged: number;
  /** 'queued' submissions aged past the stall grace inside the window. */
  stalled: number;
  /** Per-adverse-class submission counts (classes with zero are absent). */
  adverse: Map<FeedbackSubmissionClass, number>;
}

/**
 * Pure: the class one in-window submission lands in, from the digest's
 * own state and recorded timestamps only. 'action-required' is the
 * digest's adverse verdict verbatim; 'stalled' requires the 'queued'
 * state AND a last-activity stamp at least the grace old — anything
 * less is context, never a guess.
 */
export function classifyFeedbackSubmission(
  submission: FeedbackSubmission,
  nowMs: number,
  graceMs: number,
): FeedbackSubmissionClass | null {
  if (submission.state === 'action-required') return 'action-required';
  if (submission.state === 'queued' && submission.at !== null) {
    const atMs = Date.parse(submission.at);
    if (Number.isFinite(atMs) && nowMs - atMs >= graceMs) return 'stalled';
  }
  return null;
}

function tallyOf(map: Map<string, number>, max: number): FeedbackSubmissionTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

/**
 * Pure: classify every dated in-window submission and keep the adverse
 * classes that meet the recurring bars. Sorted by submission count,
 * busiest class first; the window counts ride along so prompts quote
 * the whole denominator. `journal` maps job id → its admission row's
 * source/kind (absent for ledger-only submissions).
 */
export function feedbackSubmissionCells(
  submissions: readonly FeedbackSubmission[],
  journal: ReadonlyMap<string, { source: string | null; kind: string | null }>,
  nowMs: number,
  windowHours: number,
  graceMs: number,
  opts: { jobsLowerBound?: boolean } = {},
): { cells: FeedbackSubmissionCell[]; window: FeedbackSubmissionsWindow } {
  interface Acc {
    ids: Set<string>;
    days: Set<string>;
    firstMs: number;
    lastMs: number;
    examples: string[];
    sources: Map<string, number>;
    kinds: Map<string, number>;
    withPr: number;
  }
  const newAcc = (): Acc => ({
    ids: new Set(), days: new Set(), firstMs: Number.POSITIVE_INFINITY, lastMs: Number.NEGATIVE_INFINITY,
    examples: [], sources: new Map(), kinds: new Map(), withPr: 0,
  });
  const adverse = new Map<FeedbackSubmissionClass, Acc>();
  const windowCounts: FeedbackSubmissionsWindow = {
    total: 0, undated: 0, queued: 0, underReview: 0, actionRequired: 0, merged: 0, stalled: 0,
    adverse: new Map(),
  };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  const bump = (map: Map<string, number>, key: string): void => { map.set(key, (map.get(key) ?? 0) + 1); };

  for (const submission of submissions) {
    if (submission.at === null) {
      windowCounts.undated += 1;
      continue;
    }
    const atMs = Date.parse(submission.at);
    if (!Number.isFinite(atMs) || atMs < since || atMs > until) continue;
    windowCounts.total += 1;
    if (submission.state === 'queued') windowCounts.queued += 1;
    else if (submission.state === 'under-review') windowCounts.underReview += 1;
    else if (submission.state === 'action-required') windowCounts.actionRequired += 1;
    else windowCounts.merged += 1; // 'merged' or 'shipped' — both held work

    const cls = classifyFeedbackSubmission(submission, nowMs, graceMs);
    if (cls === 'stalled') windowCounts.stalled += 1;
    if (cls === null) continue;
    windowCounts.adverse.set(cls, (windowCounts.adverse.get(cls) ?? 0) + 1);
    if (!SAFE_SUBMISSION_ID.test(submission.job)) continue;
    let acc = adverse.get(cls);
    if (acc === undefined) {
      acc = newAcc();
      adverse.set(cls, acc);
    }
    acc.ids.add(submission.job);
    acc.days.add(dayOf(atMs));
    acc.firstMs = Math.min(acc.firstMs, atMs);
    acc.lastMs = Math.max(acc.lastMs, atMs);
    if (acc.examples.length < MAX_PROMPT_EXAMPLES && !acc.examples.includes(submission.job)) acc.examples.push(submission.job);
    const entry = journal.get(submission.job);
    bump(acc.sources, entry?.source !== null && entry?.source !== undefined && SUBMISSION_SOURCES.has(entry.source) ? entry.source : 'unrecorded');
    bump(acc.kinds, entry?.kind !== null && entry?.kind !== undefined && SUBMISSION_KINDS.has(entry.kind) ? entry.kind : 'unrecorded');
    if (submission.pr !== null) acc.withPr += 1;
  }

  const cells: FeedbackSubmissionCell[] = [];
  for (const [cls, acc] of adverse) {
    if (acc.ids.size < FEEDBACK_SUBMISSION_MIN_SUBMISSIONS || acc.days.size < FEEDBACK_SUBMISSION_MIN_DAYS) continue;
    cells.push({
      cls,
      submissions: acc.ids.size,
      days: [...acc.days].sort(),
      examples: [...acc.examples].sort(),
      sources: tallyOf(acc.sources, MAX_PROMPT_TALLIES),
      kinds: tallyOf(acc.kinds, MAX_PROMPT_TALLIES),
      withPr: acc.withPr,
      firstSeen: isoOrNull(Number.isFinite(acc.firstMs) ? acc.firstMs : null),
      lastSeen: isoOrNull(Number.isFinite(acc.lastMs) ? acc.lastMs : null),
      jobsLowerBound: opts.jobsLowerBound === true,
    });
  }
  cells.sort((a, b) => b.submissions - a.submissions || a.cls.localeCompare(b.cls));
  return { cells, window: windowCounts };
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const WINDOW_DAYS = Math.round(FEEDBACK_SUBMISSIONS_WINDOW_HOURS / 86_400_000);
const GRACE_DAYS = Math.round(FEEDBACK_STALLED_GRACE_HOURS / 24);
const daySpan = (first: number, last: number): number =>
  Math.max(1, Math.round((last - first) / 86_400_000));

const NO_CHANGE = 'If the window has rolled forward, the submissions\' jobs have since merged or are still legitimately in flight, the reports were a one-off intake rather than a recurring source, the failures were correct verdicts on invalid or already-fixed reports, or the cause is owner-only or pinned ops machinery (credentials, billing, the Security-reviewed launcher/dispatcher files under contrib/mac and ~/.ashlr-runs/bin) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is feedback/feedback-queued.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): `phm fleet feedback scan --apply` — run on its own cadence — folds github-issue, pr-comment, comms, ci-failure, revert and self-report signals through feedback-ingest.ts and feedback-triage.ts into RQ-PHX-FB<dedupe-hash> drop jobs, and recordFeedbackQueued appends one {at, job, source, ref, kind} row per admitted job. The outcome fold is feedbackDigest (src/core/fleet/feedback-cycle.ts) over metrics/jobs.jsonl — the same bounded tail `phm router outcomes` and the sibling backlog feeds read — assigning each submission queued, under-review, action-required, merged or shipped; `phm fleet feedback digest` prints that fold, and this feed is the same classification reaching the backlog — until now the digest was a report someone had to run and read.';

const truncationNote = (cell: FeedbackSubmissionCell): string =>
  cell.jobsLowerBound
    ? ' The jobs-ledger tail was truncated at the bounded read, so the outcome tallies cover only the retained window — a lower bound.'
    : '';

const tallyText = (tallies: readonly FeedbackSubmissionTally[]): string =>
  tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

/** The window denominator: every in-window submission's recorded state, so the cell never reads as the whole story. */
function windowText(window: FeedbackSubmissionsWindow): string {
  const parts = [
    `${window.underReview} under review`,
    `${window.merged} merged/held`,
    `${window.queued - window.stalled} still inside queue latency`,
  ];
  const adverse = [...window.adverse.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cls, n]) => `${n} ${cls}`);
  const undated = window.undated > 0 ? ` ${window.undated} submission(s) carried no usable timestamp and sit outside every count.` : '';
  return ` Inside the same window the feedback pipeline recorded ${window.total} dated submission(s); the recorded states were ${[...parts, ...adverse].join(', ')}.${undated}`;
}

const detailText = (cell: FeedbackSubmissionCell): string => {
  const parts: string[] = [];
  if (cell.examples.length > 0) parts.push(`Example job id(s): ${cell.examples.join(', ')}.`);
  if (cell.sources.length > 0) parts.push(`Recorded source(s): ${tallyText(cell.sources)}.`);
  if (cell.kinds.length > 0) parts.push(`Recorded kind(s): ${tallyText(cell.kinds)}.`);
  if (cell.withPr > 0) parts.push(`${cell.withPr} of the ${cell.submissions} submission(s) had recorded a PR url.`);
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`;
};

interface ClassMeta {
  title: string;
  /** The opening claim sentence — what keeps happening. */
  lead: string;
  /** The diagnostic paragraph: where to look and what this repo owns. */
  diagnose: string;
}

const CLASS_META: Record<FeedbackSubmissionClass, ClassMeta> = {
  'action-required': {
    title: 'Community feedback jobs keep ending action-required',
    lead: 'Phantom\'s community feedback pipeline keeps admitting outside reports whose jobs then fail, give up, get gate-declined, finish without an outcome or close unmerged — the fleet tries and does not hold.',
    diagnose: `Each row is a submission whose job reached the digest's action-required state: a launch_failed give_up, a precheck/dupcheck decline, a finish with no outcome, or a CLOSED resolution. Trace the example job ids through metrics/jobs.jsonl — the recorded failure class, exit, PR url and outcome phase — then decide which side is broken: the reported issue itself (invalid, already fixed, not actionable — a triage gap in feedback-triage.ts), the drop-job spec the scan minted (prompt too thin, wrong lane/tier — feedback-cycle.ts's promptSeed), or the fleet machinery that ran it (a failure another sibling feed already names). Check whether the same request ref keeps getting re-admitted under fresh RQ-PHX-FB ids — the dedupe key lives in triageFeedback — and whether 'question' signals are being misrouted into jobs at all. Fix what lives in this repository — the triage kinds, the prompt seeds, the dedupe, or the failure the jobs share; if the reports were correctly rejected verdicts on noise — report no-change and name the evidence.`,
  },
  stalled: {
    title: 'Community feedback submissions keep stalling unresolved',
    lead: 'Phantom\'s community feedback pipeline keeps admitting outside reports that then sit unresolved past the queue-latency grace — work the fleet recorded but never got to.',
    diagnose: `Each row is a submission still in the digest's 'queued' state with last recorded activity at least ${GRACE_DAYS} days old: admitted to the drop-job queue but never launched, or launched and then silent with no finish, outcome or PR. Trace the example job ids stage by stage — the feedback-queued.jsonl admission row, the RQ-PHX-FB drop job in the queue directories, queue/router-queue.md and ready.tsv claim state, and every metrics/jobs.jsonl row the id carries — to name where it stopped: waiting behind DROP_JOB_QUEUE_LIMIT or a full drop queue, deduped or SUPERSEDED-BY'd at import, claimed but never launched (the lost-launch feed's machinery), or launched and died without a finish row. Check whether intake exceeds drain — the scan admits up to FEEDBACK_CYCLE_LIMIT jobs per apply cycle — and whether stalled submissions cluster on one source or kind (the tallies name them). Fix the pipeline stage that starves or drops them in this repository; if the queue is merely backlogged behind legitimate fleet work — report no-change and name the evidence.`,
  },
};

function feedbackSubmissionPrompt(cell: FeedbackSubmissionCell, window: FeedbackSubmissionsWindow, repo: string): string {
  const meta = CLASS_META[cell.cls];
  const first = cell.firstSeen === null ? null : Date.parse(cell.firstSeen);
  const last = cell.lastSeen === null ? null : Date.parse(cell.lastSeen);
  const span = first !== null && last !== null ? ` (${daySpan(first, last)}-day span, first ${cell.firstSeen}, last ${cell.lastSeen})` : '';
  return [
    `${meta.lead} ${cell.submissions} submission(s) landed in this class inside the ${WINDOW_DAYS}-day window on ${repo}, the self-improvement work this backlog exists for.`,
    '',
    `The feedback journals recorded ${cell.submissions} distinct submission job id(s) in this class across ${cell.days.length} UTC day(s) (${daysText(cell.days)})${span}.${detailText(cell)}${windowText(window)}${truncationNote(cell)}`,
    '',
    EVIDENCE,
    '',
    meta.diagnose,
    '',
    `Run the affected suite (test/fleet-feedback.test.ts, test/improve-feedback-submissions-backlog.test.ts). ${NO_CHANGE}`,
  ].join('\n');
}

function feedbackSubmissionItem(cell: FeedbackSubmissionCell, window: FeedbackSubmissionsWindow, repo: string): CloudBacklogItem {
  return {
    id: `feedback-submissions-${cell.cls}-${sha(`feedback-submissions:${cell.cls}:${repo.toLowerCase()}`)}`,
    title: `${CLASS_META[cell.cls].title} on ${repo}`.slice(0, MAX_TITLE_CHARS),
    prompt: feedbackSubmissionPrompt(cell, window, repo),
    area: 'feedback-submissions',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the community feedback pipeline's recurring adverse
 * submission classes. Total: any read or fold failure yields no items
 * rather than throwing into discovery — and a withheld jobs ledger
 * yields none either, since the feed IS the outcome comparison.
 */
export async function feedbackSubmissionsBacklogItems(
  opts: FeedbackSubmissionsItemsOptions,
): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling feeds apply: explicit dir, then a
    // non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env value is
    // no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? FEEDBACK_SUBMISSIONS_WINDOW_HOURS;
    const graceMs = (opts.stalledGraceHours ?? FEEDBACK_STALLED_GRACE_HOURS) * 3_600_000;

    // The jobs ledger is not enrichment here — it IS the evidence. A
    // withheld or unreadable ledger leaves every submission 'queued',
    // so the source stays quiet rather than emitting cells it cannot
    // prove; a genuinely absent ledger is the same unknown, never an
    // empty success.
    let jobsText: string;
    let jobsLowerBound = false;
    if (opts.jobsText !== undefined) {
      if (opts.jobsText === null) return [];
      jobsText = opts.jobsText;
    } else {
      const tail = await readLedgerTail(join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE), FEEDBACK_JOBS_TAIL_BYTES);
      if (tail.state !== 'read') return [];
      jobsText = tail.text;
      jobsLowerBound = tail.truncated === true;
    }

    // The admission journal degrades exactly like the digest's own
    // read: 'ok' contributes entries, missing or unavailable
    // contributes none — ledger-only FB rows still fold, unattributed.
    let queuedEntries: readonly FeedbackQueuedEntry[] | null;
    if (opts.queuedEntries !== undefined) {
      queuedEntries = opts.queuedEntries;
    } else {
      const read = await readFeedbackQueued(runsDir);
      queuedEntries = read.state === 'ok' ? read.entries : null;
    }

    // The digest's own fold, with an empty shipped set: its gh-verified
    // 'shipped' refinement needs the ingest's network reads this feed
    // never makes, so a ledger MERGED honestly stays 'merged' —
    // non-adverse either way.
    const digest = feedbackDigest(
      { signals: [], open: [], shipped: [], sources: {}, coverageComplete: false },
      jobsText,
      nowMs,
      queuedEntries,
    );
    if (digest.submissions.length === 0) return [];

    const journal = new Map<string, { source: string | null; kind: string | null }>();
    for (const entry of queuedEntries ?? []) journal.set(entry.job, { source: entry.source, kind: entry.kind });

    const { cells, window } = feedbackSubmissionCells(
      digest.submissions, journal, nowMs, windowHours, graceMs, { jobsLowerBound },
    );
    const limit = Math.max(1, Math.min(opts.limit ?? FEEDBACK_SUBMISSIONS_BACKLOG_MAX_ITEMS, FEEDBACK_SUBMISSIONS_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => feedbackSubmissionItem(cell, window, repo));
  } catch {
    return [];
  }
}
