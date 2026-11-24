/**
 * Landed-close attempt journal recurring evidence → self-improvement backlog items.
 *
 * Every applied `ashlr fleet self-tick` runs step 14, `landed-sweep`
 * (src/cli/fleet-landed-sweep.ts), which pipes the `fleet dirty-landed`
 * report into `ashlr fleet landed-close --apply`
 * (src/cli/fleet-landed-close.ts). For each DIRTY bridge PR whose every
 * changed path already matches master — class `landed`, work that shipped
 * another way — landed-close re-reads the PR (`gh pr view`) and closes it
 * (`gh pr close`), appending one row per attempt to
 * <runs>/queue/landed-closes.jsonl:
 *
 *   { at: <ISO-8601>, pr: <number>, head: <40-hex>, outcome, reason? }
 *
 * outcome is 'closed' (the gh close exited zero), 'skipped' (the re-read
 * found the PR no longer OPEN at the reported head — reason 'head-moved' —
 * or `gh pr view` itself failed — reason 'view-failed') or 'failed' (the
 * close exited non-zero or threw — reason carries stderr/exception text).
 * The first 'failed' attempt stops the run, so at most one failed row is
 * journaled per invocation. Dry runs and unattempted plan rows write
 * nothing.
 *
 * Until now the ledger's only readers were point-in-time displays —
 * readLandedCloses (src/core/fleet/landed-closes-read.ts) backs the Verse
 * Live home card over the last 256 KiB / 24 h, and self-tick.jsonl carries
 * only the sweep's aggregate closed=/planned= counts — so recurring
 * per-PR and per-cause evidence never became work. landedCloseBacklogItems
 * carries the same journal into discoverBacklog:
 *
 *  - 'failed' rows recurring for one PR: `gh pr close` keeps erroring on
 *    that pull request, and because the run stops at the first failure
 *    the PR sits at the head of every later plan until it resolves — a
 *    landed-flagged PR that can never close stays DIRTY forever.
 *  - 'skipped'/'head-moved' rows recurring for one PR: between the
 *    dirty-landed report and the close re-read the PR's head keeps
 *    moving (new pushes) or its state keeps leaving OPEN — work is
 *    landing on a pull request whose paths already match master, churn
 *    the sweeper re-plans and re-skips every tick.
 *  - 'skipped'/'view-failed' rows recurring across PRs: `gh pr view`
 *    keeps failing, so the sweeper cannot verify state and refuses every
 *    close — a degraded gh read path that leaves ALL landed-flagged PRs
 *    open while the step still reports success (skips are not failures).
 *  - 'skipped' rows whose reason sits outside the writer's documented
 *    {view-failed, head-moved} vocabulary: either the writer gained a
 *    skip class this feed does not know, or the rows are malformed —
 *    folded per-PR so the drift is visible instead of silently dropped.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail; nothing is written and no network is touched.
 *    Missing, non-file or unreadable evidence yields no items.
 *  - The journal carries no repository column — the writer hardcodes
 *    `ashlr fleet landed-close`'s REPO to the fleet repository — so like
 *    the custody, self-tick and launch-cost feeds, items emit only when
 *    the backlog's repo name is the fleet's own; another repository
 *    inherits nothing.
 *  - Recurring means recorded. A cell emits only at LANDED_CLOSE_MIN_ROWS
 *    adverse rows across LANDED_CLOSE_MIN_DAYS distinct UTC days inside
 *    the 7-day window — one skipped or failed attempt proves nothing
 *    (a head-moved skip often self-resolves when the PR closes or its
 *    head settles).
 *  - Unknown stays unknown. Malformed lines, rows missing pr/outcome/at,
 *    unknown outcomes and non-string reasons are skipped, never guessed;
 *    unrecognized skip reasons fold into the other-skip cell rather than
 *    being dropped; a truncated tail still yields honest lower-bound
 *    counts and says so in the prompt.
 *  - Dedup is downstream. Item ids hash the cell kind + repository + PR
 *    (never the counts or timestamps), so a refresh re-derives the same
 *    id and appendUserBacklogItems adds only what is new.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, reason strings are scrubbed, flattened and capped,
 *    and the brief names the journal, the writer and its self-tick feeder
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

/** Items one call may emit; the repo's cell set is small and closed. */
export const LANDED_CLOSE_MAX_ITEMS = 8;
const LANDED_CLOSE_ITEM_HARD_MAX = 25;
/** The window every fold anchors on: the fleet's recurring-evidence week. */
export const LANDED_CLOSE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Adverse rows one cell needs inside the window… */
export const LANDED_CLOSE_MIN_ROWS = 3;
/** …spread across at least this many distinct UTC days. */
export const LANDED_CLOSE_MIN_DAYS = 2;
/**
 * Bounded tail for the journal. Self-tick's landed-sweep attempts at most
 * its --limit (default 5) closes per applied pass on a ~15-minute cadence —
 * under ~62 KiB/day worst case — so 1 MiB retains well over the 7-day
 * window even at maximum volume.
 */
export const LANDED_CLOSE_TAIL_BYTES = 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded text is unbounded; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** Distinct recorded reason strings quoted inside one prompt before the remainder is summarized. */
const PROMPT_REASONS_MAX = 3;
/** Distinct skip-reason strings tracked per PR for the other-skip cell. */
const TRACK_REASONS_MAX = 8;
/** The journal's path inside the fleet runs dir (fleet-landed-close.ts appends it). */
const LANDED_CLOSE_JOURNAL_RELATIVE = join('queue', 'landed-closes.jsonl');
/** The repository name the writer hardcodes; the gate matches on it. */
const FLEET_REPO_NAME = 'phantom';
/** The repository name both vocabularies record: the last path segment, lowercased. */
const fleetRepoName = (repo: string): string =>
  (repo.split('/').pop() ?? repo).trim().toLowerCase();

const OUTCOMES = new Set(['closed', 'skipped', 'failed']);
type Outcome = 'closed' | 'skipped' | 'failed';
const HEAD_RE = /^[0-9a-f]{40}$/i;

type CellKind = 'failed' | 'head-moved' | 'view-failed' | 'other-skip';

export interface LandedCloseItemsOptions {
  /** Backlog target in owner/name form; the journal describes the fleet repo only. */
  repo: string;
  /** Journal override (default: <runsDir>/queue/landed-closes.jsonl). */
  journalPath?: string;
  /** Runs dir for the journal default; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default LANDED_CLOSE_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated attempt row inside the journal. */
export interface LandedCloseRow {
  atMs: number;
  utcDay: string;
  pr: number;
  /** The head the dirty-landed report planned the close at, when well-formed. */
  head: string | null;
  outcome: Outcome;
  /** Recorded reason text, or null when the row carries none. */
  reason: string | null;
}

/** Journal-recorded text is unbounded; flatten, scrub and cap before use. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Pure: parse journal text into validated attempt rows. Malformed lines,
 * rows missing pr/outcome/at or carrying an unknown outcome are skipped —
 * never guessed. Mirrors the writer's emitted shape: ISO `at`, positive
 * integer `pr`, 40-hex `head`, outcome in {closed, skipped, failed} and an
 * optional reason string. Extra fields are ignored for forward
 * compatibility.
 */
export function parseLandedCloseJournal(text: string): LandedCloseRow[] {
  const rows: LandedCloseRow[] = [];
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
    const outcome = r['outcome'];
    if (typeof at !== 'string') continue;
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) continue;
    if (typeof pr !== 'number' || !Number.isSafeInteger(pr) || pr <= 0) continue;
    if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) continue;
    const head = r['head'];
    const reason = r['reason'];
    rows.push({
      atMs,
      utcDay: utcDayOf(atMs),
      pr,
      head: typeof head === 'string' && HEAD_RE.test(head) ? head.toLowerCase() : null,
      outcome: outcome as Outcome,
      reason: typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : null,
    });
  }
  return rows;
}

/** One PR's (or the view-failed cell's) adverse-row track inside the window. */
interface AdverseTrack {
  rows: number;
  days: Set<string>;
  firstMs: number;
  lastMs: number;
  /** Distinct planned heads seen on the rows (bounded by the tail read). */
  heads: Set<string>;
  /** Deduped bounded reason strings, for prompt evidence. */
  reasons: string[];
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
  heads: new Set(),
  reasons: [],
});

function trackRow(track: AdverseTrack, row: LandedCloseRow, reasonMax = TRACK_REASONS_MAX): void {
  track.rows += 1;
  track.days.add(row.utcDay);
  track.firstMs = Math.min(track.firstMs, row.atMs);
  track.lastMs = Math.max(track.lastMs, row.atMs);
  if (row.head !== null) track.heads.add(row.head);
  if (row.reason !== null) {
    const text = fieldText(row.reason);
    if (text !== '' && !track.reasons.includes(text) && track.reasons.length < reasonMax) {
      track.reasons.push(text);
    }
  }
}

/** The fold's output: per-PR cells plus the global view-failed tally. */
export interface LandedCloseFold {
  /** pr → 'failed' attempt track. */
  failed: Map<number, AdverseTrack>;
  /** pr → recurring 'head-moved' skip track. */
  headMoved: Map<number, AdverseTrack>;
  /** pr → recurring skip track whose reason is outside the known vocabulary. */
  otherSkip: Map<number, AdverseTrack>;
  /** 'view-failed' skips across all PRs — the gh read path itself. */
  viewFailed: AdverseTrack & { prs: Set<number> };
}

const newFold = (): LandedCloseFold => ({
  failed: new Map(),
  headMoved: new Map(),
  otherSkip: new Map(),
  viewFailed: { ...newTrack(), prs: new Set() },
});

/**
 * Pure: fold validated rows into the adverse cells. Rows outside the
 * window contribute nothing. 'closed' rows are explained outcomes and
 * never fold; 'skipped' rows classify by their recorded reason —
 * 'head-moved' and 'view-failed' are the writer's documented vocabulary,
 * anything else (including a missing reason) lands in other-skip so a
 * vocabulary change stays visible.
 */
export function foldLandedCloseRows(
  rows: readonly LandedCloseRow[],
  nowMs: number,
  windowMs: number = LANDED_CLOSE_WINDOW_MS,
): LandedCloseFold {
  const fold = newFold();
  const windowStart = nowMs - windowMs;
  const perPr = (map: Map<number, AdverseTrack>, pr: number): AdverseTrack => {
    let track = map.get(pr);
    if (track === undefined) {
      track = newTrack();
      map.set(pr, track);
    }
    return track;
  };
  for (const row of rows) {
    if (row.atMs < windowStart) continue;
    if (row.outcome === 'failed') {
      trackRow(perPr(fold.failed, row.pr), row);
    } else if (row.outcome === 'skipped') {
      if (row.reason === 'head-moved') {
        trackRow(perPr(fold.headMoved, row.pr), row);
      } else if (row.reason === 'view-failed') {
        trackRow(fold.viewFailed, row);
        fold.viewFailed.prs.add(row.pr);
      } else {
        trackRow(perPr(fold.otherSkip, row.pr), row);
      }
    }
  }
  return fold;
}

const WINDOW_DAYS = Math.round(LANDED_CLOSE_WINDOW_MS / 86_400_000);
const daySpan = (first: number, last: number): number =>
  Math.max(1, Math.round((last - first) / 86_400_000));

const NO_CHANGE = 'If the window has rolled forward, the PR closed or moved since, or the cause is owner-only (credentials, billing, a protected gate or sandbox profile) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is queue/landed-closes.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), appended by `ashlr fleet landed-close --apply` (src/cli/fleet-landed-close.ts) — one {at, pr, head, outcome, reason?} row per attempted close, mode 0600, the run stopping at the first failure — fed every applied self-tick by step 14\'s landed-sweep (src/cli/fleet-landed-sweep.ts piping the fleet dirty-landed report into landed-close\'s stdin). Its only other readers are point-in-time displays: readLandedCloses (src/core/fleet/landed-closes-read.ts) backs the Verse Live home card over the last 256 KiB / 24 h, and queue/self-tick.jsonl carries only the sweep\'s aggregate closed=/planned= counts — until this feed no reader folded the window.';

const truncationNote = (truncated: boolean): string =>
  truncated ? ' The journal tail was truncated, so these counts cover only the retained bytes — treat every tally as a lower bound.' : '';

const spanText = (track: AdverseTrack): string =>
  `first ${new Date(track.firstMs).toISOString()}, last ${new Date(track.lastMs).toISOString()}`;

const reasonsText = (track: AdverseTrack): string =>
  track.reasons.length === 0
    ? ''
    : ` Recorded reason(s): ${track.reasons.slice(0, PROMPT_REASONS_MAX).map((r) => `'${r}'`).join(', ')}${track.reasons.length > PROMPT_REASONS_MAX ? `, and ${track.reasons.length - PROMPT_REASONS_MAX} more distinct` : ''}.`;

const meetsBar = (track: AdverseTrack): boolean =>
  track.rows >= LANDED_CLOSE_MIN_ROWS && track.days.size >= LANDED_CLOSE_MIN_DAYS;

/** Per-PR cells sorted by recorded rows then PR number — deterministic across refreshes. */
function sortedCells(map: Map<number, AdverseTrack>): Array<{ pr: number; track: AdverseTrack }> {
  return [...map.entries()]
    .map(([pr, track]) => ({ pr, track }))
    .sort((a, b) => b.track.rows - a.track.rows || a.pr - b.pr);
}

function failedPrompt(pr: number, track: AdverseTrack, repo: string, truncated: boolean): string {
  const heads = track.heads.size;
  return [
    `\`ashlr fleet landed-close\` keeps failing to close PR #${pr} on ${repo} — every applied sweep's \`gh pr close\` errors out on this pull request.`,
    '',
    `Inside the ${WINDOW_DAYS}-day journal window the ledger recorded ${track.rows} 'failed' attempt(s) for PR #${pr} across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)}), under ${heads} distinct planned head(s).${reasonsText(track)}${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Each 'failed' row is one \`gh pr close ${pr} --repo ${repo}\` attempt that exited non-zero or threw; the run stops at the first failure, so while this PR tops the plan every later landed PR waits behind it. The PR's changed paths already match master — only the bookkeeping is stuck — but a close that keeps failing leaves it DIRTY-flagged forever. Find why the close fails: gh authentication or token scope on the host, branch-protection or ruleset refusals, a PR state gh cannot close, or a stuck runner; queue/self-tick.jsonl's landed-sweep step records the same failure as a step error when the run exits non-zero. Reproduce with \`gh pr view ${pr} --repo ${repo} --json state,headRefOid\` then \`gh pr close ${pr} --repo ${repo}\` once the cause is known — or fix the close path if the reason is systemic. If the PR has since closed or its plan moved on — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function headMovedPrompt(pr: number, track: AdverseTrack, repo: string, truncated: boolean): string {
  const heads = track.heads.size;
  return [
    `\`ashlr fleet landed-close\` keeps skipping PR #${pr} on ${repo} as 'head-moved' — between the dirty-landed report and the close re-read, the pull request's head or state keeps changing.`,
    '',
    `Inside the ${WINDOW_DAYS}-day journal window the ledger recorded ${track.rows} 'head-moved' skip(s) for PR #${pr} across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)}), under ${heads} distinct planned head(s).${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Each 'head-moved' skip means the \`gh pr view\` re-read found the PR no longer OPEN at the head the dirty-landed report recorded — either new commits moved headRefOid, or the PR left OPEN state (merged or closed by hand). While the head keeps moving, every sweep re-plans the PR at its new head and skips again: work is being pushed onto a pull request whose changed paths already match master, churn the sweeper can never converge on. Find what keeps pushing to this branch — the producer that minted it may still be running, or rebase/review bots are active; land the PR's remaining intent deliberately, close it by hand, or stop the producer. If the PR has since closed or stayed put across sweeps — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function viewFailedPrompt(track: AdverseTrack & { prs: Set<number> }, repo: string, truncated: boolean): string {
  return [
    `\`ashlr fleet landed-close\` keeps failing its \`gh pr view\` re-reads on ${repo} — the close path cannot verify PR state, so every attempted close skips as 'view-failed'.`,
    '',
    `Inside the ${WINDOW_DAYS}-day journal window the ledger recorded ${track.rows} 'view-failed' skip(s) across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)}), spanning ${track.prs.size} distinct PR(s). Skips never fail the sweep, so the self-tick step still reports success while no landed PR can close.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Each 'view-failed' skip means \`gh pr view <n> --repo ${repo} --json headRefOid,state\` exited non-zero or returned unparseable JSON — the sweeper refuses to close on a stale plan, so nothing closes while reads fail. Recurring view failures across many distinct PRs point at the gh read path itself — authentication, rate limits, or gh/network health on the host — rather than any one pull request. Check \`gh auth status\`, gh's rate-limit budget and ~/.ashlr-runs/logs/ for self-tick stderr; queue/self-tick.jsonl shows whether sibling steps are erroring too. If recent sweeps read and closed cleanly — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function otherSkipPrompt(pr: number, track: AdverseTrack, repo: string, truncated: boolean): string {
  const reasons = track.reasons.slice(0, PROMPT_REASONS_MAX).map((r) => `'${r}'`).join(', ');
  const reasonBit = reasons === '' ? 'with no recorded reason' : `with recorded reason(s) ${reasons}`;
  return [
    `\`ashlr fleet landed-close\` keeps recording 'skipped' attempts on PR #${pr} on ${repo} ${reasonBit} — outside the ledger's documented skip vocabulary, so the cause is not named by the row alone.`,
    '',
    `Inside the ${WINDOW_DAYS}-day journal window the ledger recorded ${track.rows} such skip(s) for PR #${pr} across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)}).${track.reasons.length > PROMPT_REASONS_MAX ? ` ${track.reasons.length - PROMPT_REASONS_MAX} further distinct reason(s) were recorded.` : ''}${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `The writer's skipReason (src/cli/fleet-landed-close.ts) emits only 'view-failed' (the gh pr view re-read failed) and 'head-moved' (state or head changed); rows ${reasonBit} mean either the writer gained a skip class this feed does not know, or the ledger rows drifted from the writer's contract. Find which: read the current skipReason branches and the ledger rows for PR #${pr}, and check whether a newer landed-close build writes reasons the fold should classify. If the rows are malformed or the vocabulary is unchanged — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function itemId(kind: CellKind, repo: string, pr: number | null): string {
  const cell = pr === null ? kind : `${kind}:${pr}`;
  const hash = createHash('sha256').update(`landed-close:${cell}:${repo.toLowerCase()}`).digest('hex').slice(0, 16);
  return `landed-close-${kind}-${hash}`;
}

function makeItem(kind: CellKind, repo: string, pr: number | null, title: string, prompt: string): CloudBacklogItem {
  return {
    id: itemId(kind, repo, pr),
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'landed-close',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the landed-close attempt journal's recurring failed
 * closes, head-moved skips, view failures and unrecognized skips. Total:
 * any read or fold failure yields no items rather than throwing into
 * discovery.
 */
export async function landedCloseBacklogItems(opts: LandedCloseItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const home = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs');
    const journalPath = opts.journalPath ?? join(runsDir, LANDED_CLOSE_JOURNAL_RELATIVE);
    const tail = await readLedgerTail(journalPath, LANDED_CLOSE_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const rows = parseLandedCloseJournal(tail.text);
    const fold = foldLandedCloseRows(rows, nowMs);

    const candidates: CloudBacklogItem[] = [];
    if (meetsBar(fold.viewFailed)) {
      candidates.push(makeItem(
        'view-failed',
        repo,
        null,
        `Landed-close gh reads keep failing on ${repo}`,
        viewFailedPrompt(fold.viewFailed, repo, tail.truncated),
      ));
    }
    for (const { pr, track } of sortedCells(fold.failed)) {
      if (!meetsBar(track)) continue;
      candidates.push(makeItem(
        'failed',
        repo,
        pr,
        `Landed-close keeps failing on PR #${pr} in ${repo}`,
        failedPrompt(pr, track, repo, tail.truncated),
      ));
    }
    for (const { pr, track } of sortedCells(fold.headMoved)) {
      if (!meetsBar(track)) continue;
      candidates.push(makeItem(
        'head-moved',
        repo,
        pr,
        `PR #${pr} keeps moving after landing on ${repo}`,
        headMovedPrompt(pr, track, repo, tail.truncated),
      ));
    }
    for (const { pr, track } of sortedCells(fold.otherSkip)) {
      if (!meetsBar(track)) continue;
      candidates.push(makeItem(
        'other-skip',
        repo,
        pr,
        `Landed-close keeps skipping PR #${pr} on ${repo}`,
        otherSkipPrompt(pr, track, repo, tail.truncated),
      ));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? LANDED_CLOSE_MAX_ITEMS, LANDED_CLOSE_ITEM_HARD_MAX));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}
