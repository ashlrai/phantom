/**
 * Branch-gardener audit journal recurring evidence → self-improvement backlog items.
 *
 * The launchd-scheduled branch gardener (contrib/mac/branch-gardener.py,
 * docs/BRANCH-GARDENER.md) audits every configured owner/repo remote's
 * branches on a 6-hour cadence and appends one JSONL event per repo per
 * pass to <runs>/metrics/branch-gardener.jsonl: `plan` before any apply,
 * `delete-intent`/`deleted` around each atomic push --delete batch, and a
 * final `result` carrying the repo's complete per-branch table plus its
 * error field. Three evidence kinds in that journal never became work —
 * the file had no reader at all:
 *
 *  - Flagged branches that persist: `action: 'flag'` rows are the
 *    gardener's documented triage list — PR-less branches with unique or
 *    recent commits (`pr-less-unique-or-recent`) and branches whose tip
 *    moved after their PR (`tip-changed-after-pr`). The gardener
 *    deliberately never deletes them; something has to decide each one's
 *    fate. A branch that stays flagged across audits spanning at least
 *    BRANCH_GARDENER_STRANDED_SPAN_MS is work nobody picked up.
 *  - `failed-or-uncertain` delete rows: each is one branch inside an
 *    atomic `git push --delete` batch that errored or timed out, so the
 *    remote ref may or may not be gone. The next pass re-plans from fresh
 *    remote state, but a delete path that keeps failing means the
 *    stale-branch backlog never drains.
 *  - Per-repo `error` results: 'evidence-unavailable-or-invalid' or a
 *    refusal means metadata, PR listing, fetch or local-activity
 *    evidence could not be gathered — while it recurs, that repo's
 *    branches are never classified at all and its triage list grows
 *    silently.
 *
 * Until now all three only existed as append-only audit rows; the
 * gardener's own docs call the flagged set "the triage list" but nothing
 * scheduled that triage. branchGardenerBacklogItems carries the same
 * journal into discoverBacklog, so `phm improve discover` and the
 * scheduler's autoDiscover queue it exactly like the fleet outcome-
 * learning, nightly retro, policy, local-gate, pass^k, friction,
 * tick-health, cross-review, empty-tag, post-merge, ci-rerun,
 * lost-launch, memory, controller, skill-outcome, precheck-skip,
 * source-yield, gateway-shadow, recheck, stuck-job, lesson-trial,
 * unfed, dupcheck-gate and proposal-outcome sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail; nothing is written and no network is touched.
 *    Missing or unreadable evidence yields no items — an absent journal
 *    reads as an empty ledger, and 'unreadable'/'not-file' cannot be
 *    told apart from "no rows".
 *  - Repo matching is exact owner/repo, case-insensitive: journal rows
 *    carry the remote the pass audited and the backlog addresses
 *    owner/name, so evidence recorded against a different remote (a
 *    fork's own branch namespace) never lands on this one.
 *  - Only `result` events fold. `plan`, `delete-intent` and `deleted`
 *    rows repeat the same per-branch classifications (pre-apply
 *    snapshots and batch subsets), so counting them too would double
 *    every observation; the final per-repo report is the authoritative
 *    record.
 *  - Recurring means recorded. A stranded branch emits only when its
 *    flag observations span at least BRANCH_GARDENER_STRANDED_SPAN_MS
 *    (one audit cycle proves nothing — a branch flagged and triaged
 *    inside a day is healthy), and a repo emits the bucket only at
 *    BRANCH_GARDENER_STRANDED_MIN_BRANCHES persisting branches. Delete
 *    failures emit only across at least two distinct UTC days with at
 *    least BRANCH_GARDENER_DELETEFAIL_ROWS recorded rows; audit errors
 *    emit only across at least two distinct UTC days.
 *  - Unknown stays unknown. Malformed lines, rows without the v1 schema,
 *    unknown events and rows missing their branch/action/result fields
 *    are skipped, never guessed; a truncated tail still yields honest
 *    lower-bound counts and says so in the prompt.
 *  - Dedup is downstream. Item ids hash the bucket + repository identity
 *    (never the counts or timestamps), so a refresh re-derives the same
 *    id and appendUserBacklogItems adds only what is new.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, branch names are scrubbed, flattened and capped,
 *    and the brief names the journal, the gardener script and its docs
 *    with the usual no-change escape when the window no longer
 *    reproduces or the cause is owner-only.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the repo's bucket set is closed at three. */
export const BRANCH_GARDENER_MAX_ITEMS = 8;
const BRANCH_GARDENER_ITEM_HARD_MAX = 25;
/** The window every fold anchors on: the fleet's recurring-evidence week. */
export const BRANCH_GARDENER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Flag observations for one branch must span at least this long before the
 * branch counts as stranded — roughly four gardener passes, so a branch
 * flagged and resolved inside a day never queues a session.
 */
export const BRANCH_GARDENER_STRANDED_SPAN_MS = 24 * 60 * 60 * 1000;
/** Distinct persisting branches a repo needs before the stranded bucket emits. */
export const BRANCH_GARDENER_STRANDED_MIN_BRANCHES = 2;
/** `failed-or-uncertain` rows a repo needs inside the window… */
export const BRANCH_GARDENER_DELETEFAIL_ROWS = 3;
/** …spread across at least this many distinct UTC days. */
export const BRANCH_GARDENER_DELETEFAIL_DAYS = 2;
/** Distinct UTC days a repo's result errors must span before the audit bucket emits. */
export const BRANCH_GARDENER_AUDITERR_DAYS = 2;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Branch names quoted inside one prompt before the remainder is summarized. */
const PROMPT_BRANCHES_MAX = 8;
/** Recorded error strings quoted inside one prompt before the remainder is summarized. */
const PROMPT_ERRORS_MAX = 3;
/** Journal-recorded names are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 120;
/** The journal's path inside the fleet runs dir (branch-gardener.py appends it). */
const BRANCH_GARDENER_JOURNAL_RELATIVE = join('metrics', 'branch-gardener.jsonl');
const JOURNAL_SCHEMA = 'branch-gardener.v1';
const JOURNAL_EVENTS = new Set(['plan', 'delete-intent', 'deleted', 'result']);

type Bucket = 'stranded' | 'delete-uncertain' | 'audit-error';

export interface BranchGardenerItemsOptions {
  /** Backlog target in owner/name form; journal rows must name the same repository. */
  repo: string;
  /** Journal override (default: <runsDir>/metrics/branch-gardener.jsonl). */
  journalPath?: string;
  /** Runs dir for the journal default; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default BRANCH_GARDENER_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated per-branch classification row inside a `result` event. */
interface BranchRow {
  branch: string;
  action: string;
  reason: string;
  result: string;
}

/** One validated `result` event: the repo's final per-pass report. */
interface ResultEvent {
  atMs: number;
  utcDay: string;
  repo: string;
  rows: BranchRow[];
  /** Non-empty recorded error string, or null when the pass was clean. */
  error: string | null;
}

/** Journal-recorded names are unbounded text; flatten, scrub and cap before use. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

function parseBranchRow(value: unknown): BranchRow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const branch = r['branch'];
  const action = r['action'];
  const reason = r['reason'];
  const result = r['result'];
  if (typeof branch !== 'string' || branch === '') return null;
  if (typeof action !== 'string' || action === '') return null;
  if (typeof result !== 'string' || result === '') return null;
  return {
    branch,
    action,
    reason: typeof reason === 'string' ? reason : '',
    result,
  };
}

/**
 * Pure: parse journal text into validated `result` events. Malformed lines,
 * foreign schemas, non-result events and rows missing their fields are
 * skipped — never guessed. `plan`/`delete-intent`/`deleted` events are
 * validated for schema only to keep the parser honest about what it saw,
 * then dropped: they repeat classifications the `result` event already
 * carries authoritatively.
 */
export function parseBranchGardenerJournal(text: string): ResultEvent[] {
  const events: ResultEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const r = value as Record<string, unknown>;
    if (r['schema'] !== JOURNAL_SCHEMA) continue;
    const at = r['at'];
    const repo = r['repo'];
    const event = r['event'];
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue;
    if (typeof repo !== 'string' || repo.trim() === '') continue;
    if (typeof event !== 'string' || !JOURNAL_EVENTS.has(event)) continue;
    if (event !== 'result') continue;
    const atMs = at * 1000;
    const rawRows = r['rows'];
    const rows = Array.isArray(rawRows)
      ? rawRows.map(parseBranchRow).filter((row): row is BranchRow => row !== null)
      : [];
    const error = r['error'];
    events.push({
      atMs,
      utcDay: utcDayOf(atMs),
      repo: repo.trim(),
      rows,
      error: typeof error === 'string' && error.trim() !== '' ? error.trim() : null,
    });
  }
  return events;
}

/** One branch's flag observations inside the window. */
interface FlagTrack {
  firstMs: number;
  lastMs: number;
  days: Set<string>;
  observations: number;
  reasons: Set<string>;
}

interface RepoFold {
  /** branch → its flag track, for branches seen flagged at least once. */
  flags: Map<string, FlagTrack>;
  /** Total `failed-or-uncertain` rows recorded for the repo. */
  deleteFailRows: number;
  /** Distinct UTC days a `failed-or-uncertain` row landed on. */
  deleteFailDays: Set<string>;
  /** Distinct branches inside those failed batches (prompt evidence). */
  deleteFailBranches: Set<string>;
  /** `result` events carrying a non-empty error. */
  auditErrorEvents: number;
  /** Distinct UTC days those error events landed on. */
  auditErrorDays: Set<string>;
  /** Recorded error strings, deduped, for prompt evidence. */
  auditErrors: string[];
}

const newRepoFold = (): RepoFold => ({
  flags: new Map(),
  deleteFailRows: 0,
  deleteFailDays: new Set(),
  deleteFailBranches: new Set(),
  auditErrorEvents: 0,
  auditErrorDays: new Set(),
  auditErrors: [],
});

/**
 * Pure: fold validated `result` events for one repository into the three
 * bucket tallies. Events outside the window or naming another repository
 * contribute nothing.
 */
export function foldBranchGardenerEvents(
  events: readonly ResultEvent[],
  repo: string,
  nowMs: number,
  windowMs: number = BRANCH_GARDENER_WINDOW_MS,
): RepoFold {
  const fold = newRepoFold();
  const target = repo.toLowerCase();
  const windowStart = nowMs - windowMs;
  for (const event of events) {
    if (event.repo.toLowerCase() !== target) continue;
    if (event.atMs < windowStart) continue;
    if (event.error !== null) {
      fold.auditErrorEvents += 1;
      fold.auditErrorDays.add(event.utcDay);
      const seen = fold.auditErrors.some((e) => e === event.error);
      if (!seen && fold.auditErrors.length < PROMPT_ERRORS_MAX * 4) fold.auditErrors.push(event.error);
    }
    for (const row of event.rows) {
      if (row.action === 'flag') {
        const track = fold.flags.get(row.branch) ?? { firstMs: event.atMs, lastMs: event.atMs, days: new Set(), observations: 0, reasons: new Set() };
        track.firstMs = Math.min(track.firstMs, event.atMs);
        track.lastMs = Math.max(track.lastMs, event.atMs);
        track.days.add(event.utcDay);
        track.observations += 1;
        if (row.reason !== '') track.reasons.add(row.reason);
        fold.flags.set(row.branch, track);
      } else if (row.result === 'failed-or-uncertain') {
        fold.deleteFailRows += 1;
        fold.deleteFailDays.add(event.utcDay);
        fold.deleteFailBranches.add(row.branch);
      }
    }
  }
  return fold;
}

/** Branches whose flag observations span the stranded bar, deterministically ordered. */
function strandedBranches(fold: RepoFold): Array<{ branch: string; track: FlagTrack }> {
  return [...fold.flags.entries()]
    .filter(([, track]) => track.lastMs - track.firstMs >= BRANCH_GARDENER_STRANDED_SPAN_MS)
    .map(([branch, track]) => ({ branch, track }))
    .sort((a, b) => b.track.observations - a.track.observations || a.branch.localeCompare(b.branch));
}

const WINDOW_DAYS = Math.round(BRANCH_GARDENER_WINDOW_MS / 86_400_000);
const daySpan = (first: number, last: number): number =>
  Math.max(1, Math.round((last - first) / 86_400_000));

const NO_CHANGE = 'If the window has rolled forward, the flagged branches were triaged, deleted or pinned since, or the cause is owner-only (credentials, billing, a protected gate or sandbox profile) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is metrics/branch-gardener.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), appended by the launchd branch gardener (contrib/mac/branch-gardener.py, docs/BRANCH-GARDENER.md) on its scheduled audits; each `result` event carries one repository\'s complete per-branch table — action keep/delete/flag with reason and result — plus the pass\'s error field.';

const truncationNote = (truncated: boolean): string =>
  truncated ? ' The journal tail was truncated, so these counts cover only the retained bytes — treat every tally as a lower bound.' : '';

function strandedPrompt(branches: Array<{ branch: string; track: FlagTrack }>, fold: RepoFold, repo: string, truncated: boolean): string {
  const shown = branches.slice(0, PROMPT_BRANCHES_MAX).map(({ branch, track }) => {
    const reasons = [...track.reasons].sort().join('/') || 'unrecorded';
    return `'${fieldText(branch)}' (${track.observations} flag(s) over ${daySpan(track.firstMs, track.lastMs)} day(s), reason ${reasons})`;
  });
  const rest = branches.length > shown.length ? `, and ${branches.length - shown.length} more` : '';
  const totalFlags = [...fold.flags.values()].reduce((n, t) => n + t.observations, 0);
  return [
    `Phantom's branch gardener keeps flagging branches on ${repo} that nobody has triaged — the self-improvement work this backlog exists for.`,
    '',
    `${branches.length} branch(es) stayed flagged for at least ${Math.round(BRANCH_GARDENER_STRANDED_SPAN_MS / 3_600_000)} hours inside the ${WINDOW_DAYS}-day journal window: ${shown.join('; ')}${rest}. The window recorded ${totalFlags} flag observation(s) across ${fold.flags.size} distinct branch(es).${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Flagged rows are the gardener's documented triage list: branches it refuses to delete because they may hold unlanded work — PR-less branches with unique or recent commits, or branches whose tip moved after their PR. Triage each surviving branch on ${repo}: inspect what it contains against the default branch (gh pr list --head <branch>, git log <default>..<branch>), then land the work through a PR, delete the branch when its commits are superseded, or leave it deliberately pinned. The gardener deletes only what its guards prove safe; a branch that keeps failing those guards is exactly the case to resolve by hand. If every flagged branch now has an open PR, a deliberate pin, or was deleted since — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function deleteUncertainPrompt(fold: RepoFold, repo: string, truncated: boolean): string {
  const shown = [...fold.deleteFailBranches].sort().slice(0, PROMPT_BRANCHES_MAX).map((b) => `'${fieldText(b)}'`);
  const rest = fold.deleteFailBranches.size > shown.length ? `, and ${fold.deleteFailBranches.size - shown.length} more` : '';
  return [
    `Phantom's branch gardener keeps failing its atomic branch deletes on ${repo} — push batches report failed-or-uncertain, so remote branches may or may not be gone.`,
    '',
    `Inside the ${WINDOW_DAYS}-day journal window the repo recorded ${fold.deleteFailRows} failed-or-uncertain row(s) across ${fold.deleteFailDays.size} distinct UTC day(s), covering ${fold.deleteFailBranches.size} distinct branch(es)${shown.length > 0 ? `: ${shown.join(', ')}${rest}` : ''}.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Each failed-or-uncertain row is one branch inside an atomic \`git push --delete\` batch that errored or timed out (delete_batch in contrib/mac/branch-gardener.py); the next pass re-plans from fresh remote state so the branches are not lost, but a delete path that keeps failing means the stale-branch backlog never drains. Find why the pushes fail: GitHub authentication or rate limits on the host, repository size, the launchd job's environment, or ~/.ashlr-runs/logs/branch-gardener.err.log's stderr. Re-run \`python3 contrib/mac/branch-gardener.py --json\` (dry-run by default) to see the current plan. If recent audits deleted cleanly — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function auditErrorPrompt(fold: RepoFold, repo: string, truncated: boolean): string {
  const errors = fold.auditErrors.slice(0, PROMPT_ERRORS_MAX).map((e) => `'${fieldText(e, 200)}'`);
  const rest = fold.auditErrors.length > errors.length ? `, and ${fold.auditErrors.length - errors.length} more distinct error(s)` : '';
  return [
    `Phantom's branch gardener keeps failing to audit ${repo} — its result rows record an error on ${fold.auditErrorDays.size} distinct UTC day(s) inside the ${WINDOW_DAYS}-day journal window.`,
    '',
    `${fold.auditErrorEvents} errored result event(s) were recorded; the distinct error strings include ${errors.join(', ')}${rest}.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `An error result means the pass could not gather evidence — 'evidence-unavailable-or-invalid' when metadata, PR listing, fetch or local-activity reads fail, or a refusal for config, lock or audit problems. While it recurs, ${repo}'s branches are never classified: flagged work and stale branches accumulate with no triage list at all. Check which evidence source fails: gh authentication for the owner/repo remotes, the refs/heads/* fetch, the projects and runs directories the pass scans for active worktrees, or the fleet KILL switch; ~/.ashlr-runs/logs/branch-gardener.err.log carries stderr. If the latest audits are clean — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function itemId(bucket: Bucket, repo: string): string {
  const hash = createHash('sha256').update(`branch-gardener:${bucket}:${repo.toLowerCase()}`).digest('hex').slice(0, 16);
  return `branch-gardener-${bucket}-${hash}`;
}

function makeItem(bucket: Bucket, repo: string, title: string, prompt: string): CloudBacklogItem {
  return {
    id: itemId(bucket, repo),
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'branch-gardener',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the branch-gardener journal's recurring stranded
 * branches, delete failures and audit errors on `repo`. Total: any read or
 * fold failure yields no items rather than throwing into discovery.
 */
export async function branchGardenerBacklogItems(opts: BranchGardenerItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const home = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs');
    const journalPath = opts.journalPath ?? join(runsDir, BRANCH_GARDENER_JOURNAL_RELATIVE);
    const tail = await readLedgerTail(journalPath);
    if (tail.state !== 'read') return [];
    const events = parseBranchGardenerJournal(tail.text);
    const fold = foldBranchGardenerEvents(events, repo, nowMs);

    const candidates: CloudBacklogItem[] = [];
    const stranded = strandedBranches(fold);
    if (stranded.length >= BRANCH_GARDENER_STRANDED_MIN_BRANCHES) {
      candidates.push(makeItem(
        'stranded',
        repo,
        `${stranded.length} branch(es) stuck flagged on ${repo}`,
        strandedPrompt(stranded, fold, repo, tail.truncated),
      ));
    }
    if (fold.deleteFailRows >= BRANCH_GARDENER_DELETEFAIL_ROWS && fold.deleteFailDays.size >= BRANCH_GARDENER_DELETEFAIL_DAYS) {
      candidates.push(makeItem(
        'delete-uncertain',
        repo,
        `Branch-gardener deletes keep failing on ${repo}`,
        deleteUncertainPrompt(fold, repo, tail.truncated),
      ));
    }
    if (fold.auditErrorDays.size >= BRANCH_GARDENER_AUDITERR_DAYS) {
      candidates.push(makeItem(
        'audit-error',
        repo,
        `Branch gardener keeps failing to audit ${repo}`,
        auditErrorPrompt(fold, repo, tail.truncated),
      ));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? BRANCH_GARDENER_MAX_ITEMS, BRANCH_GARDENER_ITEM_HARD_MAX));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}
