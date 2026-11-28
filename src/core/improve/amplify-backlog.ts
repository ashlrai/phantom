/**
 * amplify advisory journal → self-improvement backlog items.
 *
 * The vision leader's offline advisory pass (amplifyTick in
 * src/core/amplify/index.ts, driven once per leader tick from
 * src/core/vision/leader.ts and on demand by `phm amplify tick`)
 * projects the fleet's capacity evidence — the resources ledger,
 * budget overrides, queue status, controller signals and fleet
 * heartbeats — into an AmplifySnapshot (projectAmplify in
 * src/core/amplify/snapshot.ts) and appends it to
 * <runs>/metrics/amplify.jsonl as one amplify.tick.v1 record:
 *
 *   {schema: 'amplify.tick.v1', type: 'ADVISORY', advisory: true,
 *    at, objective, pools: [...], vitals: {...},
 *    merge_velocity: {window_hours: 1, merged_per_hour},
 *    heartbeat: {stale, sources: [...]}, actions: [...], sources: {...}}
 *
 *   - actions is the engine's whole adverse vocabulary: the only
 *     records projectAmplify ever proposes are 'refresh-evidence'
 *     (a pool's quota/burn/reset evidence unusable, or no pool rows
 *     at all), 'check-heartbeat' (fleet heartbeat sources stale),
 *     'use-expiring-capacity' (a pool projected to waste >=10% of
 *     included capacity within 24h of reset/expiry),
 *     'review-saturation' (a lane's running/target >= 1) and
 *     'review-merge-flow' (lanes running with zero recorded merges
 *     in the last hour). Each carries {kind, pool, priority,
 *     recommendation}; pool is a ledger key or null for the
 *     fleet-scope kinds.
 *
 * Until now the journal's only reader was… nothing: amplifyTick is
 * a write-only append sink — readAmplifyStatus re-reads the live
 * source files and readAmplifyGoal reads leader/decisions.jsonl, so
 * the recorded tick history had no reader at all. A pool whose
 * expiring capacity kept going unused, whose quota evidence stayed
 * unknown tick after tick, or a fleet whose heartbeats or merge
 * flow kept alarming looked identical to a healthy quiet week —
 * the advisory engine kept recommending the same work and nobody
 * ever saw the recommendation recur. amplifyBacklogItems carries
 * the journal into discoverBacklog like the sibling fleet-evidence
 * feeds.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no network,
 *    launchctl or process is touched. A missing file is the
 *    writer's normal first-run state — a fresh install whose leader
 *    ticks never reached an advisory pass is clean, not degraded;
 *    an unreadable one is counted in the prompt's coverage note and
 *    a truncated tail folds the retained rows flagged as a lower
 *    bound.
 *  - Rows count only under the writer's contract. A tick needs the
 *    amplify.tick.v1 schema, the ADVISORY type marker, advisory
 *    true and a parseable `at`; its actions array must be present,
 *    and each action entry counts only with a kind inside the
 *    producer's closed five-value vocabulary, a pool that is null
 *    or passes the writer's own name() shape (lowercase ledger key,
 *    never a token/secret/password-shaped string) and a finite
 *    numeric priority. Malformed lines and off-contract rows are
 *    counted, never guessed; malformed action entries inside an
 *    otherwise-valid tick are dropped, never quoted.
 *  - Every recorded action is evidence — projectAmplify only
 *    proposes for the five adverse conditions, so there is no
 *    designed-state exclusion. Recurring means recorded across
 *    ticks and days: a (kind, pool) cell emits only at
 *    AMPLIFY_MIN_TICKS recommending ticks across
 *    AMPLIFY_MIN_DAYS distinct UTC days inside the 7-day window,
 *    so one alarmed afternoon or a single deploy's evidence gap
 *    never queues a session.
 *  - The journal describes this install's capacity evidence and
 *    carries no repository column, so items emit only when the
 *    backlog target's repository name is 'phantom' — the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - Dedup is downstream. The item id hashes the (kind, pool)
 *    cell only — never the tallies, priorities or timestamps — so
 *    a refresh re-derives the same id and appendUserBacklogItems
 *    adds only what is new; a pool whose evidence recovers simply
 *    stops re-adding.
 *  - Pool keys and priorities are recorded metadata, never free
 *    text: prompts quote the kind, the pool key (already inside
 *    the writer's name() vocabulary) and the recorded counts —
 *    the recommendation string itself is template text derived
 *    from the same fields and is never quoted.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { parseLedgerTs } from '../metrics/loop.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; cells are bounded by kind x pool diversity. */
export const AMPLIFY_BACKLOG_MAX_ITEMS = 8;
const AMPLIFY_ITEM_HARD_MAX = 25;
/** Recommending ticks a cell needs inside the window before it counts as recurring. */
export const AMPLIFY_MIN_TICKS = 3;
/** Distinct UTC days those ticks must span — recurring means recorded across days. */
export const AMPLIFY_MIN_DAYS = 2;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const AMPLIFY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on tick timestamps, same convention the sibling folds tolerate. */
const AMPLIFY_FUTURE_SKEW_MS = 60_000;
/**
 * Bounded tail for the advisory journal. Rows run ~16 KB (the pools,
 * heartbeat sources and per-source states dominate), so 8 MiB covers
 * roughly 500 ticks — several days at the leader's ~10-minute cadence;
 * a contract-violating larger file still folds its newest rows flagged
 * as a lower bound.
 */
export const AMPLIFY_TAIL_BYTES = 8 * 1024 * 1024;
/** Journal path under the runs root: metrics/amplify.jsonl, amplifyRunsDir()'s own layout. */
const AMPLIFY_JOURNAL_RELATIVE = join('metrics', 'amplify.jsonl');
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: amplify evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The writer's pool-key contract (name() in src/core/amplify/snapshot.ts), inlined so this reader validates the persisted shape without importing the projection. */
const POOL_RE = /^[a-z][a-z0-9-]{0,63}$/;
const POOL_FORBIDDEN_RE = /token|secret|password/;
/** The writer's journal-row schema literal (amplifyTick in src/core/amplify/index.ts), inlined for the same reason. */
const AMPLIFY_TICK_SCHEMA = 'amplify.tick.v1';

/**
 * The producer's action-kind vocabulary, mirrored from AmplifyAction in
 * src/core/amplify/snapshot.ts — the only kinds projectAmplify ever
 * proposes. Anything else is off-contract and never counts.
 */
export type AmplifyActionKind =
  | 'refresh-evidence'
  | 'check-heartbeat'
  | 'use-expiring-capacity'
  | 'review-saturation'
  | 'review-merge-flow';

const AMPLIFY_ACTION_KINDS: ReadonlySet<string> = new Set<AmplifyActionKind>([
  'refresh-evidence',
  'check-heartbeat',
  'use-expiring-capacity',
  'review-saturation',
  'review-merge-flow',
]);

export interface AmplifyItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/amplify.jsonl; $ASHLR_RUNS_DIR wins when set, else <home>/.ashlr-runs. */
  runsDir?: string;
  /** Journal override (default: join(runsDir, 'metrics', 'amplify.jsonl'), the producer's own layout). */
  journalPath?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default AMPLIFY_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Evidence window in ms (default AMPLIFY_WINDOW_MS). */
  windowMs?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated action entry inside a tick: the recorded recommendation's closed-vocabulary identity. */
export interface AmplifyActionRec {
  kind: AmplifyActionKind;
  /** Ledger pool key, or null for the fleet-scope kinds. */
  pool: string | null;
  /** The priority the tick recorded for the recommendation (finite number, never guessed). */
  priority: number;
}

/** One validated amplify.tick.v1 row: a completed advisory pass and its recommended actions. */
export interface AmplifyTick {
  atMs: number;
  utcDay: string;
  actions: AmplifyActionRec[];
}

/** One (kind, pool) cell: the recurring recommendation identity the prompt quotes. */
export interface AmplifyCell {
  kind: AmplifyActionKind;
  pool: string | null;
  /** Distinct in-window ticks that recommended this cell at least once. */
  ticks: number;
  /** Distinct UTC days the cell's ticks fall on. */
  days: number;
  /** Highest priority any in-window tick recorded for the cell. */
  maxPriority: number;
  /** ISO bounds of the cell's recorded ticks; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the journal's bounded tail cut older rows: counts are a lower bound. */
  lowerBound: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Pure: validate one action entry against the writer's contract — a kind
 * inside the closed five-value vocabulary, a pool that is null or passes
 * the writer's own name() shape, a finite numeric priority and a string
 * recommendation (required by the contract, never quoted into prompts).
 * Anything else is not an action record.
 */
export function parseAmplifyActionEntry(value: unknown): AmplifyActionRec | null {
  if (!isRecord(value)) return null;
  const kind = value['kind'];
  if (typeof kind !== 'string' || !AMPLIFY_ACTION_KINDS.has(kind)) return null;
  const pool = value['pool'];
  if (pool !== null && (typeof pool !== 'string' || !POOL_RE.test(pool) || POOL_FORBIDDEN_RE.test(pool))) return null;
  const priority = value['priority'];
  if (typeof priority !== 'number' || !Number.isFinite(priority)) return null;
  if (typeof value['recommendation'] !== 'string') return null;
  return { kind: kind as AmplifyActionKind, pool: pool as string | null, priority };
}

/**
 * Pure: validate one parsed amplify.jsonl line against the writer's
 * amplifyTick contract — the amplify.tick.v1 schema, the ADVISORY type
 * marker, advisory true, a parseable `at` timestamp and an actions
 * array. Action entries are validated individually by the fold.
 * Anything else is not a tick row.
 */
export function parseAmplifyTickEntry(value: unknown): AmplifyTick | null {
  if (!isRecord(value)) return null;
  if (value['schema'] !== AMPLIFY_TICK_SCHEMA) return null;
  if (value['type'] !== 'ADVISORY' || value['advisory'] !== true) return null;
  const atMs = parseLedgerTs(value['at']);
  if (atMs === null) return null;
  const actions = value['actions'];
  if (!Array.isArray(actions)) return null;
  const recs: AmplifyActionRec[] = [];
  for (const entry of actions) {
    const rec = parseAmplifyActionEntry(entry);
    if (rec !== null) recs.push(rec);
  }
  return { atMs, utcDay: new Date(atMs).toISOString().slice(0, 10), actions: recs };
}

/**
 * Pure: parse one amplify.jsonl file's text into validated ticks plus
 * the count of lines that were not on-contract records — malformed
 * JSON and off-contract rows are counted, never guessed.
 */
export function parseAmplifyJournal(text: string): { ticks: AmplifyTick[]; invalidRows: number } {
  const ticks: AmplifyTick[] = [];
  let invalidRows = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // Cheap prefilter: every valid record names the tick schema.
    if (!trimmed.includes(AMPLIFY_TICK_SCHEMA)) { invalidRows += 1; continue; }
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      invalidRows += 1;
      continue;
    }
    const tick = parseAmplifyTickEntry(value);
    if (tick === null) { invalidRows += 1; continue; }
    ticks.push(tick);
  }
  return { ticks, invalidRows };
}

const inWindow = (atMs: number, windowStartMs: number, nowMs: number): boolean =>
  atMs >= windowStartMs && atMs <= nowMs + AMPLIFY_FUTURE_SKEW_MS;

/**
 * Pure: fold validated ticks into per-(kind, pool) cells over the
 * in-window rows. A tick recommending the same cell twice still
 * counts once — `ticks` is the recurrence measure. Ticks outside the
 * window never join a cell. Cells keep every recommendation — the
 * items layer applies the recurring bars.
 */
export function foldAmplifyCells(
  ticks: readonly AmplifyTick[],
  opts: { nowMs: number; windowMs?: number },
  lowerBound = false,
): AmplifyCell[] {
  const windowMs = opts.windowMs ?? AMPLIFY_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const cells = new Map<string, {
    kind: AmplifyActionKind;
    pool: string | null;
    ticks: number;
    days: Set<string>;
    maxPriority: number;
    firstMs: number | null;
    lastMs: number | null;
  }>();
  for (const tick of ticks) {
    if (!inWindow(tick.atMs, windowStart, opts.nowMs)) continue;
    const seen = new Set<string>();
    for (const action of tick.actions) {
      const key = `${action.kind}${action.pool ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let cell = cells.get(key);
      if (cell === undefined) {
        cell = {
          kind: action.kind,
          pool: action.pool,
          ticks: 0,
          days: new Set(),
          maxPriority: action.priority,
          firstMs: null,
          lastMs: null,
        };
        cells.set(key, cell);
      }
      cell.ticks += 1;
      cell.days.add(tick.utcDay);
      cell.maxPriority = Math.max(cell.maxPriority, action.priority);
      cell.firstMs = cell.firstMs === null ? tick.atMs : Math.min(cell.firstMs, tick.atMs);
      cell.lastMs = cell.lastMs === null ? tick.atMs : Math.max(cell.lastMs, tick.atMs);
    }
  }
  return [...cells.values()]
    .map((cell) => ({
      kind: cell.kind,
      pool: cell.pool,
      ticks: cell.ticks,
      days: cell.days.size,
      maxPriority: cell.maxPriority,
      firstSeen: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
      lastSeen: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
      lowerBound,
    }))
    .sort((a, b) =>
      b.maxPriority - a.maxPriority
      || b.ticks - a.ticks
      || a.kind.localeCompare(b.kind)
      || (a.pool ?? '').localeCompare(b.pool ?? ''));
}

/** What each recommendation kind means, stated once for every cell. */
const KIND_TEXT: Record<AmplifyActionKind, { meaning: string; hunt: string }> = {
  'refresh-evidence': {
    meaning: 'the pool\'s recorded quota, burn, reset and expiry evidence was unusable this tick — projectAmplify could not find one fresh complete observation across its three evidence files (queue/resources-ledger.json or the resources-ledger.json fallback, queue/budget-overrides.json, queue/status.json) inside its 30-minute freshness window, or the deadlines it did record were invalid; a null pool means no pool rows existed at all',
    hunt: 'which evidence producer stopped writing fresh rows — the journal\'s own sources map records each input file\'s read state — whether a producer\'s cadence legitimately exceeds the freshness window or its rows stopped validating, and whether projectAmplify\'s never-stitch-across-sources rule is hiding a partially-recorded pool',
  },
  'check-heartbeat': {
    meaning: 'the fleet heartbeat read stale — readFleetHeartbeat\'s queueStatus and supervisor status sources were missing or older than the freshness bound, so the advisory pass planned capacity on heartbeat-blind evidence',
    hunt: 'which heartbeat source stopped reporting (queue/status.json or the supervisor/status-*.md files under the runs dir) and whether the producers\' cadence still matches the freshness bound the shared reader applies',
  },
  'use-expiring-capacity': {
    meaning: 'the pool is projected to waste at least 10% of its included capacity before its reset or expiry deadline inside 24 hours — the exact waste the advisory engine exists to prevent',
    hunt: 'whether the pool\'s lane is held or below target while eligible queued work exists, whether lane targets and floors (the autopilot\'s decideLane writes) leave expiring quota unreachable, and whether dispatch is routing work onto other pools while this one\'s window closes',
  },
  'review-saturation': {
    meaning: 'the pool\'s lane is saturated — running at or above its recorded target — so queued demand is competing for capacity the lane cannot currently serve',
    hunt: 'whether the saturation is genuine queued demand the lane limits are throttling, whether the target itself is mis-set for the host, and whether completions are bottlenecked upstream (verification, merge, CI) rather than by the lane cap',
  },
  'review-merge-flow': {
    meaning: 'lanes are running work but the controller recorded zero merges in the last hour — active sessions are not converting into landed changes',
    hunt: 'whether the merge pipeline itself is stalled — the merge-queue loop, Merge Gate, CI or review blocks — by cross-referencing the merge-events and post-merge ledgers the sibling folds already read, and whether the zero is a measurement gap (the controller signal missing) rather than a real stall',
  },
};

const KIND_TITLE: Record<AmplifyActionKind, string> = {
  'refresh-evidence': 'capacity evidence unusable',
  'check-heartbeat': 'fleet heartbeats stale',
  'use-expiring-capacity': 'expiring capacity keeps wasting',
  'review-saturation': 'lane saturated',
  'review-merge-flow': 'merges stalled while work runs',
};

/** The evidence pointers every prompt shares; the journal's writer and its absent prior reader are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is metrics/amplify.jsonl under the runs dir (<runsDir>/metrics/amplify.jsonl — $ASHLR_RUNS_DIR when set, else ~/.ashlr-runs; amplifyRunsDir() in src/core/amplify/index.ts resolves it, and this fold treats an empty ASHLR_RUNS_DIR as unset rather than reading a cwd-relative path the way the producer\'s ?? fallback technically would). amplifyTick appends one amplify.tick.v1 record per advisory pass — the AmplifySnapshot projectAmplify computes over queue/resources-ledger.json (or the resources-ledger.json fallback), queue/budget-overrides.json, queue/status.json, the fleet-controller signals and the fleet heartbeat — with the engine\'s actions list capped at 20 recommendations. Until this feed the journal had no reader at all: readAmplifyStatus re-reads the live sources and readAmplifyGoal reads leader/decisions.jsonl, so the recorded tick history was write-only.';

/** What this repository owns on the advisory path, stated once for every cell. */
const OWNERSHIP = 'This repository owns the advisory engine itself — projectAmplify\'s evidence selection, freshness window and action vocabulary in src/core/amplify/snapshot.ts, the tick writer amplifyTick and the runs-dir resolution in src/core/amplify/index.ts — plus the lane targets and autopilot writes the capacity verdicts react to (src/core/resources/lane-autopilot.ts), the merge pipeline a stalled merge flow points at (src/core/drive/), and the queue evidence files\' consumers. What it does not own is the external quota and billing state the pools describe, ops-pinned dispatcher machinery that writes queue/status.json, or owner-side configuration — those stay reported, never edited.';

const NO_CHANGE = 'If the window has rolled forward, the condition was a transient evidence gap, a planned maintenance window or a one-off deploy that has since recovered, the recommendations are the advisory engine correctly flagging designed holds or owner-side state this repo does not own, or the cause is owner-only — report no-change and name the evidence.';

function poolText(pool: string | null): string {
  return pool === null ? 'the fleet scope' : `pool '${pool}'`;
}

function seenText(cell: AmplifyCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function boundText(cell: AmplifyCell): string {
  return cell.lowerBound ? ' The journal tail was truncated, so these counts are a lower bound.' : '';
}

function amplifyPrompt(cell: AmplifyCell, invalidRows: number): string {
  const cls = KIND_TEXT[cell.kind];
  const coverage = invalidRows > 0 ? ` ${invalidRows} malformed or off-contract line(s) dropped.` : '';
  return [
    `Phantom's amplify advisory journal keeps recommending the same work — '${cell.kind}' for ${poolText(cell.pool)} on ${cell.ticks} distinct advisory tick(s) across ${cell.days} separate UTC day(s) inside the window, the self-improvement work this backlog exists for.`,
    '',
    `${cls.meaning}. Highest recorded priority ${cell.maxPriority}.${seenText(cell)}${boundText(cell)}${coverage}`,
    '',
    EVIDENCE,
    '',
    OWNERSHIP,
    '',
    `Find whether the recurring recommendation is a machinery gap this repository can close — ${cls.hunt}. Fix what lives here; if the cause is designed holds, correct advisory verdicts on owner-side or ops-pinned state, external quota the fleet cannot control, or pinned machinery — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function amplifyItem(cell: AmplifyCell, repo: string, invalidRows: number): CloudBacklogItem {
  const id = `amplify-${createHash('sha256').update(`amplify:${cell.kind}:${cell.pool ?? ''}`).digest('hex').slice(0, 16)}`;
  const scope = cell.pool === null ? '' : ` '${cell.pool}'`;
  const title = `Amplify keeps flagging ${KIND_TITLE[cell.kind]}${scope}`.slice(0, MAX_TITLE_CHARS);
  return {
    id,
    title,
    prompt: amplifyPrompt(cell, invalidRows),
    area: 'amplify',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * Backlog items for the amplify advisory journal's recurring
 * (kind, pool) recommendation cells. Total: any read or fold
 * failure yields no items rather than throwing into discovery.
 */
export async function amplifyBacklogItems(opts: AmplifyItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling fleet-evidence feeds apply: explicit
    // dir, then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an
    // empty env value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const journalPath = opts.journalPath ?? join(runsDir, AMPLIFY_JOURNAL_RELATIVE);
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? AMPLIFY_WINDOW_MS;

    const tail = await readLedgerTail(journalPath, AMPLIFY_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const parsed = parseAmplifyJournal(tail.text);
    if (parsed.ticks.length === 0) return [];

    const cells = foldAmplifyCells(parsed.ticks, { nowMs, windowMs }, tail.truncated === true)
      .filter((cell) => cell.ticks >= AMPLIFY_MIN_TICKS && cell.days >= AMPLIFY_MIN_DAYS);
    if (cells.length === 0) return [];

    const limit = Math.max(1, Math.min(opts.limit ?? AMPLIFY_BACKLOG_MAX_ITEMS, AMPLIFY_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => amplifyItem(cell, repo, parsed.invalidRows));
  } catch {
    return [];
  }
}
