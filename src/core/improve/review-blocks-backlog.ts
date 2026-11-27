/**
 * Nightly retro review-block journal → self-improvement backlog items.
 *
 * ~/.ashlr/learn/retro-input/review-blocks.jsonl is the local evidence
 * feed's second output (src/core/learn/retro/feed.ts): once per due
 * night, ensureNightlyInputs folds every durable local outcome source
 * into contract rows and merges them latest-per-(repo,id) into the
 * input file runNightlyRetro reads inside the state lock. Its review
 * rows come from foldCloudTasks — one row per cloud task whose
 * recorded terminal GitHub outcome shows a reviewer asked for changes
 * (outcome.reviewDecision 'CHANGES_REQUESTED' or outcome.changesRequested
 * > 0, the tracker fields cloud/tracker.ts records at the terminal
 * transition) — plus any rows external producers merge through the same
 * validation. Devin tasks contribute jobs but never review rows: the
 * Devin tracker records no GitHub outcome, so the journal's coverage is
 * the cloud seat lane by the producer's own scope rule. A row is
 * {v:1, id, jobId, repo, kind:'review-block', updatedAt, body} — the
 * body the tracker's bounded factual verdict summary ("Recorded GitHub
 * review verdict with N recorded change requests on owner/repo#PR at
 * head <sha12>."), never review prose.
 *
 * Until now the journal's only reader was readNightlyInputs inside
 * runNightlyRetro — the rows become retro lessons and knowledge
 * candidates (prompt-level advice), never work items. A repository
 * whose cloud-seat pull requests keep coming back CHANGES_REQUESTED is
 * outcome evidence the improvement loop has never folded: the fleet's
 * own ledgers record job-level dispatch state, the outside-PR feed
 * covers merged-then-reverted community heads, and the reward fold
 * records merge verdicts — none of them sees that review keeps bouncing
 * the cloud lane's PRs before merge. This feed folds that gap.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The file is read once through readLedgerTail's bounded
 *    no-follow tail; nothing is written and no network is touched. A
 *    missing file yields no items — the producer has not run a due
 *    night yet or recorded no blocks, a clean empty source, not a
 *    guess; an unreadable or non-file journal yields no items either.
 *  - Rows count only under the writer's contract: v:1, kind
 *    'review-block', id and jobId matching the retro identifier
 *    pattern, repo matching the retro owner/name pattern, a canonical
 *    ISO updatedAt (the producer's own timestamp round-trip), and a
 *    body string within the producer's 16 KiB bound. Malformed lines
 *    and off-contract rows are counted, never guessed. The fold
 *    dedupes on (repo,id) keeping the latest updatedAt — the same
 *    merge the producer applies — so a replayed or hand-duplicated
 *    row folds once.
 *  - Recurring means recorded across days. A repo cell emits only at
 *    REVIEW_BLOCK_MIN_ROWS distinct review-block rows inside the
 *    retained 7-day window spanning REVIEW_BLOCK_MIN_DAYS distinct UTC
 *    days — one bounced PR is an incident, not a pattern.
 *  - The journal is rewritten atomically each due night, never
 *    appended; a truncated tail read or ignored lines make every
 *    count a recorded floor ("at least"), stated in the prompts.
 *  - Items self-target the repository the evidence names — the blocked
 *    PRs live there, so the fix (review bars, CONTRIBUTING expectations,
 *    CI gates for fleet heads, or the cloud prompt template when blocks
 *    span repos) is investigated where the verdicts landed, the
 *    outside-pr feed's own convention. Dedup is downstream: item ids
 *    hash the repo identity, never counts or timestamps, so a refresh
 *    re-derives the same id.
 *  - No row content beyond the contract fields is ever emitted: ids
 *    and jobIds are counted never quoted, bodies are never read into
 *    prompts, repo labels pass the same scrub-and-cap the sibling
 *    feeds apply, and every prompt string is a fixed literal.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { cleanText, RETRO_ID_PATTERN, RETRO_REPO_PATTERN } from '../learn/retro/store.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; repo cells stay well under this. */
export const REVIEW_BLOCKS_BACKLOG_MAX_ITEMS = 8;
const REVIEW_BLOCKS_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const REVIEW_BLOCKS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on row timestamps, the sibling folds' convention. */
const REVIEW_BLOCKS_FUTURE_SKEW_MS = 60_000;
/** Review-block rows a repo needs before its recurrence counts. */
export const REVIEW_BLOCKS_MIN_ROWS = 3;
/** Distinct UTC days those rows must span — recurring means recorded across days. */
export const REVIEW_BLOCKS_MIN_DAYS = 2;
/**
 * Bounded tail of the journal; the producer's own NIGHTLY_MAX_BYTES cap
 * (8 MiB, src/core/learn/retro/store.ts) bounds the file it rewrites,
 * so this covers the whole retained input and truncation is stated,
 * never silent.
 */
export const REVIEW_BLOCKS_TAIL_BYTES = 8 * 1024 * 1024;
/**
 * The producer's REVIEW_BODY_MAX (src/core/learn/retro/feed.ts): an
 * input row's body is the bounded factual verdict summary, capped at
 * 16 KiB. The fold validates the bound but never reads the text.
 */
const REVIEW_BLOCK_BODY_MAX = 16_384;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Repo labels are bounded identifier strings; scrub and cap defensively before display. */
const MAX_REPO_CHARS = 200;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;

export interface ReviewBlocksBacklogOptions {
  /** Home the default journal resolves under — mirrors learnHome()'s homedir()/.ashlr (default: os.homedir()). */
  homeDir?: string;
  /** Journal path override (default: <homeDir>/.ashlr/learn/retro-input/review-blocks.jsonl). */
  journalPath?: string;
  /** Most items one call emits (default REVIEW_BLOCKS_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
  /** Window in ms (default REVIEW_BLOCKS_WINDOW_MS). */
  windowMs?: number;
}

/** One validated review-block row. `body` is contract-checked but never carried — prompts count, never quote. */
export interface ReviewBlockRow {
  /** The journal's own row identity (producer: 'cloud-review:<taskId>'). */
  id: string;
  /** The cloud task the verdict belongs to — the join key into the task store. */
  jobId: string;
  /** owner/repo the blocked PR targeted. */
  repo: string;
  /** The outcome's own clock: the tracker's observedAt, canonical ISO. */
  atMs: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The producer's nightlyIdentifier rule (extract.ts): the pattern bound
 * plus cleanText identity — an identifier the scrub would rewrite (a
 * secret-shaped substring, stray whitespace) is off-contract, not evidence.
 */
const retroIdentifier = (raw: unknown, repo = false): raw is string =>
  typeof raw === 'string' &&
  (repo ? RETRO_REPO_PATTERN : RETRO_ID_PATTERN).test(raw) &&
  cleanText(raw, 201) === raw;

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Pure: classify one parsed journal line against the producer's input
 * contract — the same fields parseExistingReviewInput/extractNightlyReview
 * (persisted=false) validates in src/core/learn/retro/. A valid row
 * carries v:1, kind 'review-block', pattern-bounded id/jobId/repo, a
 * canonical ISO updatedAt and a body string within the producer's
 * bound; anything else is off-contract evidence, counted by the caller.
 */
export function parseReviewBlockEntry(value: unknown): ReviewBlockRow | null {
  if (!isRecord(value)) return null;
  if (value['v'] !== 1 || value['kind'] !== 'review-block') return null;
  const id = value['id'];
  const jobId = value['jobId'];
  const repo = value['repo'];
  const updatedAt = value['updatedAt'];
  const body = value['body'];
  if (!retroIdentifier(id) || !retroIdentifier(jobId) || !retroIdentifier(repo, true)) return null;
  // The producer's own timestamp rule: parseable AND canonical —
  // new Date(ms).toISOString() round-trips only the exact spelling it emits.
  if (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt)) ||
      new Date(updatedAt).toISOString() !== updatedAt) return null;
  if (typeof body !== 'string' || body.length > REVIEW_BLOCK_BODY_MAX) return null;
  return { id, jobId, repo, atMs: Date.parse(updatedAt) };
}

/**
 * Pure: parse one journal file's text into validated review-block rows
 * plus the count of lines that were not on-contract rows — malformed
 * JSON and off-contract rows are counted, never guessed.
 */
export function parseReviewBlockText(text: string): {
  rows: ReviewBlockRow[];
  invalidRows: number;
} {
  const rows: ReviewBlockRow[] = [];
  let invalidRows = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      invalidRows += 1;
      continue;
    }
    const row = parseReviewBlockEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

/** One evidence cell's tally: every in-window review-block row on one repository. */
export interface ReviewBlockCell {
  /** Stable cell identity for item ids and dedupe: the owner/repo label. */
  key: string;
  repo: string;
  /** Distinct review-block row ids inside the window — the recurrence count. */
  rows: number;
  /** Distinct UTC days (of updatedAt) the rows fall on. */
  days: Set<string>;
  /** Distinct cloud task ids among the rows — counted, never emitted. */
  tasks: Set<string>;
  firstAtMs: number;
  lastAtMs: number;
}

/**
 * Pure: fold validated rows into per-repo review-block cells. Dedupe
 * runs before windowing on (repo,id) keeping the latest updatedAt —
 * the producer's own merge — so a stale duplicate cannot resurrect
 * evidence the newer row replaced; windowing is on the outcome's own
 * updatedAt clock; the recurring bars are applied here so callers see
 * only cells that cleared them.
 */
export function foldReviewBlockCells(
  rows: readonly ReviewBlockRow[],
  opts: { nowMs: number; windowMs?: number },
): ReviewBlockCell[] {
  const nowMs = opts.nowMs;
  const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
    ? opts.windowMs
    : REVIEW_BLOCKS_WINDOW_MS;
  const windowStart = nowMs - windowMs;
  const futureCeil = nowMs + REVIEW_BLOCKS_FUTURE_SKEW_MS;
  const latest = new Map<string, ReviewBlockRow>();
  for (const row of rows) {
    const key = `${row.repo}${row.id}`;
    const prior = latest.get(key);
    // Latest updatedAt wins, the producer's own merge; an exact tie keeps
    // the first row in file order — the producer refuses same-stamp
    // conflicting bytes outright, so a tie is unreachable corruption.
    if (prior === undefined || row.atMs > prior.atMs) latest.set(key, row);
  }
  const cells = new Map<string, ReviewBlockCell>();
  for (const row of latest.values()) {
    if (row.atMs < windowStart || row.atMs > futureCeil) continue;
    let cell = cells.get(row.repo);
    if (cell === undefined) {
      cell = {
        key: row.repo, repo: row.repo,
        rows: 0, days: new Set(), tasks: new Set(),
        firstAtMs: Infinity, lastAtMs: -Infinity,
      };
      cells.set(row.repo, cell);
    }
    cell.rows += 1;
    cell.days.add(utcDayOf(row.atMs));
    cell.tasks.add(row.jobId);
    cell.firstAtMs = Math.min(cell.firstAtMs, row.atMs);
    cell.lastAtMs = Math.max(cell.lastAtMs, row.atMs);
  }
  return [...cells.values()]
    .filter((cell) => cell.rows >= REVIEW_BLOCKS_MIN_ROWS && cell.days.size >= REVIEW_BLOCKS_MIN_DAYS)
    .sort((a, b) => b.rows - a.rows || b.lastAtMs - a.lastAtMs || a.key.localeCompare(b.key));
}

/** The evidence pointers every prompt shares; the writer, its store contract and its consumers are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is review-blocks.jsonl under ~/.ashlr/learn/retro-input — learnHome() in src/core/learn/retro/store.ts resolves homedir()/.ashlr/learn and the nightly feed (ensureNightlyInputs → feedReviewsInput in src/core/learn/retro/feed.ts) merges foldCloudTasks\' review rows plus any external producer rows latest-per-(repo,id) into it once per due night inside the retro state lock. foldCloudTasks emits one row per cloud task whose recorded terminal outcome shows outcome.reviewDecision \'CHANGES_REQUESTED\' or outcome.changesRequested > 0 — the fields cloud/tracker.ts records at the terminal transition — with jobId the cloud task id, repo the task\'s owner/name target, updatedAt the outcome\'s observedAt, and body the bounded factual verdict summary (never review prose). Devin tasks fold jobs but never review rows: the Devin tracker records no GitHub outcome. Until this feed the journal\'s only reader was readNightlyInputs inside runNightlyRetro, which turns the rows into retro lessons — prompt-level advice, never work items.';

const NO_CHANGE = 'If the journal is absent because no due night has run inside the window, every counted block traces to a designed stop the journal cannot distinguish (a task superseded by its fleet PR reports through the fleet ledgers instead, and a Devin task never produces a row), the cloud seat lane was retired or re-prompted since, the recorded window no longer reproduces on the default branch, or the blocks are owner-only causes (protected paths, billing, host capacity) — report no-change and name the evidence.';

function coverageNote(truncated: boolean, invalidRows: number): string {
  const notes: string[] = [];
  if (truncated) notes.push('the bounded tail dropped older rows, so every count is a lower bound');
  if (invalidRows > 0) notes.push(`${invalidRows} malformed or off-contract lines dropped`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function spanText(cell: ReviewBlockCell): string {
  if (!Number.isFinite(cell.firstAtMs) || !Number.isFinite(cell.lastAtMs)) return '';
  const first = new Date(cell.firstAtMs).toISOString();
  const last = new Date(cell.lastAtMs).toISOString();
  return first === last ? ` Recorded ${first}.` : ` Recorded ${first} through ${last}.`;
}

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

function cellTitle(cell: ReviewBlockCell, truncated: boolean): string {
  const lead = truncated ? 'at least ' : '';
  return `Cloud tasks on ${cell.repo} keep hitting GitHub review blocks — ${lead}${cell.rows} recorded block(s) across ${cell.days.size} day(s)`.slice(0, MAX_TITLE_CHARS);
}

function cellPrompt(cell: ReviewBlockCell, truncated: boolean, invalidRows: number): string {
  const repo = scrubSecrets(cell.repo).slice(0, MAX_REPO_CHARS);
  const bound = truncated ? 'at least ' : '';
  const days = [...cell.days].sort();
  return [
    `The nightly retro's review-block journal shows recorded GitHub review verdicts keep blocking cloud tasks on ${repo} — ${bound}${cell.rows} review-block row(s) from ${cell.tasks.size} distinct task(s) inside the 7-day window across ${cell.days.size} distinct UTC day(s) (${daysText(days)}), the self-improvement work this backlog exists for.`,
    '',
    `Each row is one cloud task whose terminal outcome the tracker recorded as a reviewer asking for changes — reviewDecision 'CHANGES_REQUESTED' or at least one recorded change request — so these are PRs that never merged, not post-merge reverts. ${spanText(cell)}${coverageNote(truncated, invalidRows)}`,
    '',
    `Find why review keeps bouncing this repo's cloud-lane PRs: each row's jobId is the cloud task id — join the rows against the cloud task store (~/.ashlr/cloud/tasks, listCloudTasks in src/cloud/store.ts) for the seat, playbook ref, PR number, head sha and the task's own report, then check whether blocks cluster on one seat/arm, one playbook, one repo area or one reviewer expectation. Check the repo's review surface — CONTRIBUTING, CI bars, AGENTS.md/CLAUDE.md conventions a fleet PR must satisfy — and, when blocks span repos rather than clustering here, the cloud task prompt template in src/core/cloud/service.ts. Fix the cause in this repository rather than muting the evidence. ${NO_CHANGE}`,
    '',
    EVIDENCE,
  ].join('\n');
}

function reviewBlockItem(
  cell: ReviewBlockCell,
  truncated: boolean,
  invalidRows: number,
): CloudBacklogItem {
  return {
    id: `review-block-${createHash('sha256').update(`review-block:${cell.repo}`).digest('hex').slice(0, 16)}`,
    title: cellTitle(cell, truncated),
    prompt: cellPrompt(cell, truncated, invalidRows),
    area: 'review-blocks',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(cell.repo) ? { repo: cell.repo } : {}),
  };
}

/**
 * Backlog items for repos whose cloud tasks keep hitting recorded GitHub
 * review blocks. Total: a missing journal (no due night has run or no
 * blocks recorded — a clean empty source), an unreadable journal, or any
 * read or fold failure yields no items rather than throwing into
 * discovery. Unlike the sibling machinery feeds there is no fleet-repo
 * gate — each cell self-targets the repository its blocked PRs targeted.
 */
export async function reviewBlocksBacklogItems(opts: ReviewBlocksBacklogOptions = {}): Promise<CloudBacklogItem[]> {
  try {
    const home = opts.homeDir ?? homedir();
    const journalPath = opts.journalPath ?? join(home, '.ashlr', 'learn', 'retro-input', 'review-blocks.jsonl');
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs
      : REVIEW_BLOCKS_WINDOW_MS;
    const tail = await readLedgerTail(journalPath, REVIEW_BLOCKS_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const parsed = parseReviewBlockText(tail.text);
    const cells = foldReviewBlockCells(parsed.rows, { nowMs, windowMs });
    const limit = Math.max(1, Math.min(opts.limit ?? REVIEW_BLOCKS_BACKLOG_MAX_ITEMS, REVIEW_BLOCKS_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => reviewBlockItem(cell, tail.truncated, parsed.invalidRows));
  } catch {
    return [];
  }
}
