/**
 * Gap-proposal recurrence → self-improvement backlog items.
 *
 * `phm jobs gaps --propose` — run by the fleet self-tick's autofill harvest
 * (autofill-run.ts harvestGaps → readJobGaps) — turns the "remaining gaps"
 * finished jobs write into BRIDGE_NOTES.md into new drop jobs, and appends
 * one {at, id, title, repo} row per successful queue write to
 * metrics/gap-proposed.jsonl under the fleet runs directory
 * (gap-proposal-record.ts). The dedupe that guards re-proposal is
 * deliberately narrow: the same work is skipped only inside a 24-hour
 * proposal window, while queued or ingested, within 14 days of a recorded
 * merge, or against open ideas — after that the same gap can be queued
 * again. Until now the journal's only readers were that 24-hour dedupe
 * and `phm doctor supply`'s proposed count — a report someone had to run.
 * A gap whose job keeps being queued, launched and finished without the
 * work holding — empty already_done finishes, failed or aborted attempts,
 * launches that never happen — gets re-proposed on later ticks forever,
 * each cycle burning a launch slot on work the fleet already tried, and
 * nothing ever noticed.
 * gapProposalBacklogItems carries the same rows into discoverBacklog: a
 * gap id the proposer keeps re-queueing across distinct UTC days is
 * self-diagnosed intake-quality work that never became a backlog item.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. metrics/gap-proposed.jsonl is read once through
 *    readLedgerTail's bounded no-follow tail and metrics/jobs.jsonl
 *    through the same ROUTER_OUTCOME_LEDGER_LIMIT window the router
 *    outcome fold reads; nothing is written and no network is touched.
 *    A missing or unreadable proposal journal yields no items; a
 *    withheld jobs ledger degrades the outcome tallies to unknown
 *    rather than suppressing the proposal evidence or zero-filling it.
 *  - Rows count only under the writer's contract: JSON objects with a
 *    parseable `at`, a bounded safe `id`, a non-empty `title` and an
 *    optional `repo` — the same shape readGapProposals validates.
 *    Malformed lines, undated or future-dated rows and unsafe ids are
 *    skipped, never guessed.
 *  - Recurring means recorded across days: a gap id emits only at
 *    GAP_PROPOSAL_MIN_PROPOSALS recorded queue writes across
 *    GAP_PROPOSAL_MIN_DAYS distinct UTC days inside the 7-day window —
 *    the fleet's RECURRING_FAILURES convention the sibling feeds apply.
 *    The id is the proposer's deterministic content key
 *    (gapJobId = 'GAP' + sha256(normalizeTitle(title))[:10] uppercased),
 *    so the same gap text always lands in the same cell.
 *  - Outcome evidence joins, never gates: each proposal id maps to the
 *    queue job id `RQ-PHX-<id>`; the jobs-ledger tail folds that job's
 *    launches, finishes (empty or not), PR publishes, aborts and
 *    resolved outcome states inside the same window so the prompt can
 *    say whether prior attempts landed, never launched or kept
 *    finishing empty. Tallies quote only what the retained tail
 *    recorded — truncation is stated as a lower bound.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository — the same last-segment rule the sibling
 *    fleet-evidence sources apply — since the proposer, its dedupe and
 *    the drop queue are this install's machinery. Dedup is downstream:
 *    the item id hashes the gap id only, never the tallies or
 *    timestamps, so a refresh re-derives the same id and a gap that
 *    stops recurring simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { GAP_PROPOSAL_RECORD } from '../fleet/gap-proposal-record.js';
import { ledgerPhase, ledgerPrUrl, ledgerStateTokens } from '../fleet/empty-cause.js';
import {
  isNodePoolLedgerRow,
  ledgerEventTs,
  ledgerJobId,
  ledgerLifecycleEvent,
  ledgerOutcomeState,
} from '../fleet/jobs-ledger-dialect.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_LIMIT, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; recurring gap ids are a small set by construction. */
export const GAP_PROPOSAL_BACKLOG_MAX_ITEMS = 8;
const GAP_PROPOSAL_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const GAP_PROPOSAL_WINDOW_HOURS = 168;
/** A gap id emits only at this many recorded queue writes inside the window... */
export const GAP_PROPOSAL_MIN_PROPOSALS = 3;
/** ...across at least this many distinct UTC days. */
export const GAP_PROPOSAL_MIN_DAYS = 2;
/**
 * Bounded tail of the append-only proposal journal — far past the
 * writer's own 1 MiB dedupe read, so the fold sees the whole 7-day
 * window even on a busy install; prompts state any truncation as a
 * lower bound.
 */
const GAP_PROPOSAL_TAIL_BYTES = 4 * 1024 * 1024;
/** The jobs ledger shares the router outcome fold's bounded tail. */
const GAP_PROPOSAL_JOBS_TAIL_BYTES = ROUTER_OUTCOME_LEDGER_LIMIT;
/** The fleet's own repository label: proposal evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Proposal ids are ledger-recorded text; the same bounded shape the sibling jobs-ledger readers enforce. */
const SAFE_PROPOSAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Queue job ids the proposer mints: RQ-PHX- plus the bare GAP… proposal id. */
const GAP_JOB_ID = /^RQ-PHX-GAP[A-Z0-9]{1,64}$/;
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on ledger timestamps. */
const SKEW_MS = 300_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 120;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;
/** Recorded repo tallies quoted inside one prompt. */
const MAX_PROMPT_REPOS = 4;

export interface GapProposalItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/gap-proposed.jsonl and metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default GAP_PROPOSAL_WINDOW_HOURS). */
  windowHours?: number;
  /** Proposal journal override (default: <runsDir>/metrics/gap-proposed.jsonl). */
  proposalsPath?: string;
  /** Jobs ledger override (default: <runsDir>/metrics/jobs.jsonl). */
  jobsPath?: string;
  /** Injected proposal journal text (tests); skips the journal read when set — null means missing. */
  proposalsText?: string | null;
  /** Injected jobs-ledger text (tests); skips the ledger read when set — null means withheld. */
  jobsText?: string | null;
  /** Most items one call emits (default GAP_PROPOSAL_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Ledger-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Fold — the proposal journal and the jobs-ledger outcome join
// ---------------------------------------------------------------------------

/** Per-gap-id in-window fold before the recurring bars apply. */
export interface GapProposalGapFold {
  id: string;
  /** Recorded queue writes inside the window — each is one re-queue of the same gap job. */
  proposals: number;
  /** Distinct UTC days the writes landed on. */
  days: Set<string>;
  firstMs: number | null;
  lastMs: number | null;
  /** The newest recorded title (untrusted text, still raw — fieldText at prompt time). */
  title: string;
  /** Repo tallies across the cell's rows ('unrecorded' when the writer omitted repo). */
  repos: Map<string, number>;
}

export interface GapProposalFold {
  /** gap id → in-window fold. */
  gaps: Map<string, GapProposalGapFold>;
  /** Non-blank lines that were not JSON objects. */
  malformed: number;
}

/**
 * Pure: fold one proposal-journal tail into per-gap-id proposal counts.
 * Only rows inside the window count; malformed JSON, rows failing the
 * writer's contract (missing/bad id or title, unparseable or
 * future-dated `at`) and unsafe ids are skipped, never guessed.
 */
export function foldGapProposalJournal(text: string, nowMs: number, windowHours: number): GapProposalFold {
  const fold: GapProposalFold = { gaps: new Map(), malformed: 0 };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { fold.malformed++; continue; }
    if (!isRecord(row)) { fold.malformed++; continue; }
    const id = row['id'];
    const title = row['title'];
    const at = row['at'];
    if (typeof id !== 'string' || !SAFE_PROPOSAL_ID.test(id)) continue;
    if (typeof title !== 'string' || title.trim() === '') continue;
    if (typeof at !== 'string') continue;
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs) || atMs < since || atMs > until) continue;
    const repo = row['repo'];
    let cell = fold.gaps.get(id);
    if (cell === undefined) {
      cell = { id, proposals: 0, days: new Set(), firstMs: null, lastMs: null, title: title.trim(), repos: new Map() };
      fold.gaps.set(id, cell);
    }
    cell.proposals += 1;
    cell.days.add(dayOf(atMs));
    // The newest write (max at; append order breaks ties) supplies the quoted title.
    if (cell.lastMs === null || atMs >= cell.lastMs) cell.title = title.trim();
    cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
    cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
    const repoKey = typeof repo === 'string' && repo.trim() !== '' ? fieldText(repo, MAX_NAME_CHARS) || 'unrecorded' : 'unrecorded';
    cell.repos.set(repoKey, (cell.repos.get(repoKey) ?? 0) + 1);
  }
  return fold;
}

/** Recorded outcome tallies for one gap job inside the window — every count is ledger-recorded, never inferred. */
export interface GapJobTally {
  launches: number;
  finishes: number;
  /** Finishes or publishes that ended the job with no change (empty:true, EMPTY_DONE, publish class 'empty'). */
  emptyFinishes: number;
  /** Publish rows claiming a PR (class 'pr' or carrying a PR url). */
  prs: number;
  /** Publish rows whose class starts with 'abort'. */
  aborts: number;
  /** Resolved outcome states: MERGED verdicts, CLOSED verdicts and every other resolved phase. */
  merged: number;
  closed: number;
  resolvedOther: number;
}

const emptyTally = (): GapJobTally => ({ launches: 0, finishes: 0, emptyFinishes: 0, prs: 0, aborts: 0, merged: 0, closed: 0, resolvedOther: 0 });

/**
 * Pure: fold one jobs-ledger tail into per-gap-job outcome tallies.
 * Only rows for `RQ-PHX-GAP*` job ids inside the window count;
 * node-pool producer schemas, malformed lines, unsafe job ids and
 * undated rows are skipped, never guessed.
 */
export function foldGapJobOutcomes(text: string, nowMs: number, windowHours: number): Map<string, GapJobTally> {
  const out = new Map<string, GapJobTally>();
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  for (const line of text.split('\n')) {
    // Cheap prefilter: gap jobs are a small minority of the ledger's rows.
    if (!line.includes('RQ-PHX-GAP')) continue;
    if (!line.trim()) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!isRecord(row)) continue;
    if (isNodePoolLedgerRow(row)) continue;
    const job = ledgerJobId(row);
    if (job === null || !GAP_JOB_ID.test(job)) continue;
    const phase = ledgerPhase(row);
    const atMs = ledgerEventTs(row, phase);
    if (atMs === null || atMs < since || atMs > until) continue;
    const event = ledgerLifecycleEvent(row, phase);
    let tally = out.get(job);
    if (tally === undefined) {
      tally = emptyTally();
      out.set(job, tally);
    }
    if (event === 'launch') {
      tally.launches += 1;
      continue;
    }
    if (event === 'finish') {
      tally.finishes += 1;
      if (row['empty'] === true || ledgerStateTokens(row).includes('EMPTY_DONE')) tally.emptyFinishes += 1;
    } else if (event === 'publish') {
      // The slot-yield publish convention: class 'pr' or an unclassified
      // row carrying a PR url is a PR claim; 'empty' ends the job with no
      // change; 'abort*' is an aborted attempt; anything else records no
      // publish verdict and is skipped, never guessed.
      const kind = typeof row['class'] === 'string' ? row['class'].trim().toLowerCase() : '';
      if (kind === 'empty') tally.emptyFinishes += 1;
      else if (kind.startsWith('abort')) tally.aborts += 1;
      else if (kind === 'pr' || ((kind === '' || kind === 'unknown') && ledgerPrUrl(row) !== null)) tally.prs += 1;
    }
    const state = ledgerOutcomeState(row, event, phase);
    if (state === 'MERGED') tally.merged += 1;
    else if (state === 'CLOSED') tally.closed += 1;
    else if (state !== null) tally.resolvedOther += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface GapProposalTally {
  /** Sanitized recorded text (a repo label). */
  text: string;
  count: number;
}

/** One emitted recurring gap: the proposal fold plus the joined job tallies. */
export interface GapProposalCell {
  /** The proposer's deterministic gap id (GAP… — gapJobId's content hash). */
  id: string;
  /** The queue job id the proposals minted: RQ-PHX-<id>. */
  jobId: string;
  /** The newest recorded title, scrubbed and capped. */
  title: string;
  /** Recorded queue writes inside the window. */
  proposals: number;
  /** Sorted distinct UTC days the writes landed on. */
  days: string[];
  /** Recorded repo tallies ('unrecorded' when the writer omitted repo), most frequent first. */
  repos: GapProposalTally[];
  /** Joined jobs-ledger tallies for RQ-PHX-<id>; null when the ledger was withheld. */
  jobs: GapJobTally | null;
  /** ISO bounds of the cell's proposal writes; null when none carried a usable timestamp (unreachable while a cell exists). */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the proposal journal's bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
  /** True when the jobs ledger's bounded tail was truncated: job tallies are a lower bound. */
  jobsLowerBound: boolean;
}

function tallyOf(map: Map<string, number>, max: number): GapProposalTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

/**
 * Pure: recurring re-proposal cells — a gap id recorded often enough
 * across enough distinct UTC days inside the window. Sorted by proposal
 * count, the most-requeued gap first.
 */
export function gapProposalCells(
  fold: GapProposalFold,
  jobs: ReadonlyMap<string, GapJobTally> | null,
  opts: { lowerBound?: boolean; jobsLowerBound?: boolean } = {},
): GapProposalCell[] {
  const cells: GapProposalCell[] = [];
  for (const cell of fold.gaps.values()) {
    if (cell.proposals < GAP_PROPOSAL_MIN_PROPOSALS || cell.days.size < GAP_PROPOSAL_MIN_DAYS) continue;
    cells.push({
      id: cell.id,
      jobId: `RQ-PHX-${cell.id}`,
      title: fieldText(cell.title, MAX_NAME_CHARS),
      proposals: cell.proposals,
      days: [...cell.days].sort(),
      repos: tallyOf(cell.repos, MAX_PROMPT_REPOS),
      jobs: jobs === null ? null : (jobs.get(`RQ-PHX-${cell.id}`) ?? emptyTally()),
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      lowerBound: opts.lowerBound === true,
      jobsLowerBound: opts.jobsLowerBound === true,
    });
  }
  return cells.sort((a, b) => b.proposals - a.proposals || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is metrics/gap-proposed.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): `phm jobs gaps --propose` — run by the fleet self-tick\'s autofill harvest (autofill-run.ts harvestGaps → readJobGaps in src/core/fleet/job-gaps.ts) — appends one {at, id, title, repo} row per successful drop-job write through gap-proposal-record.ts, where id is the deterministic content key gapJobId = \'GAP\' + sha256(normalizeTitle(title))[:10] and the queue job id is RQ-PHX-<id>. The dedupe that guards re-proposal skips the same work only inside a 24-hour proposal window, while queued or ingested, within 14 days of a recorded merge, or against open ideas — after that the same gap can be queued again. The journal\'s only other readers are that 24-hour dedupe and `phm doctor supply`\'s proposed count. The outcome join reads metrics/jobs.jsonl through the same bounded tail `phm jobs yield --by source`, `phm router outcomes` and the router outcome fold use: launches, finishes (empty or not), PR publishes, aborts and resolved outcome states for each RQ-PHX-GAP* job inside the same window.';

const NO_CHANGE = 'If the window has rolled forward, the re-queues were legitimate re-discovery of a gap that genuinely recurs (a regression the fleet should keep fixing), every recorded attempt landed its PR and merged, or the cause is pinned ops machinery, host state or owner-only — report no-change and name the evidence.';

const tallyText = (tallies: readonly GapProposalTally[]): string =>
  tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (cell: GapProposalCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` First recorded ${cell.firstSeen}.`
    : ` First recorded ${cell.firstSeen}, last ${cell.lastSeen}.`;
};

/** The jobs-ledger sentence: recorded tallies, or the withheld-evidence wording — never a zero guess. */
function jobsText(cell: GapProposalCell): string {
  const jobs = cell.jobs;
  if (jobs === null) {
    return ' The jobs ledger was unavailable, so whether the queued attempts launched, finished empty, merged or closed is unknown — not zero.';
  }
  const parts = [
    `${jobs.launches} launch(es)`,
    `${jobs.finishes} finish(es)`,
    `${jobs.emptyFinishes} empty finish(es)/publish(es)`,
    `${jobs.prs} PR publish(es)`,
    `${jobs.aborts} abort(s)`,
    `${jobs.merged} MERGED outcome(s)`,
    `${jobs.closed} CLOSED outcome(s)`,
    `${jobs.resolvedOther} other resolved outcome(s)`,
  ];
  return ` Inside the same window the jobs ledger recorded for ${cell.jobId}: ${parts.join(', ')}.${cell.jobsLowerBound ? ' The jobs-ledger tail was truncated at the bounded read, so these tallies cover only the retained window — a lower bound, not the full window.' : ''}`;
}

function gapProposalPrompt(cell: GapProposalCell): string {
  const title = cell.title === '' ? '(untitled)' : `'${cell.title}'`;
  const repos = cell.repos.length === 0 ? '' : ` Recorded drop-queue repos: ${tallyText(cell.repos)}.`;
  return [
    `Phantom's gap self-supply keeps re-queueing the same work — gap ${cell.id} (${title}) was written to the drop queue ${cell.proposals} times inside the window across ${cell.days.length} UTC day(s) (${daysText(cell.days)}), the self-improvement work this backlog exists for.`,
    '',
    `Each recorded row is one successful writeDropJob of the same deterministic gap job ${cell.jobId}: the proposer's dedupe let the same gap through again, which means every earlier attempt finished or left the queue without the 14-day recent-merge, queued, ingested or open-idea guards still holding it.${repos}${seenText(cell)}${jobsText(cell)}`,
    cell.lowerBound ? ' The proposal journal tail was truncated at the bounded read, so the proposal count covers only the retained window — a lower bound, not the full window.' : '',
    '',
    EVIDENCE,
    '',
    `Find out why this gap keeps coming back unsatisfied: check what ${cell.jobId} actually did — the 'phm jobs yield' and 'phm jobs empty' folds over metrics/jobs.jsonl, the job's own log and BRIDGE_NOTES — and which dedupe leg failed to hold. An empty already_done finish means the gap extraction (extractAllGaps over BRIDGE_NOTES.md, the sameWork title match, recentMergeTitles) is minting work master already has; a failed or aborted attempt means the minted prompt or acceptance is wrong; launches that never happened point at the queue or dispatch path; a merged attempt that still re-proposed points at merge attribution the dedupe cannot see. Fix the cause in this repository — the proposer, its dedupe sources, the gap extraction or the queue path — not the symptom.`,
    '',
    `Run the affected suite (test/jobs-gaps.test.ts, test/gap-landing.test.ts). ${NO_CHANGE}`,
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
}

function gapProposalItem(cell: GapProposalCell, repo: string): CloudBacklogItem {
  const title = cell.title === '' ? cell.id : cell.title;
  const short = title.length > 80 ? `${title.slice(0, 79)}…` : title;
  return {
    id: `gap-proposal-${sha(`gap-proposal:${cell.id}`)}`,
    title: `Self-supply keeps re-queueing gap '${fieldText(short, MAX_NAME_CHARS)}'`.slice(0, MAX_TITLE_CHARS),
    prompt: gapProposalPrompt(cell),
    area: 'gap-proposal',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the gap proposer's recurring re-queue evidence.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function gapProposalBacklogItems(opts: GapProposalItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling feeds apply: explicit dir, then a
    // non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env value is
    // no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? GAP_PROPOSAL_WINDOW_HOURS;

    // The proposal journal is the primary evidence: missing or unreadable
    // means there is nothing to fold — never a fabricated recurrence.
    let proposalsText: string | null;
    let proposalsLowerBound = false;
    if (opts.proposalsText !== undefined) {
      proposalsText = opts.proposalsText;
    } else {
      const path = opts.proposalsPath ?? join(runsDir, 'metrics', GAP_PROPOSAL_RECORD);
      const tail = await readLedgerTail(path, GAP_PROPOSAL_TAIL_BYTES);
      if (tail.state !== 'read') return [];
      proposalsText = tail.text;
      proposalsLowerBound = tail.truncated === true;
    }
    if (proposalsText === null) return [];
    const fold = foldGapProposalJournal(proposalsText, nowMs, windowHours);
    if (fold.gaps.size === 0) return [];

    // The jobs-ledger join is enrichment: withheld evidence degrades the
    // tallies to unknown, it never suppresses the proposal recurrence.
    let jobs: Map<string, GapJobTally> | null = null;
    let jobsLowerBound = false;
    if (opts.jobsText !== undefined) {
      jobs = opts.jobsText === null ? null : foldGapJobOutcomes(opts.jobsText, nowMs, windowHours);
    } else {
      const path = opts.jobsPath ?? join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
      const tail = await readLedgerTail(path, GAP_PROPOSAL_JOBS_TAIL_BYTES);
      if (tail.state === 'read') {
        jobs = foldGapJobOutcomes(tail.text, nowMs, windowHours);
        jobsLowerBound = tail.truncated === true;
      }
    }

    const cells = gapProposalCells(fold, jobs, { lowerBound: proposalsLowerBound, jobsLowerBound });
    const limit = Math.max(1, Math.min(opts.limit ?? GAP_PROPOSAL_BACKLOG_MAX_ITEMS, GAP_PROPOSAL_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => gapProposalItem(cell, repo));
  } catch {
    return [];
  }
}
