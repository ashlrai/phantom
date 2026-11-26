/**
 * Superseded-close attempt journal recurring evidence → self-improvement backlog items.
 *
 * `ashlr fleet superseded-close --apply` (src/cli/fleet-superseded-close.ts)
 * closes open fleet bridge PRs whose recut already merged — the plan
 * planSupersededClose derives from findSupersededPrs keeps only
 * `bridge: RQ-PHX-` titles whose merged recut's job prompt names the
 * open PR (src/core/fleet/superseded-close.ts). Dry runs write nothing;
 * an applied run closes one PR at a time through `gh pr close <N>
 * --repo ashlrai/phantom --comment <comment>`, stops at the first
 * non-zero exit and appends every attempt to
 * <runs>/queue/superseded-closes.jsonl:
 *
 *   { at: <ISO-8601>, pr: <number>, supersededBy: <number>, ok, error? }
 *
 * ok is the gh exit verdict — true on code 0, false on a non-zero exit
 * or a thrown runner error, with error carrying the bounded stderr or
 * exception text on failures only. At most one ok:false row lands per
 * invocation because the run stops there. supersededBy is the merged
 * recut PR whose landing made the open PR redundant.
 *
 * Until now the ledger had NO reader at all — not even a point-in-time
 * display: the only code that touches the file is the writer's append
 * and the writer's own test asserting the lines. `phm fleet
 * merge-plan` counts the superseded set and names this verb as the
 * remedy, but nothing folded the attempt journal, so a close path
 * that kept failing never became work: every ok:false row is one
 * superseded PR left open — still counting against the open-PR
 * backlog, still re-running CI on every branch refresh, the exact
 * cost the verb exists to remove — and because the run stops at the
 * first failure, one stuck PR blocks every later close in the plan.
 * supersededCloseBacklogItems carries the journal into
 * discoverBacklog:
 *
 *  - ok:false rows recurring for one PR: `gh pr close` keeps erroring
 *    on that pull request and it sits at the head of every later
 *    plan — a superseded PR that can never close stays open forever.
 *  - ok:false rows recurring across distinct PRs: the shared close
 *    path itself keeps failing — gh authentication or scope, rate
 *    limits, runner timeouts or a repo-wide refusal — regardless of
 *    which superseded PR is attempted.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail; nothing is written and no network is touched.
 *    Missing, non-file or unreadable evidence yields no items.
 *  - The journal carries no repository column — the writer hardcodes
 *    SUPERSEDED_CLOSE_REPO to the fleet repository — so like the
 *    custody, self-tick, launch-cost, leader-replies and
 *    landed-close feeds, items emit only when the backlog's repo name
 *    is the fleet's own; another repository inherits nothing.
 *  - Recurring means recorded. A cell emits only at
 *    SUPERSEDED_CLOSE_MIN_ROWS failed rows across
 *    SUPERSEDED_CLOSE_MIN_DAYS distinct UTC days inside the 7-day
 *    window (the close-path cell additionally needs
 *    SUPERSEDED_CLOSE_MIN_PRS distinct PRs) — one failed attempt
 *    proves nothing (a transient gh or network error often
 *    self-resolves on the next run).
 *  - Unknown stays unknown. Malformed lines, rows missing
 *    pr/supersededBy/ok/at, non-integer PR numbers and non-boolean ok
 *    are skipped, never guessed; error text is flattened, secret-
 *    scrubbed and capped before it reaches a prompt; a truncated
 *    tail still yields honest lower-bound counts and says so.
 *  - The writer resolves its runs dir as homedir()/.ashlr-runs and
 *    ignores ASHLR_RUNS_DIR — unlike the sibling fleet verbs — so
 *    the fold reads that location plus the env/override location
 *    when it differs, covering both the current writer and any
 *    later fix that aligns it with the siblings. If the writer's
 *    resolution changes again, move these defaults with it.
 *  - Dedup is downstream. Item ids hash the cell kind + repository
 *    + PR (never the counts or timestamps), so a refresh re-derives
 *    the same id and appendUserBacklogItems adds only what is new.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, and the brief names the journal, the
 *    writer and its plan source with the usual no-change escape
 *    when the window no longer reproduces or the cause is
 *    owner-only.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the repo's cell set is small and closed. */
export const SUPERSEDED_CLOSE_MAX_ITEMS = 8;
const SUPERSEDED_CLOSE_ITEM_HARD_MAX = 25;
/** The window every fold anchors on: the fleet's recurring-evidence week. */
export const SUPERSEDED_CLOSE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Failed rows one cell needs inside the window… */
export const SUPERSEDED_CLOSE_MIN_ROWS = 3;
/** …spread across at least this many distinct UTC days. */
export const SUPERSEDED_CLOSE_MIN_DAYS = 2;
/** …and, for the shared close-path cell, across at least this many distinct PRs. */
export const SUPERSEDED_CLOSE_MIN_PRS = 2;
/** Future-skew allowance on record timestamps, the sibling folds' clock-drift tolerance. */
const SUPERSEDED_CLOSE_FUTURE_SKEW_MS = 60_000;
/**
 * Bounded tail for the journal. The verb is operator- or planner-run,
 * not tick-fed: each applied pass attempts at most its --limit
 * (default 10, capped 25) closes and stops at the first failure, so
 * volume is a handful of ~200-byte rows per invocation — 1 MiB
 * retains far more than the 7-day window at any plausible cadence.
 */
export const SUPERSEDED_CLOSE_TAIL_BYTES = 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded text is unbounded; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** Distinct recorded error strings quoted inside one prompt before the remainder is summarized. */
const PROMPT_ERRORS_MAX = 3;
/** Distinct error strings tracked per cell for prompt evidence. */
const TRACK_ERRORS_MAX = 8;
/** Distinct merged-recut numbers quoted inside one prompt before the remainder is summarized. */
const PROMPT_RECUTS_MAX = 3;
/** The journal's path inside the fleet runs dir (closeSupersededPrs appends it). */
const SUPERSEDED_CLOSE_JOURNAL_RELATIVE = join('queue', 'superseded-closes.jsonl');
/** The repository name the writer hardcodes (SUPERSEDED_CLOSE_REPO); the gate matches on it. */
const FLEET_REPO_NAME = 'phantom';
/** The repository name the gate matches: the last path segment, lowercased. */
const fleetRepoName = (repo: string): string =>
  (repo.split('/').pop() ?? repo).trim().toLowerCase();

type CellKind = 'failed' | 'close-path';

export interface SupersededCloseItemsOptions {
  /** Backlog target in owner/name form; the journal describes the fleet repo only. */
  repo: string;
  /** Journal override (default: the runs-dir locations below). */
  journalPath?: string;
  /** Runs dir override — read alongside the writer's own ~/.ashlr-runs location when it differs. */
  runsDir?: string;
  /** Home for the writer-location default (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default SUPERSEDED_CLOSE_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated attempt row inside the journal. */
export interface SupersededCloseRow {
  atMs: number;
  utcDay: string;
  pr: number;
  /** The merged recut PR whose landing made this PR redundant. */
  supersededBy: number;
  /** The gh exit verdict — false on non-zero exit or a thrown runner error. */
  ok: boolean;
  /** Recorded error text on failed rows, or null. */
  error: string | null;
}

/** Journal-recorded text is unbounded; flatten, scrub and cap before use. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Pure: parse journal text into validated attempt rows. Malformed lines,
 * rows missing pr/supersededBy/ok/at, non-integer PR numbers and
 * non-boolean ok are skipped — never guessed. Mirrors the writer's
 * emitted shape: ISO `at`, positive integer `pr` and `supersededBy`,
 * boolean `ok` and an optional string `error`. Extra fields are
 * ignored for forward compatibility.
 */
export function parseSupersededCloseJournal(text: string): SupersededCloseRow[] {
  const rows: SupersededCloseRow[] = [];
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
    const at = r['at'];
    const pr = r['pr'];
    const supersededBy = r['supersededBy'];
    const ok = r['ok'];
    if (typeof at !== 'string') continue;
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) continue;
    if (typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr <= 0) continue;
    if (typeof supersededBy !== 'number' || !Number.isSafeInteger(supersededBy) || supersededBy <= 0) continue;
    if (typeof ok !== 'boolean') continue;
    const error = r['error'];
    rows.push({
      atMs,
      utcDay: utcDayOf(atMs),
      pr,
      supersededBy,
      ok,
      error: typeof error === 'string' && error.trim() !== '' ? error.trim() : null,
    });
  }
  return rows;
}

/** One PR's (or the close-path cell's) failed-attempt track inside the window. */
interface AdverseTrack {
  rows: number;
  days: Set<string>;
  firstMs: number;
  lastMs: number;
  /** Distinct merged-recut numbers recorded on the rows (bounded by the tail read). */
  recuts: Set<number>;
  /** Deduped bounded error strings, for prompt evidence. */
  errors: string[];
}

/**
 * firstMs/lastMs start at the infinities so the first tracked row seeds
 * both; empty tracks never reach a prompt (meetsBar requires rows).
 */
const newTrack = (): AdverseTrack => ({
  rows: 0,
  days: new Set(),
  firstMs: Number.POSITIVE_INFINITY,
  lastMs: Number.NEGATIVE_INFINITY,
  recuts: new Set(),
  errors: [],
});

function trackRow(track: AdverseTrack, row: SupersededCloseRow, errorMax = TRACK_ERRORS_MAX): void {
  track.rows += 1;
  track.days.add(row.utcDay);
  track.firstMs = Math.min(track.firstMs, row.atMs);
  track.lastMs = Math.max(track.lastMs, row.atMs);
  track.recuts.add(row.supersededBy);
  if (row.error !== null) {
    const text = fieldText(row.error);
    if (text !== '' && !track.errors.includes(text) && track.errors.length < errorMax) {
      track.errors.push(text);
    }
  }
}

/** The fold's output: per-PR cells plus the shared close-path tally and healthy context. */
export interface SupersededCloseFold {
  /** pr → failed-attempt track. */
  failed: Map<number, AdverseTrack>;
  /** ok:false rows across all PRs — the shared close path itself. */
  closePath: AdverseTrack & { prs: Set<number> };
  /** ok:true rows inside the window — attempts that did close. */
  closedRows: number;
}

const newFold = (): SupersededCloseFold => ({
  failed: new Map(),
  closePath: { ...newTrack(), prs: new Set() },
  closedRows: 0,
});

/**
 * Pure: fold validated rows into the adverse cells. Rows outside the
 * window (including future-stamped rows past the skew allowance)
 * contribute nothing. ok:true rows are explained outcomes and count
 * only as healthy context; ok:false rows fold per-PR and into the
 * shared close-path track.
 */
export function foldSupersededCloseRows(
  rows: readonly SupersededCloseRow[],
  nowMs: number,
  windowMs: number = SUPERSEDED_CLOSE_WINDOW_MS,
): SupersededCloseFold {
  const fold = newFold();
  const windowStart = nowMs - windowMs;
  const until = nowMs + SUPERSEDED_CLOSE_FUTURE_SKEW_MS;
  const perPr = (map: Map<number, AdverseTrack>, pr: number): AdverseTrack => {
    let track = map.get(pr);
    if (track === undefined) {
      track = newTrack();
      map.set(pr, track);
    }
    return track;
  };
  for (const row of rows) {
    if (row.atMs < windowStart || row.atMs > until) continue;
    if (row.ok) {
      fold.closedRows += 1;
      continue;
    }
    trackRow(perPr(fold.failed, row.pr), row);
    trackRow(fold.closePath, row);
    fold.closePath.prs.add(row.pr);
  }
  return fold;
}

const WINDOW_DAYS = Math.round(SUPERSEDED_CLOSE_WINDOW_MS / 86_400_000);
const daySpan = (first: number, last: number): number =>
  Math.max(1, Math.round((last - first) / 86_400_000));

const NO_CHANGE = 'If the window has rolled forward, the PR closed or left the plan since, or the cause is owner-only (credentials, billing, a protected gate or sandbox profile) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is queue/superseded-closes.jsonl under the fleet runs directory, appended by `ashlr fleet superseded-close --apply` (src/cli/fleet-superseded-close.ts) — one {at, pr, supersededBy, ok, error?} row per attempted `gh pr close`, the run stopping at the first failure — over the plan planSupersededClose derives from findSupersededPrs (src/core/fleet/superseded-close.ts): open `bridge: RQ-PHX-` PRs whose merged recut\'s job prompt names them. The writer resolves its runs dir as ~/.ashlr-runs (homedir) and ignores ASHLR_RUNS_DIR, unlike the sibling fleet verbs; this feed reads that location plus the env/override location when it differs. Until this feed the ledger had no reader at all — only the writer\'s own test asserts its lines.';

const truncationNote = (truncated: boolean): string =>
  truncated ? ' The journal tail was truncated, so these counts cover only the retained bytes — treat every tally as a lower bound.' : '';

const spanText = (track: AdverseTrack): string =>
  `first ${new Date(track.firstMs).toISOString()}, last ${new Date(track.lastMs).toISOString()}`;

const errorsText = (track: AdverseTrack): string =>
  track.errors.length === 0
    ? ''
    : ` Recorded error(s): ${track.errors.slice(0, PROMPT_ERRORS_MAX).map((e) => `'${e}'`).join(', ')}${track.errors.length > PROMPT_ERRORS_MAX ? `, and ${track.errors.length - PROMPT_ERRORS_MAX} more distinct` : ''}.`;

const recutsText = (track: AdverseTrack): string => {
  const sorted = [...track.recuts].sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  const shown = sorted.slice(0, PROMPT_RECUTS_MAX).map((n) => `#${n}`).join(', ');
  const more = sorted.length > PROMPT_RECUTS_MAX ? `, +${sorted.length - PROMPT_RECUTS_MAX} more` : '';
  return `, superseded by merged recut(s) ${shown}${more}`;
};

const closedContext = (closedRows: number): string =>
  closedRows === 0
    ? ' No in-window attempt closed — every recorded close failed, so the close path may be down entirely rather than failing selectively.'
    : ` ${closedRows} other in-window attempt(s) closed cleanly, so the path works at least intermittently.`;

const meetsBar = (track: AdverseTrack): boolean =>
  track.rows >= SUPERSEDED_CLOSE_MIN_ROWS && track.days.size >= SUPERSEDED_CLOSE_MIN_DAYS;

/** Per-PR cells sorted by recorded rows then PR number — deterministic across refreshes. */
function sortedCells(map: Map<number, AdverseTrack>): Array<{ pr: number; track: AdverseTrack }> {
  return [...map.entries()]
    .map(([pr, track]) => ({ pr, track }))
    .sort((a, b) => b.track.rows - a.track.rows || a.pr - b.pr);
}

function failedPrompt(pr: number, track: AdverseTrack, repo: string, truncated: boolean, closedRows: number): string {
  return [
    `\`ashlr fleet superseded-close\` keeps failing to close PR #${pr} on ${repo} — every applied run's \`gh pr close\` errors out on this pull request.`,
    '',
    `Inside the ${WINDOW_DAYS}-day journal window the ledger recorded ${track.rows} failed attempt(s) for PR #${pr} across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)})${recutsText(track)}.${errorsText(track)}${closedContext(closedRows)}${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Each failed row is one \`gh pr close ${pr} --repo ${repo} --comment <comment>\` attempt that exited non-zero or threw; the run stops at the first failure, so while this PR tops the plan every later superseded PR waits behind it. The PR's recut already merged — only the bookkeeping is stuck — but a close that keeps failing leaves it open: it keeps counting against the open-PR backlog and every branch refresh re-runs CI on it, the cost the verb exists to remove. Find why the close fails: gh authentication or token scope on the host, branch-protection or ruleset refusals, a PR state gh cannot close (already merged or closed by hand — gh exits non-zero), or a stuck runner; the recorded error text above is the scrubbed evidence to start from. Check whether the failures concentrate on this PR (a poison row — verify the plan still lists it and the merged recut still stands) or spread across PRs (the shared close path is broken — see whether the close-path cell fired too). Reproduce with \`gh pr view ${pr} --repo ${repo} --json state,headRefOid\` then \`gh pr close ${pr} --repo ${repo}\` once the cause is known — or fix the close path if the reason is systemic. If the PR has since closed or left the plan — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function closePathPrompt(track: AdverseTrack & { prs: Set<number> }, repo: string, truncated: boolean, closedRows: number): string {
  return [
    `\`ashlr fleet superseded-close\` keeps failing its \`gh pr close\` attempts across multiple PRs on ${repo} — the shared close path errors regardless of which superseded PR is attempted.`,
    '',
    `Inside the ${WINDOW_DAYS}-day journal window the ledger recorded ${track.rows} failed attempt(s) across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)}), spanning ${track.prs.size} distinct PR(s).${errorsText(track)}${closedContext(closedRows)}${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Each failed row is one \`gh pr close <n> --repo ${repo} --comment <comment>\` attempt that exited non-zero or threw; the run stops at the first failure, so every later superseded PR waits behind each stuck attempt. Failures spread across distinct PRs point at the shared close path rather than any one pull request — gh authentication or token scope on the host, gh rate limits, runner timeouts, or GitHub refusing closes repo-wide. Check \`gh auth status\`, gh's rate-limit budget and the recorded error text above; an all-failure window with no ok:true rows means the path is down entirely, while interleaved successes mean transient or per-PR causes. While closes keep failing, every superseded PR stays open — counting against the backlog and re-running CI on branch refreshes. If recent runs closed cleanly — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function itemId(kind: CellKind, repo: string, pr: number | null): string {
  const cell = pr === null ? kind : `${kind}:${pr}`;
  const hash = createHash('sha256').update(`superseded-close:${cell}:${repo.toLowerCase()}`).digest('hex').slice(0, 16);
  return `superseded-close-${kind}-${hash}`;
}

function makeItem(kind: CellKind, repo: string, pr: number | null, title: string, prompt: string): CloudBacklogItem {
  return {
    id: itemId(kind, repo, pr),
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'superseded-close',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Every journal location evidence can occupy: the writer's own
 * homedir()/.ashlr-runs resolution (it ignores ASHLR_RUNS_DIR) plus
 * the env/override runs dir when it differs — covering both the
 * current writer and any later fix aligning it with the siblings.
 * journalPath, when given, is the single override.
 */
function journalPaths(opts: SupersededCloseItemsOptions): string[] {
  if (opts.journalPath !== undefined) return [opts.journalPath];
  const home = opts.homeDir ?? homedir();
  const writerRunsDir = join(home, '.ashlr-runs');
  const paths = [join(writerRunsDir, SUPERSEDED_CLOSE_JOURNAL_RELATIVE)];
  const overrideRunsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'];
  if (overrideRunsDir !== undefined && resolve(overrideRunsDir) !== resolve(writerRunsDir)) {
    paths.push(join(overrideRunsDir, SUPERSEDED_CLOSE_JOURNAL_RELATIVE));
  }
  return paths;
}

/**
 * Backlog items for the superseded-close attempt journal's recurring
 * failed closes — per-PR and across the shared close path. Total:
 * any read or fold failure yields no items rather than throwing into
 * discovery.
 */
export async function supersededCloseBacklogItems(opts: SupersededCloseItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const rows: SupersededCloseRow[] = [];
    let truncated = false;
    for (const journalPath of journalPaths(opts)) {
      const tail = await readLedgerTail(journalPath, SUPERSEDED_CLOSE_TAIL_BYTES);
      if (tail.state !== 'read') continue;
      truncated = truncated || tail.truncated;
      rows.push(...parseSupersededCloseJournal(tail.text));
    }
    if (rows.length === 0) return [];
    const fold = foldSupersededCloseRows(rows, nowMs);

    const candidates: CloudBacklogItem[] = [];
    const closePath = fold.closePath;
    if (meetsBar(closePath) && closePath.prs.size >= SUPERSEDED_CLOSE_MIN_PRS) {
      candidates.push(makeItem(
        'close-path',
        repo,
        null,
        `Superseded-close gh closes keep failing across PRs on ${repo}`,
        closePathPrompt(closePath, repo, truncated, fold.closedRows),
      ));
    }
    for (const { pr, track } of sortedCells(fold.failed)) {
      if (!meetsBar(track)) continue;
      candidates.push(makeItem(
        'failed',
        repo,
        pr,
        `Superseded-close keeps failing on PR #${pr} in ${repo}`,
        failedPrompt(pr, track, repo, truncated, fold.closedRows),
      ));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? SUPERSEDED_CLOSE_MAX_ITEMS, SUPERSEDED_CLOSE_ITEM_HARD_MAX));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}
