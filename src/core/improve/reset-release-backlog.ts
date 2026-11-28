/**
 * Usage-reset release audit journal recurring evidence → self-improvement backlog items.
 *
 * Phantom's autobackoff usage holds carry a `held_until` guess dispatchd
 * enforces on its own (contrib/mac/dispatchd.py ab_unhold expires them),
 * but the ops-side reset-release loop releases a hold earlier whenever it
 * can prove the usage window actually reset. Every applied
 * `ashlr fleet self-tick` runs step 1, `reset-release`
 * (SELF_TICK_STEP_ORDER in src/core/fleet/self-tick.ts), and the ops
 * self-update GET arms the same runResetReleaseOnce pass on a 60-second
 * in-process loop while the desktop is open
 * (src/core/fleet/usage-reset-release.ts). Each pass reads the lane
 * targets and the resource ledger through detectUsageResets
 * (src/core/fleet/usage-reset-detect.ts), releases every autobackoff hold
 * whose detector state is releasable, and appends one audit row per
 * released lane to <runs>/queue/reset-releases.jsonl:
 *
 *   { v: 1, at: <ISO-8601>, by: 'reset-detect', reason: <string>,
 *     lane: <string>, state, usedPct: <number|null>,
 *     readingAsOf: <ISO-8601|null>, heldUntil: <ISO-8601|null> }
 *
 * state is the detector's verdict at release time: 'reset-detected' (a
 * usage reading at or below the 25% reset bar, newer than the hold,
 * proved the window reset — the evidence path working), 'reset-time-passed'
 * (the provider's stated resetAt passed while held — released on clock
 * evidence before any reading confirmed), or 'hold-expired' (the hold's
 * own heldUntil guess had already passed — dispatchd's ab_unhold would
 * have expired it anyway, so the loop added no early release). The row
 * also records the freshest usage reading it saw: usedPct and
 * readingAsOf, null when no usable reading existed.
 *
 * Until now the ledger's only readers were point-in-time — readResetReleases
 * backs GET /api/verse/ops/reset-releases, awaitResetRelease waits on one
 * lane's next row, and the reset-history follower streams new rows to a
 * closed desktop — so a lane whose releases kept landing on expiry or
 * provider-clock guesses instead of measured reset evidence never became
 * work, even though that distribution is exactly the calibration signal
 * for the heldUntil estimator and the reading pipeline.
 * resetReleaseBacklogItems carries the same journal into discoverBacklog:
 *
 *  - 'hold-expired' cells recurring per lane: the lane's autobackoff
 *    holds keep being released by their own until-guess, not by measured
 *    reset evidence — either the guess already matches the provider's
 *    real reset cadence (nothing to fix) or the evidence path never gets
 *    a fresh reading in time (a real gap). The prompt states how many
 *    expiry rows carried a fresh recorded reading still above the
 *    detector's reset bar — releases into a still-exhausted window that
 *    likely re-hold on the next usage-limit hit.
 *  - 'reset-time-passed' cells recurring per lane: the provider's stated
 *    reset time keeps passing while held without any usage reading
 *    confirming the window first — the ledger's readings lag or miss the
 *    reset the provider already announced.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail; nothing is written and no network is touched.
 *    Missing, non-file or unreadable evidence yields no items.
 *  - The journal carries no repository column — it describes this
 *    install's lane-hold machinery — so like the sibling fleet-evidence
 *    feeds, items emit only when the backlog's repo name is the fleet's
 *    own; another repository inherits nothing.
 *  - Rows count only under the writer's contract: v 1, a parseable `at`,
 *    `by` 'reset-detect', a lane inside the dispatcher's lane-name
 *    vocabulary and a state inside the detector's three releasable
 *    verdicts. Malformed lines and off-contract rows are skipped, never
 *    guessed; usedPct/readingAsOf parse-or-null, and a truncated tail
 *    still folds the retained rows with the prompts stating the counts
 *    as lower bounds.
 *  - 'reset-detected' rows are the healthy path and never emit; they
 *    count only as per-lane context inside the adverse prompts. Recurring
 *    means recorded: a cell emits only at RESET_RELEASE_MIN_ROWS adverse
 *    rows across RESET_RELEASE_MIN_DAYS distinct UTC days inside the
 *    7-day window — one expiry release proves nothing.
 *  - Freshness uses the fleet's own bound: a recorded reading counts as
 *    fresh at release when readingAsOf is no more than
 *    USAGE_RUNWAY_STALE_MS (3 h, the usage-runway stale line) before the
 *    release `at` and not stamped past the sibling feeds' future skew.
 *    Stale, missing or unusable readings land in the blind bucket rather
 *    than being guessed either way.
 *  - Dedup is downstream. Item ids hash the cell kind + lane + repo
 *    (never the counts or timestamps), so a refresh re-derives the same
 *    id and appendUserBacklogItems adds only what is new; shifted tallies
 *    do not spawn twin items and a lane that stops recurring simply
 *    stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, lane names come from the validated lane
 *    vocabulary, and the brief names the journal, the writer, the
 *    detector and the dispatchd hold machinery with the usual no-change
 *    escape when the window no longer reproduces or the cause is
 *    owner-only.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { RESET_DETECT_USED_PCT_MAX } from '../fleet/usage-reset-detect.js';
import { USAGE_RUNWAY_STALE_MS } from '../fleet/usage-history.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; the lane set is small and closed. */
export const RESET_RELEASE_MAX_ITEMS = 8;
const RESET_RELEASE_ITEM_HARD_MAX = 25;
/** The window every fold anchors on: the fleet's recurring-evidence week. */
export const RESET_RELEASE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Future-skew ceiling on journal `at` stamps, the sibling feeds'
 * one-minute tolerance for same-host clock drift: a row stamped further
 * ahead than the evaluation time is corrupt or replayed evidence and
 * never reaches a cell.
 */
export const RESET_RELEASE_FUTURE_SKEW_MS = 60_000;
/** Adverse rows one cell needs inside the window… */
export const RESET_RELEASE_MIN_ROWS = 3;
/** …spread across at least this many distinct UTC days. */
export const RESET_RELEASE_MIN_DAYS = 2;
/**
 * Bounded tail for the journal. One row lands per released lane per pass
 * on a ~60 s armed loop or ~15-minute self-tick — a few hundred bytes
 * each, tens of rows a day at most — so 512 KiB retains far more than the
 * 7-day window even under a mass expiry.
 */
export const RESET_RELEASE_TAIL_BYTES = 512 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The journal's path inside the fleet runs dir (usage-reset-release.ts appends it). */
const RESET_RELEASE_JOURNAL_RELATIVE = join('queue', 'reset-releases.jsonl');
/** The only releaser identity the writer records. */
const RELEASED_BY = 'reset-detect';
/** The fleet's own repository label: reset evidence is this install's machinery. */
const FLEET_REPO_NAME = 'phantom';
/** Lane identifiers the detector writes (dispatchd lane names). */
const LANE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The repository name both vocabularies record: the last path segment, lowercased. */
const fleetRepoName = (repo: string): string =>
  (repo.split('/').pop() ?? repo).trim().toLowerCase();

const STATES = new Set(['reset-detected', 'reset-time-passed', 'hold-expired'] as const);
type ReleaseState = 'reset-detected' | 'reset-time-passed' | 'hold-expired';
type CellKind = 'hold-expired' | 'reset-time-passed';

export interface ResetReleaseItemsOptions {
  /** Backlog target in owner/name form; the journal describes the fleet repo only. */
  repo: string;
  /** Journal override (default: <runsDir>/queue/reset-releases.jsonl). */
  journalPath?: string;
  /** Runs dir for the journal default; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default RESET_RELEASE_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated release row inside the journal. */
export interface ResetReleaseRow {
  atMs: number;
  utcDay: string;
  lane: string;
  state: ReleaseState;
  /** Recorded usedPct, or null when the row carried none usable. */
  usedPct: number | null;
  /** readingAsOf parsed to ms, or null when absent/unparseable. */
  readingMs: number | null;
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Pure: parse journal text into validated release rows. Malformed lines,
 * rows missing at/lane/state/by or carrying an unknown state are skipped —
 * never guessed. Mirrors the writer's emitted shape: v 1, ISO `at`,
 * `by` 'reset-detect', a lane inside the dispatcher vocabulary, state in
 * the detector's three releasable verdicts, and optional usedPct /
 * readingAsOf / heldUntil / reason fields parsed tolerantly. Extra
 * fields are ignored for forward compatibility.
 */
export function parseResetReleaseJournal(text: string): ResetReleaseRow[] {
  const rows: ResetReleaseRow[] = [];
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
    if (r['v'] !== 1) continue;
    const at = r['at'];
    if (typeof at !== 'string') continue;
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) continue;
    if (r['by'] !== RELEASED_BY) continue;
    const lane = r['lane'];
    if (typeof lane !== 'string' || !LANE.test(lane)) continue;
    const state = r['state'];
    if (typeof state !== 'string' || !STATES.has(state as ReleaseState)) continue;
    const usedPct = r['usedPct'];
    const readingAsOf = r['readingAsOf'];
    const readingMs = typeof readingAsOf === 'string' ? Date.parse(readingAsOf) : Number.NaN;
    rows.push({
      atMs,
      utcDay: utcDayOf(atMs),
      lane,
      state: state as ReleaseState,
      usedPct: typeof usedPct === 'number' && Number.isFinite(usedPct) ? usedPct : null,
      readingMs: Number.isFinite(readingMs) ? readingMs : null,
    });
  }
  return rows;
}

/** One cell's adverse-row track inside the window. */
interface AdverseTrack {
  rows: number;
  days: Set<string>;
  firstMs: number;
  lastMs: number;
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
});

function trackRow(track: AdverseTrack, row: ResetReleaseRow): void {
  track.rows += 1;
  track.days.add(row.utcDay);
  track.firstMs = Math.min(track.firstMs, row.atMs);
  track.lastMs = Math.max(track.lastMs, row.atMs);
}

/** One lane's in-window release evidence. */
export interface LaneReleaseFold {
  lane: string;
  /** Every validated release row for the lane inside the window. */
  total: number;
  /** Distinct UTC days with any release — context for the span text. */
  days: Set<string>;
  /** 'reset-detected' rows — the healthy evidence path, context only. */
  detected: number;
  /** 'hold-expired' track plus its recorded-reading buckets. */
  expired: AdverseTrack & {
    /** Fresh reading still above the detector's reset bar at release. */
    freshExhausted: number;
    /** Fresh reading at or below the bar at release. */
    freshBelow: number;
    /** No fresh usable reading to judge the window by at release. */
    blind: number;
  };
  /** 'reset-time-passed' track — provider-clock releases. */
  timePassed: AdverseTrack;
}

/** The fold's output: lane → its release evidence inside the window. */
export type ResetReleaseFold = Map<string, LaneReleaseFold>;

const newLaneFold = (lane: string): LaneReleaseFold => ({
  lane,
  total: 0,
  days: new Set(),
  detected: 0,
  expired: { ...newTrack(), freshExhausted: 0, freshBelow: 0, blind: 0 },
  timePassed: newTrack(),
});

/** A recorded reading is fresh at release inside the fleet's own stale bound. */
function freshReading(row: ResetReleaseRow): boolean {
  if (row.readingMs === null) return false;
  return row.readingMs <= row.atMs + RESET_RELEASE_FUTURE_SKEW_MS
    && row.atMs - row.readingMs <= USAGE_RUNWAY_STALE_MS;
}

/**
 * Pure: fold validated rows into per-lane release evidence. Rows outside
 * the window — before its start or past the evaluation time plus the
 * sibling feeds' future skew — contribute nothing. 'reset-detected' rows
 * count as healthy-path context only; 'hold-expired' rows additionally
 * bucket by the freshness of their recorded reading so the prompt can
 * state how many releases fired while the window still read exhausted,
 * still read recovered, or blind.
 */
export function foldResetReleaseRows(
  rows: readonly ResetReleaseRow[],
  nowMs: number,
  windowMs: number = RESET_RELEASE_WINDOW_MS,
): ResetReleaseFold {
  const fold: ResetReleaseFold = new Map();
  const windowStart = nowMs - windowMs;
  const until = nowMs + RESET_RELEASE_FUTURE_SKEW_MS;
  for (const row of rows) {
    if (row.atMs < windowStart || row.atMs > until) continue;
    let cell = fold.get(row.lane);
    if (cell === undefined) {
      cell = newLaneFold(row.lane);
      fold.set(row.lane, cell);
    }
    cell.total += 1;
    cell.days.add(row.utcDay);
    if (row.state === 'reset-detected') {
      cell.detected += 1;
    } else if (row.state === 'hold-expired') {
      trackRow(cell.expired, row);
      if (!freshReading(row) || row.usedPct === null) cell.expired.blind += 1;
      else if (row.usedPct > RESET_DETECT_USED_PCT_MAX) cell.expired.freshExhausted += 1;
      else cell.expired.freshBelow += 1;
    } else {
      trackRow(cell.timePassed, row);
    }
  }
  return fold;
}

const WINDOW_DAYS = Math.round(RESET_RELEASE_WINDOW_MS / 86_400_000);
const daySpan = (first: number, last: number): number =>
  Math.max(1, Math.round((last - first) / 86_400_000));

const NO_CHANGE = 'If the window has rolled forward, the lane\'s holds since stopped recurring, the heldUntil guesses already match the provider\'s real reset cadence, or the right fix is owner-only (provider credentials, billing, a protected gate) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is queue/reset-releases.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): runResetReleaseOnce (src/core/fleet/usage-reset-release.ts) appends one {v, at, by, reason, lane, state, usedPct, readingAsOf, heldUntil} audit row per lane hold it releases — fed by the self-tick reset-release step (the first step of SELF_TICK_STEP_ORDER in src/core/fleet/self-tick.ts, run by every applied `ashlr fleet self-tick`) and by the in-process loop the ops self-update GET arms on a 60-second cadence. state is detectUsageResets\' verdict (src/core/fleet/usage-reset-detect.ts) at release time: \'reset-detected\' (a usage reading at or below the 25% reset bar, newer than the hold, proved the window reset), \'reset-time-passed\' (the provider\'s stated resetAt passed while held), or \'hold-expired\' (the hold\'s own heldUntil guess had already passed — dispatchd\'s ab_unhold in contrib/mac/dispatchd.py expires such holds on its own, so the loop added no early release). Its only readers are point-in-time: readResetReleases backs GET /api/verse/ops/reset-releases, awaitResetRelease waits on one lane\'s next row, and the reset-history follower streams new rows — until this feed no reader folded the window.';

const truncationNote = (truncated: boolean): string =>
  truncated ? ' The journal tail was truncated, so these counts cover only the retained bytes — treat every tally as a lower bound.' : '';

const spanText = (track: { firstMs: number; lastMs: number }): string =>
  `first ${new Date(track.firstMs).toISOString()}, last ${new Date(track.lastMs).toISOString()}`;

const meetsBar = (track: AdverseTrack): boolean =>
  track.rows >= RESET_RELEASE_MIN_ROWS && track.days.size >= RESET_RELEASE_MIN_DAYS;

const contextText = (cell: LaneReleaseFold): string => {
  const parts = [`${cell.total} total release(s)`];
  if (cell.detected > 0) parts.push(`${cell.detected} 'reset-detected'`);
  if (cell.timePassed.rows > 0) parts.push(`${cell.timePassed.rows} 'reset-time-passed'`);
  return parts.join(', ');
};

function expiredPrompt(cell: LaneReleaseFold, truncated: boolean): string {
  const e = cell.expired;
  const buckets = `Of those rows, ${e.freshExhausted} carried a fresh recorded reading (at or under the ${Math.round(USAGE_RUNWAY_STALE_MS / 3_600_000)} h usage-runway stale bound) still above the detector's ${RESET_DETECT_USED_PCT_MAX}% reset bar, ${e.freshBelow} carried a fresh reading at or below it, and ${e.blind} had no fresh usable reading to judge the window by.`;
  return [
    `Phantom's usage-reset release loop keeps recording 'hold-expired' releases on lane '${cell.lane}' — autobackoff holds whose own heldUntil guess expired before measured reset evidence released them.`,
    '',
    `Inside the ${WINDOW_DAYS}-day journal window the audit recorded ${e.rows} 'hold-expired' release(s) for lane '${cell.lane}' across ${e.days.size} distinct UTC day(s) (${daySpan(e.firstMs, e.lastMs)}-day span, ${spanText(e)}); the lane's window totals ${contextText(cell)}.${truncationNote(truncated)}`,
    '',
    buckets,
    '',
    EVIDENCE,
    '',
    `An expiry-justified release means dispatchd's ab_unhold would have freed the lane at the same moment anyway — the evidence loop added no early release for this hold. Recurring expiry releases say one of two things: the heldUntil guesses dispatchd computes (ab_reset parsing the provider's stated reset, the AB_DEF default and AB_CAP ceiling in contrib/mac/dispatchd.py) already track the real windows and there is nothing to fix, or the detector never gets a fresh-enough reading to fire 'reset-detected' first — a usage-reading freshness or coverage gap for this lane's provider. Check which: the resource ledger's observation cadence for the lane's provider (usage producers, claude-quota-refresh), whether resetAt readings propagate into resource-reset-evidence, and whether the ${RESET_DETECT_USED_PCT_MAX}% bar fits this lane's real post-reset level. Rows whose fresh reading still showed the window exhausted were released into a likely still-limited window and probably re-held on the next usage-limit hit — recurring freshExhausted rows point at heldUntil undershooting the real reset. If the guesses prove tight and the evidence path verified working — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function timePassedPrompt(cell: LaneReleaseFold, truncated: boolean): string {
  const t = cell.timePassed;
  return [
    `Phantom's usage-reset release loop keeps recording 'reset-time-passed' releases on lane '${cell.lane}' — holds released because the provider's stated reset time passed while held, before any usage reading confirmed the window reset.`,
    '',
    `Inside the ${WINDOW_DAYS}-day journal window the audit recorded ${t.rows} 'reset-time-passed' release(s) for lane '${cell.lane}' across ${t.days.size} distinct UTC day(s) (${daySpan(t.firstMs, t.lastMs)}-day span, ${spanText(t)}); the lane's window totals ${contextText(cell)}.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `A 'reset-time-passed' release fires on the provider's own resetAt carried by the resource ledger — clock evidence, not a measured window. Recurring clock releases mean the usage readings feeding detectUsageResets keep lagging or missing the reset the provider already announced, so the lane waits on resetAt instead of proving recovery early. Check the reading pipeline for this lane's provider: how fresh the resource ledger's observations stay between usage producers' writes, whether resetAt propagates ahead of the next reading, and whether 'reset-detected' ever fires for this lane at all (${cell.detected} recorded in the window). If readings verified fresh and the windows genuinely reset only at the stated time — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

interface Candidate {
  kind: CellKind;
  lane: string;
  rows: number;
  item: CloudBacklogItem;
}

function itemId(kind: CellKind, lane: string, repo: string): string {
  const hash = createHash('sha256').update(`reset-release:${kind}:${lane}:${repo.toLowerCase()}`).digest('hex').slice(0, 16);
  return `reset-release-${kind}-${hash}`;
}

function makeItem(kind: CellKind, lane: string, repo: string, title: string, prompt: string): CloudBacklogItem {
  return {
    id: itemId(kind, lane, repo),
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'reset-release',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

const KIND_TITLE: Record<CellKind, (lane: string) => string> = {
  'hold-expired': (lane) => `Lane '${lane}' keeps releasing usage holds by expiry`,
  'reset-time-passed': (lane) => `Lane '${lane}' keeps releasing usage holds on provider reset time`,
};

/**
 * Backlog items for the reset-release audit journal's recurring
 * expiry-justified and provider-clock-justified lane-hold releases.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function resetReleaseBacklogItems(opts: ResetReleaseItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const home = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs');
    const journalPath = opts.journalPath ?? join(runsDir, RESET_RELEASE_JOURNAL_RELATIVE);
    const tail = await readLedgerTail(journalPath, RESET_RELEASE_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const rows = parseResetReleaseJournal(tail.text);
    const fold = foldResetReleaseRows(rows, nowMs);

    const candidates: Candidate[] = [];
    for (const cell of fold.values()) {
      if (meetsBar(cell.expired)) {
        candidates.push({
          kind: 'hold-expired',
          lane: cell.lane,
          rows: cell.expired.rows,
          item: makeItem('hold-expired', cell.lane, repo, KIND_TITLE['hold-expired'](cell.lane), expiredPrompt(cell, tail.truncated)),
        });
      }
      if (meetsBar(cell.timePassed)) {
        candidates.push({
          kind: 'reset-time-passed',
          lane: cell.lane,
          rows: cell.timePassed.rows,
          item: makeItem('reset-time-passed', cell.lane, repo, KIND_TITLE['reset-time-passed'](cell.lane), timePassedPrompt(cell, tail.truncated)),
        });
      }
    }
    // Strongest recorded evidence first; identity fields last so the order is total.
    candidates.sort((a, b) =>
      b.rows - a.rows
      || a.lane.localeCompare(b.lane)
      || a.kind.localeCompare(b.kind));
    const limit = Math.max(1, Math.min(opts.limit ?? RESET_RELEASE_MAX_ITEMS, RESET_RELEASE_ITEM_HARD_MAX));
    return candidates.slice(0, limit).map((c) => c.item);
  } catch {
    return [];
  }
}
