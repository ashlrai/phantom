/**
 * lane-console.ts — RQ-PHANTOM-ENG-CONSOLE: per-lane engineering console
 * projection (`fleet.lanes.v1`), shared by `phm fleet lanes` and
 * GET /api/fleet/lanes.
 *
 * Phantom as the interface for all engineering: one read-only snapshot that
 * answers, for every router lane (pool), the four questions the operator
 * asks — how much credit is left, how deep the ready queue is, how many jobs
 * are live right now, and how many merges each lane landed in the last hour
 * (plus the lane's slot target, so queue depth reads against its scale).
 *
 * READ-ONLY GUARDRAILS:
 *  - Bounded fs reads only. Never writes, never spawns a child process,
 *    never touches credentials, provider endpoints or the network.
 *  - Every source is independently guarded: a missing or corrupt file
 *    degrades only its own slice to null/unknown — never the snapshot.
 *  - No secrets, tokens, prompts or paths leave this module: the snapshot
 *    carries counts, pool ids, timestamps and file basenames only.
 *  - Loopback only: the HTTP surface exists solely inside the 127.0.0.1
 *    dashboard server (src/core/web/api.ts); this module itself does no I/O
 *    beyond the local files listed below.
 *
 * SOURCES (queue directory — `~/.ashlr-runs/queue` by default):
 *   ready.tsv            Router's queue projection. One row per job:
 *                        an optional `key=value` TSV row or a positional row
 *                        `status id pool tier repo title` (or `id pool tier
 *                        repo title` when the status column is absent), with
 *                        an optional header line naming the columns. The live
 *                        dispatcher's own dialect — `job repo lane tier
 *                        prompt-path [requirements-json]` plus its two
 *                        PARKED-<reason>[.<lane>] encodings — is recognized
 *                        natively so the lane column lands on `pool`. The
 *                        effective hint resolves like work_market.requirements:
 *                        the requirements' `preferred_lane` wins over the lane
 *                        cell (explicit null is lane-open), and a row the
 *                        market would reject counts as dropped, never supply.
 *                        READY rows the market may place anywhere count as
 *                        `unhinted`, never guessed onto a lane. READY rows
 *                        give queue depth; in-flight statuses give live jobs;
 *                        timestamped LAND rows give merges/hour.
 *   queue.v1.json        DRIVER-1 queue document (schema 'queue.v1', jobs[]
 *                        with id/status/pool). When present it is the
 *                        authoritative in-flight (live) view.
 *   jobs.jsonl           Append-only transition ledger. Rows whose `outcome` /
 *                        `to` / `status` / `event` names a merge (land / landed /
 *                        merged / pr-merge / auto-merge) count toward
 *                        merges/hour; a `job` id with no `pool` resolves
 *                        through the queue's own job→pool map.
 *   usage-readings.log   Usage journal rows ({pool, pctUsed, resetAt,
 *                        fetchedAt, ...}) written by the bridge's usage
 *                        readers — fills credit where the budget ledger has
 *                        no observation.
 *
 * SOURCES (outside the queue directory):
 *   $ASHLR_HOME/fleet/budgets/*.json   Pool budget ledger (readPoolBudgets) —
 *                        the established "credit left" reader: weeklyPct /
 *                        credits / acus / capacity per pool, with burn/h and
 *                        projected exhaustion.
 *   $ASHLR_HOME/usage-readings.log     Journal fallback after the queue copy.
 *
 * When `<queueDir>/budgets/` exists it replaces the default ledger directory,
 * and `<queueDir>/usage-readings.log` is always a candidate — so a fixture
 * directory exercises the full projection hermetically
 * (`phm fleet lanes --queue-dir <abs>`).
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { readingIsFresh } from '../usage/sensor-reading.js';
import { readPoolBudgets, poolBudgetDirectory } from './pool-budget-store.js';
import type { PoolBudgetSnapshot, PoolBudgetView } from './pool-budget.js';
import { readLaneTargets } from './runs-lane-targets.js';
import { laneHealthFor, type LaneHealth } from './lane-badge.js';
import { parseStarvedState, readStarved, STARVED_STATE_FILE, type StarvedRead } from './lane-starved.js';
import { readySpecCell, resolveReadyMarketRow } from './unfed-market.js';

// ---------------------------------------------------------------------------
// Public types — the fleet.lanes.v1 wire shape.
// ---------------------------------------------------------------------------

/** Source health for one input. 'missing' = absent file; 'degraded' = present but unreadable/corrupt/partially dropped. */
export type FleetLaneSourceState = 'healthy' | 'missing' | 'degraded' | 'unavailable';

export interface FleetLaneQueueRow {
  /** Job id when the row carries one (required by queue.v1; optional in ready.tsv). */
  id: string | null;
  /** Normalized uppercase status — 'READY' when the file carries no status column. */
  status: string;
  /** Lane (pool) id. Rows without a parseable pool are dropped, never guessed. */
  pool: string;
  repo?: string;
  tier?: string;
  priority?: string;
  title?: string;
  /** Row timestamp (ISO-ish) when present — used for merges/hour on LAND rows. */
  at?: string;
}

export interface FleetLaneCreditView {
  state: 'observed' | 'reset-pending' | 'unknown';
  /** Compact human summary, e.g. '64% weekly · 3 credits', '12.5 ACU', 'capacity 3'. */
  label: string;
  /** 0–100 remaining percent of a metered window (weeklyPct / 100-pctUsed). */
  remainingPct: number | null;
  /** Remaining balance in `creditsUnit` (credits, ACUs or capacity slots). */
  remainingCredits: number | null;
  creditsUnit: 'credits' | 'acus' | 'capacity' | null;
  resetAt: string | null;
  /** Trailing burn per hour in the credit's own units (pct-points/h or units/h). */
  burnPerHour: number | null;
  projectedExhaustionAt: string | null;
  observedAt: string | null;
  source: 'budget-ledger' | 'usage-journal' | null;
}

export interface FleetLaneView {
  /** Lane id — a router pool name exactly as written in the queue/usage data. */
  lane: string;
  /** READY jobs queued for this lane (null when ready.tsv was absent/degraded). */
  queueDepth: number | null;
  /** In-flight jobs in this lane (queue.v1.json authoritative, else active ready.tsv rows; null when no live source). */
  liveJobs: number | null;
  /** Unique merged PRs (or legacy job-level merges) in the trailing window per hour. */
  mergesPerHour: number | null;
  /** Jobs launched in the trailing window (jobs.jsonl `launch` events, one per job); null without launch events. */
  startsInWindow: number | null;
  credit: FleetLaneCreditView;
  /** The lane's slot target from a healthy lane-targets read; null when it has no row or holds were not healthy. */
  slotTarget: number | null;
  /** Null when no trustworthy hold record is available for this lane. */
  hold: {
    held: boolean;
    reason: string | null;
    until: string | null;
    by: 'autobackoff' | 'manual' | null;
    since: string | null;
  } | null;
  /** One verdict: ok | held | starved | wasteful | drained, with a plain reason (lane-badge.ts). */
  health: LaneHealth;
}

export interface FleetLaneSnapshot {
  schema: 'fleet.lanes.v1';
  generatedAt: string;
  mergeWindowMinutes: number;
  holdSource: 'healthy' | 'missing' | 'degraded';
  notes: string[];
  /** Per-source health + counts. Basenames only — absolute paths never leave the host. */
  sources: {
    queue: {
      state: FleetLaneSourceState; file: string; rows: number; dropped: number;
      /** READY rows the market may place anywhere: no lane hint in the row or its requirements. */
      unhinted: number;
    };
    queueState: { state: FleetLaneSourceState; file: string; jobs: number };
    ledger: { state: FleetLaneSourceState; file: string; events: number; dropped: number };
    usage: { state: FleetLaneSourceState; files: string[]; pools: number; dropped: number };
    budgets: { state: 'healthy' | 'unavailable' };
  };
  lanes: FleetLaneView[];
  /** Lanes with free slots and nothing ready to run on them (lane-starved.ts). */
  starved: StarvedRead;
}

/**
 * Supplies the per-lane top EMPTY reason notes for badge tooltips. Display
 * surfaces inject `fleetLaneEmptyNotes` (src/core/fleet/lane-empty-notes.ts);
 * lane-console must not import the empty-jobs report cluster itself because
 * it sits inside the Tier-1 authority import closure.
 */
export type LaneEmptyNotesProvider = (runsDir: string, nowMs: number) => Promise<ReadonlyMap<string, string>>;

export interface FleetLaneConsoleOptions {
  /** Router queue directory. Default `~/.ashlr-runs/queue`. Must be absolute when given. */
  queueDir?: string;
  /** Pool-budget ledger directory. Default: `<queueDir>/budgets` when present, else poolBudgetDirectory(). */
  budgetsDir?: string;
  /** Usage-journal candidates, in order. Default: queue copy then the $ASHLR_HOME copy. */
  usageLogPaths?: readonly string[];
  /** Clock seam for tests. */
  now?: () => Date;
  /** Trailing window for mergesPerHour. Default 60 minutes. */
  mergeWindowMs?: number;
  /** Where the Leader remembers when a lane first looked starved. Default `~/.ashlr/vision/leader`. */
  starvedStateDir?: string;
  /** Badge-tooltip notes per lane. Absent means no notes — never an error. */
  emptyNotes?: LaneEmptyNotesProvider;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_QUEUE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LEDGER_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 50_000;
const DEFAULT_MERGE_WINDOW_MS = 60 * 60_000;

const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,127}$/;

/** Statuses that make the first bare cell of a positional row a status column. */
export const KNOWN_STATUSES = new Set([
  'READY', 'CLAIMED', 'PR-OPEN', 'BLOCKED', 'HOLD', 'DONE', 'PROPOSED', 'LAND',
  'LANDED', 'MERGED', 'RUNNING', 'STARTING', 'QUEUED', 'WAITING', 'FAILED',
  'CANCELLED', 'SPLIT-PARENT', 'HELD', 'PUBLISHING', 'PUBLISHED', 'FINISHED',
  'PUBLISH_UNKNOWN', 'DISPATCHED', 'IN-PROGRESS', 'WORKING',
]);

/** In-flight = occupies a lane slot right now. READY is queue, not live. */
const LIVE_STATUSES = new Set([
  'CLAIMED', 'PR-OPEN', 'RUNNING', 'STARTING', 'DISPATCHED', 'IN-PROGRESS',
  'WORKING', 'PUBLISHING', 'PUBLISH_UNKNOWN',
]);

/** True when a normalized (uppercased) queue status names an in-flight job. */
export function isLiveQueueStatus(status: string): boolean {
  return LIVE_STATUSES.has(status.toUpperCase());
}

/** Terminal merge evidence. DONE alone is not a merge — it must name a land. */
const MERGE_WORDS = new Set([
  'land', 'landed', 'merge', 'merged', 'pr-merge', 'pr-merged',
  'auto-merge', 'automerge', 'auto-merged',
]);

/** Header/key aliases → canonical row fields. Keys are normalized lowercase-alnum. */
const COLUMN_ALIASES: Readonly<Record<string, keyof FleetLaneQueueRow>> = {
  id: 'id', job: 'id', jobid: 'id', task: 'id', name: 'id',
  status: 'status', state: 'status',
  pool: 'pool', lane: 'pool', account: 'pool',
  repo: 'repo', repository: 'repo', project: 'repo',
  tier: 'tier',
  priority: 'priority', pri: 'priority',
  title: 'title', summary: 'title',
  at: 'at', ts: 'at', time: 'at', timestamp: 'at', updated: 'at',
  updatedat: 'at', createdat: 'at', landedat: 'at', mergedat: 'at',
  completedat: 'at',
};

/** Positional order for bare cells once a leading status word is consumed. */
const POSITIONAL_FIELDS: readonly (keyof FleetLaneQueueRow)[] = ['id', 'pool', 'tier', 'repo', 'title'];

/** Repo cell in the dispatcher's positional dialect (bare name or owner/name). */
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
/** dispatchd TIERS plus 'low' and the bets lane's `bet:<tier>` experiment rows. */
const QUEUE_TIERS = new Set(['frontier', 'work', 'mid', 'fast', 'low']);
function isQueueTier(cell: string): boolean {
  const tier = cell.toLowerCase();
  return QUEUE_TIERS.has(tier) || tier.startsWith('bet:');
}
/** PARKED-<reason>[.<lane>] lane marker; also accepts the dotted PARKED.<lane> spelling. */
const PARKED_MARKER = /^PARKED(?:-[A-Za-z0-9_-]+)?(?:\.([A-Za-z0-9][A-Za-z0-9._@-]{0,63}))?$/i;
/** The prompt cell is a path or at least a filename with an extension. */
function promptCell(cell: string): boolean {
  return cell.includes('/') || /\.[a-z][a-z0-9]{0,9}$/i.test(cell);
}

// ---------------------------------------------------------------------------
// Small guards
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, '');
}

function cleanCell(value: string): string {
  // Control characters cannot survive into the projection; cap length so one
  // hostile cell cannot bloat the snapshot.
  // eslint-disable-next-line no-control-regex -- stripping control bytes is the point.
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').trim().slice(0, 512);
}

function validTimestamp(value: string | undefined): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

async function readBounded(path: string, maxBytes: number): Promise<string | null> {
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) {
    throw new Error(info.size > maxBytes ? 'queue file exceeds read bound' : 'not a regular file');
  }
  return readFile(path, 'utf8');
}

// ---------------------------------------------------------------------------
// ready.tsv — header-aware, key=value-aware, positional TSV reader.
// ---------------------------------------------------------------------------

interface ParsedTsv {
  rows: FleetLaneQueueRow[];
  dropped: number;
  /** Dispatcher rows the work market would reject (invalid_requirements): bad spec, invalid preferred_lane or lane cell. Dead work — counted, never supply. */
  invalid: number;
  /** Dispatcher rows recognized but carrying no lane hint — open market rows the dispatcher may place on any lane. */
  unhinted: number;
  /** The validated job id and repo of each lane-open row, for supply classification without a lane. */
  unhintedRows: { id: string; repo: string }[];
}

/** A recognized dispatcher row: attributed to a lane, lane-open, or market-invalid. */
type DispatcherRow =
  | { readonly kind: 'row'; readonly row: FleetLaneQueueRow }
  | { readonly kind: 'open'; readonly id: string; readonly repo: string }
  | { readonly kind: 'drop' }
  | null;

/**
 * dispatchd's own ready.tsv dialects (contrib/mac/dispatchd.py, restock.py),
 * all headerless. The lane hint sits right of the repo and the tier right of
 * the lane; parked rows carry a PARKED-<reason>[.<lane>] marker either in the
 * lane cell or leading the row, and a trailing requirements cell is JSON:
 *   job repo lane tier prompt [requirements]                     ready row
 *   job repo PARKED-<reason>[.<lane>] tier prompt [requirements] lane-column parked
 *   PARKED-<reason>[.<lane>] job lane tier repo prompt [req]     status-first parked
 * Returns null unless every cell validates — the generic positional reader
 * then applies its own contract to the line. A ready row's effective lane
 * hint resolves exactly like work_market.requirements: the requirements'
 * preferred_lane wins over the lane column (explicit null is the open hint),
 * the lane cell is the fallback only when the spec names none, and a row the
 * market would reject is 'drop' — dead work, counted, never supply.
 */
function dispatcherQueueRow(cells: string[]): DispatcherRow {
  const first = cells[0] ?? '';
  if (PARKED_MARKER.test(first)) {
    // Status-first parked: marker, job, lane, tier, repo, prompt[, requirements].
    if (cells.length !== 6 && cells.length !== 7) return null;
    const [id, pool, tier, repo, prompt, extra] = [cells[1]!, cells[2]!, cells[3]!, cells[4]!, cells[5]!, cells[6]];
    if (!JOB_ID.test(id) || !LANE_ID.test(pool) || !isQueueTier(tier) || !REPO_ID.test(repo) || !promptCell(prompt)) return null;
    if (extra !== undefined && !extra.startsWith('{')) return null;
    return { kind: 'row', row: { id, status: first.toUpperCase(), pool, tier, repo, title: prompt } };
  }
  if (cells.length !== 5 && cells.length !== 6) return null;
  if (!JOB_ID.test(first) || KNOWN_STATUSES.has(first.toUpperCase())) return null;
  const extra = cells[5];
  const laneMarker = PARKED_MARKER.exec(cells[2] ?? '');
  if (laneMarker) {
    // Lane-column parked: job, repo, marker, tier, prompt[, requirements].
    if (extra !== undefined && !extra.startsWith('{')) return null;
    const [id, repo, tier, prompt] = [cells[0]!, cells[1]!, cells[3]!, cells[4]!];
    if (!REPO_ID.test(repo) || !isQueueTier(tier) || !promptCell(prompt)) return null;
    return { kind: 'row', row: { id, status: cells[2]!.toUpperCase(), pool: laneMarker[1] ?? cells[2]!, tier, repo, title: prompt } };
  }
  // Ready row: job, repo, lane, tier, prompt[, requirements]. The market's
  // requirements() gives the spec's preferred_lane precedence over the lane
  // column — explicit null means lane-open — and validates the whole spec
  // before the market sees the row. Anything it rejects is invalid_requirements:
  // dead work the dispatcher never launches, counted here as dropped, never
  // guessed onto a lane or counted as open supply.
  const [id, repo, laneCell, tier, prompt] = [cells[0]!, cells[1]!, cells[2]!, cells[3]!, cells[4]!];
  if (!REPO_ID.test(repo) || isQueueTier(laneCell) || !isQueueTier(tier) || !promptCell(prompt)) return null;
  if (extra !== undefined && !extra.startsWith('{')) return { kind: 'drop' };
  const spec = readySpecCell(extra);
  if (spec === 'invalid') return { kind: 'drop' };
  const resolved = resolveReadyMarketRow(cells, spec ?? {});
  if (resolved === null) return { kind: 'drop' };
  if (resolved.hint === null) return { kind: 'open', id, repo };
  return { kind: 'row', row: { id, status: 'READY', pool: resolved.hint, tier, repo, title: prompt } };
}

/**
 * Tolerant reader for the router's queue TSV. A row yields whatever fields it
 * honestly carries; a row that cannot name its pool is dropped (counted),
 * never attributed to a lane by guessing.
 */
export function parseReadyTsv(text: string): ParsedTsv {
  const rows: FleetLaneQueueRow[] = [];
  let dropped = 0;
  let invalid = 0;
  let unhinted = 0;
  const unhintedRows: { id: string; repo: string }[] = [];
  let header: (keyof FleetLaneQueueRow)[] | null = null;

  const lines = text.split('\n');
  for (const rawLine of lines) {
    if (rows.length >= MAX_ROWS) break;
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cells = line.split('\t').map(cleanCell).filter((c, i, a) => !(c === '' && i === a.length - 1));
    if (cells.length === 0 || cells.every(c => c === '')) continue;

    // Header row: every cell names a known column, and at least one maps to
    // pool or status. A header line re-arms the column map (never a job row).
    if (header === null) {
      const mapped = cells.map(c => COLUMN_ALIASES[normalizeKey(c)]);
      if (
        cells.length >= 2 &&
        mapped.every(m => m !== undefined) &&
        mapped.some(m => m === 'pool' || m === 'status')
      ) {
        header = mapped as (keyof FleetLaneQueueRow)[];
        continue;
      }
    }

    // Headerless rows in the dispatcher's own dialect carry the lane hint in
    // a different column order than the generic positional export; recognize
    // them before the generic reader can misattribute repo names as lanes.
    if (header === null) {
      const dialect = dispatcherQueueRow(cells);
      if (dialect !== null) {
        if (dialect.kind === 'open') { unhinted++; unhintedRows.push({ id: dialect.id, repo: dialect.repo }); }
        else if (dialect.kind === 'drop') { dropped++; invalid++; }
        else rows.push(dialect.row);
        continue;
      }
    }

    const row: FleetLaneQueueRow = { id: null, status: 'READY', pool: '' };
    let sawField = false;
    const titleParts: string[] = [];

    if (header) {
      for (let i = 0; i < cells.length; i++) {
        const field = header[i];
        const value = cells[i]!;
        if (!field || value === '') continue;
        if (field === 'status') row.status = value.toUpperCase();
        else if (field === 'title') titleParts.push(value);
        else row[field] = value as never;
        sawField = true;
      }
    } else {
      // key=value cells claim their field; bare cells fill positional slots
      // [status?, id, pool, tier, repo, title] left-to-right.
      const bare: string[] = [];
      for (const cell of cells) {
        const kv = /^([A-Za-z][A-Za-z0-9._-]{0,31})=(.*)$/.exec(cell);
        const field = kv ? COLUMN_ALIASES[normalizeKey(kv[1]!)] : undefined;
        if (kv && field) {
          const value = cleanCell(kv[2]!);
          if (field === 'status') row.status = value.toUpperCase();
          else if (field === 'title') titleParts.push(value);
          else if (value !== '') row[field] = value as never;
          sawField = true;
        } else {
          bare.push(cell);
        }
      }
      const fields = POSITIONAL_FIELDS;
      if (bare.length > 0 && KNOWN_STATUSES.has(bare[0]!.toUpperCase())) {
        row.status = bare[0]!.toUpperCase();
        bare.shift();
        sawField = true;
      }
      for (let i = 0; i < bare.length; i++) {
        const value = bare[i]!;
        const field = fields[i] ?? 'title';
        if (field === 'title') titleParts.push(value);
        else if (value !== '') row[field] = value as never;
        if (value !== '') sawField = true;
      }
    }

    if (titleParts.length) row.title = titleParts.join(' ');
    if (!sawField || !LANE_ID.test(row.pool) || (row.id !== null && !JOB_ID.test(row.id))) {
      dropped++;
      continue;
    }
    rows.push(row);
  }
  return { rows, dropped, invalid, unhinted, unhintedRows };
}

// ---------------------------------------------------------------------------
// queue.v1.json — light structural read of the DRIVER-1 document.
// ---------------------------------------------------------------------------

/** One validated queue.v1 job row — the fields a read projection may serve. */
export interface QueueV1JobRow {
  id: string;
  /** Normalized uppercase status. */
  status: string;
  pool: string;
  repo?: string;
  tier?: string;
  priority?: string;
  /** Bounded single-line preview of `title` (or `task`'s first line), when the job carries one. */
  summary?: string;
}

interface QueueV1Read {
  /** Per-pool in-flight counts (live statuses). */
  live: Map<string, number>;
  /** Per-pool READY counts (the authoritative queue, kept for cross-check). */
  ready: Map<string, number>;
  /** job id → pool for ledger rows that do not repeat the pool. */
  jobPool: Map<string, string>;
  jobs: number;
  /** Validated job rows in document order (same strictness as the counts). */
  rows: QueueV1JobRow[];
}

/** Optional free-text job fields that may ride a queue.v1 row. */
const QUEUE_V1_TEXT_FIELDS = ['repo', 'tier', 'priority'] as const;
const SUMMARY_MAX_CHARS = 240;

function jobSummary(job: Record<string, unknown>): string | undefined {
  const title = job['title'];
  if (typeof title === 'string' && title.trim()) return cleanCell(title).slice(0, SUMMARY_MAX_CHARS);
  const task = job['task'];
  if (typeof task === 'string' && task.trim()) {
    const firstLine = task.split('\n', 1)[0]!;
    return cleanCell(firstLine).slice(0, SUMMARY_MAX_CHARS);
  }
  return undefined;
}

export function parseQueueV1Document(text: string): QueueV1Read {
  const value = record(JSON.parse(text));
  if (!value || value.schema !== 'queue.v1' || !Array.isArray(value.jobs) || value.jobs.length > MAX_ROWS) {
    throw new Error('invalid queue.v1 document');
  }
  const live = new Map<string, number>();
  const ready = new Map<string, number>();
  const jobPool = new Map<string, string>();
  const rows: QueueV1JobRow[] = [];
  for (const job of value.jobs) {
    const j = record(job);
    if (!j || typeof j.id !== 'string' || !JOB_ID.test(j.id) ||
        typeof j.pool !== 'string' || !LANE_ID.test(j.pool) ||
        typeof j.status !== 'string' || j.status.length > 64) {
      throw new Error('invalid queue.v1 job');
    }
    const status = j.status.toUpperCase();
    const row: QueueV1JobRow = { id: j.id, status, pool: j.pool };
    for (const field of QUEUE_V1_TEXT_FIELDS) {
      const v = j[field];
      if (typeof v === 'string' && v.trim()) row[field] = cleanCell(v);
    }
    const summary = jobSummary(j);
    if (summary) row.summary = summary;
    rows.push(row);
    jobPool.set(j.id, j.pool);
    if (LIVE_STATUSES.has(status)) live.set(j.pool, (live.get(j.pool) ?? 0) + 1);
    else if (status === 'READY') ready.set(j.pool, (ready.get(j.pool) ?? 0) + 1);
  }
  return { live, ready, jobPool, jobs: value.jobs.length, rows };
}

// ---------------------------------------------------------------------------
// jobs.jsonl — append-only transition ledger; merge events in a window.
// ---------------------------------------------------------------------------

export interface LaneLedgerEvent {
  job: string | null;
  pool: string | null;
  at: string | null;
  pr: string | null;
  merge: boolean;
  /** A `launch` event: the job was started. */
  launch?: boolean;
}

function prIdentity(value: string | null): string | null {
  if (!value) return null;
  const match = /^https:\/\/github\.com\/([a-z\d_.-]+)\/([a-z\d_.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(value);
  return match ? `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}#${match[3]}` : null;
}

// An offset is essential: otherwise Date.parse depends on the host timezone.
function eventTimestamp(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/i.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function parseJobsJsonl(text: string): { events: LaneLedgerEvent[]; dropped: number } {
  const events: LaneLedgerEvent[] = [];
  let dropped = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { dropped++; continue; }
    const row = record(value);
    if (!row) { dropped++; continue; }
    const pick = (...keys: string[]): string | null => {
      for (const key of keys) {
        const v = row[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
      return null;
    };
    const job = pick('job', 'id', 'jobId');
    const poolRaw = pick('pool', 'lane', 'account');
    const pool = poolRaw && LANE_ID.test(poolRaw) ? poolRaw : null;
    const at = pick('ts', 'at', 'time', 'timestamp', 'landedAt', 'mergedAt', 'completedAt', 'recordedAt', 'updatedAt');
    const transition = pick('outcome', 'to', 'status', 'state', 'next', 'newStatus');
    const eventName = pick('event', 'type', 'transition', 'action', 'verb', 'kind');
    const merge =
      (transition !== null && MERGE_WORDS.has(transition.toLowerCase())) ||
      (eventName !== null && MERGE_WORDS.has(eventName.toLowerCase())) ||
      row['landed'] === true || row['merged'] === true;
    events.push({ job, pool, at, pr: prIdentity(pick('prUrl', 'pr')), merge, launch: eventName?.toLowerCase() === 'launch' });
  }
  return { events, dropped };
}

// ---------------------------------------------------------------------------
// usage-readings.log — latest journal row per pool.
// ---------------------------------------------------------------------------

export interface UsageJournalRow {
  pool: string;
  pctUsed: number | null;
  resetAt: string | null;
  burnPerHour: number | null;
  projectedExhaustionAt: string | null;
  observedAt: string;
  staleAfter: string | null;
}

/**
 * Read the newest row per pool across every candidate journal. A row carries
 * credit evidence only when `pctUsed` is numeric; status-only reader rows
 * ({observedAt, status, reason}) parse but contribute nothing. One malformed
 * line degrades the source's state, not its other rows.
 */
export function parseUsageJournals(texts: readonly string[]): { latest: Map<string, UsageJournalRow>; dropped: number } {
  const latest = new Map<string, UsageJournalRow>();
  let dropped = 0;
  const freshness = (row: UsageJournalRow): number => Date.parse(row.observedAt);
  for (const text of texts) {
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { dropped++; continue; }
      const row = record(value);
      if (!row || typeof row.pool !== 'string' || !LANE_ID.test(row.pool)) { dropped++; continue; }
      const observed = row.writtenAt ?? row.fetchedAt ?? row.observedAt;
      if (typeof observed !== 'string' || !validTimestamp(observed)) { dropped++; continue; }
      const pctUsed = typeof row.pctUsed === 'number' && Number.isFinite(row.pctUsed) && row.pctUsed >= 0 && row.pctUsed <= 100
        ? row.pctUsed : null;
      const resetAt = typeof row.resetAt === 'string' && validTimestamp(row.resetAt) ? row.resetAt : null;
      const burn = typeof row.burnRatePctPerHour === 'number' && Number.isFinite(row.burnRatePctPerHour) && row.burnRatePctPerHour >= 0
        ? row.burnRatePctPerHour : null;
      const projected = typeof row.projected100At === 'string' && validTimestamp(row.projected100At) ? row.projected100At : null;
      const staleAfter = typeof row.staleAfter === 'string' && validTimestamp(row.staleAfter) ? row.staleAfter : null;
      const next: UsageJournalRow = {
        pool: row.pool, pctUsed, resetAt, burnPerHour: burn,
        projectedExhaustionAt: projected, observedAt: observed, staleAfter,
      };
      const prior = latest.get(row.pool);
      if (!prior || freshness(next) >= freshness(prior)) latest.set(row.pool, next);
    }
  }
  return { latest, dropped };
}

// ---------------------------------------------------------------------------
// Credit view — budget ledger first, usage journal to fill gaps.
// ---------------------------------------------------------------------------

function budgetCredit(view: PoolBudgetView): FleetLaneCreditView {
  const buckets = view.buckets;
  const pct = buckets.weeklyPct;
  const balance = buckets.acus ?? buckets.credits ?? buckets.capacity;
  const unit = buckets.acus ? 'acus' : buckets.credits ? 'credits' : buckets.capacity ? 'capacity' : null;
  const observed = [pct, balance].filter(Boolean).some(b => b!.state === 'observed');
  const pending = [pct, balance].filter(Boolean).some(b => b!.state === 'reset-pending');
  const resets = [pct?.resetAt, balance?.resetAt].filter((v): v is string => typeof v === 'string').sort();
  const exhaustions = [pct?.projectedExhaustion, balance?.projectedExhaustion].filter((v): v is string => typeof v === 'string').sort();
  const timestamps = [pct?.timestamp, balance?.timestamp].filter((v): v is string => typeof v === 'string').sort();
  const burn = pct?.burnPerHour.last2 ?? pct?.burnPerHour.last12h ?? balance?.burnPerHour.last2 ?? balance?.burnPerHour.last12h ?? null;
  const parts: string[] = [];
  if (pct?.remaining != null) parts.push(`${pct.remaining}% weekly`);
  if (balance?.remaining != null) {
    parts.push(unit === 'acus' ? `${balance.remaining} ACU` : unit === 'capacity' ? `capacity ${balance.remaining}` : `${balance.remaining} credits`);
  }
  return {
    state: observed ? 'observed' : pending ? 'reset-pending' : 'unknown',
    label: parts.join(' · ') || 'unknown',
    remainingPct: pct?.remaining ?? null,
    remainingCredits: balance?.remaining ?? null,
    creditsUnit: unit,
    resetAt: resets[0] ?? null,
    burnPerHour: burn,
    projectedExhaustionAt: exhaustions[0] ?? null,
    observedAt: timestamps.at(-1) ?? null,
    source: observed || pending ? 'budget-ledger' : null,
  };
}

function usageCredit(row: UsageJournalRow, nowMs: number): FleetLaneCreditView {
  const fresh = row.pctUsed !== null && readingIsFresh({
    observedAt: row.observedAt, staleAfter: row.staleAfter, nowMs,
  });
  return {
    state: fresh ? 'observed' : 'unknown',
    label: fresh ? `${100 - row.pctUsed!}% window` : 'unknown',
    remainingPct: fresh ? 100 - row.pctUsed! : null,
    remainingCredits: null,
    creditsUnit: null,
    resetAt: row.resetAt,
    burnPerHour: row.burnPerHour,
    projectedExhaustionAt: row.projectedExhaustionAt,
    observedAt: row.observedAt,
    source: fresh ? 'usage-journal' : null,
  };
}

const UNKNOWN_CREDIT: FleetLaneCreditView = {
  state: 'unknown', label: 'unknown', remainingPct: null, remainingCredits: null,
  creditsUnit: null, resetAt: null, burnPerHour: null, projectedExhaustionAt: null,
  observedAt: null, source: null,
};

function creditFor(
  lane: string,
  budgets: PoolBudgetSnapshot,
  usage: Map<string, UsageJournalRow>,
  nowMs: number,
): FleetLaneCreditView {
  const budgetView = (budgets.pools as Record<string, PoolBudgetView | undefined>)[lane];
  const budget = budgetView ? budgetCredit(budgetView) : null;
  const usageRow = usage.get(lane);
  const usageView = usageRow ? usageCredit(usageRow, nowMs) : null;
  if (budget?.state === 'observed') return budget;
  if (usageView?.state === 'observed') return usageView;
  if (budget && budget.state !== 'unknown') return budget;
  return usageView ?? budget ?? UNKNOWN_CREDIT;
}

// ---------------------------------------------------------------------------
// Snapshot assembly — never throws.
// ---------------------------------------------------------------------------

/** Queue copy first, then the $ASHLR_HOME journal (shared with the Ideas list). */
export function defaultUsageLogPaths(queueDir: string): string[] {
  const configured = process.env['ASHLR_HOME'];
  const home = typeof configured === 'string' && configured.trim() !== '' && isAbsolute(configured)
    ? configured
    : join(homedir(), '.ashlr');
  return [join(queueDir, 'usage-readings.log'), join(home, 'usage-readings.log')];
}

const EMPTY_NOTE_TTL_MS = 60_000;
const emptyNoteCache = new Map<string, { at: number; provider: LaneEmptyNotesProvider; notes: Map<string, string> }>();

/** Top EMPTY reason per lane over the last 24 h, for the badge tooltip. Cached a minute per provider: the snapshot is polled and the provider reads job logs. No provider means no notes; a throwing provider degrades to none — the tooltip is optional. */
async function laneEmptyNotes(runsDir: string, nowMs: number, provider: LaneEmptyNotesProvider | undefined): Promise<Map<string, string>> {
  if (!provider) return new Map();
  const hit = emptyNoteCache.get(runsDir);
  if (hit && hit.provider === provider && nowMs - hit.at >= 0 && nowMs - hit.at < EMPTY_NOTE_TTL_MS) return hit.notes;
  let notes = new Map<string, string>();
  try {
    notes = new Map(await provider(runsDir, nowMs));
  } catch { /* the tooltip is optional */ }
  emptyNoteCache.set(runsDir, { at: nowMs, provider, notes });
  return notes;
}

export async function getFleetLaneSnapshot(options: FleetLaneConsoleOptions = {}): Promise<FleetLaneSnapshot> {
  const now = options.now?.() ?? new Date();
  const mergeWindowMs = options.mergeWindowMs ?? DEFAULT_MERGE_WINDOW_MS;
  const queueDir = options.queueDir ?? join(homedir(), '.ashlr-runs', 'queue');
  const sources: FleetLaneSnapshot['sources'] = {
    queue: { state: 'missing', file: 'ready.tsv', rows: 0, dropped: 0, unhinted: 0 },
    queueState: { state: 'missing', file: 'queue.v1.json', jobs: 0 },
    ledger: { state: 'missing', file: 'jobs.jsonl', events: 0, dropped: 0 },
    usage: { state: 'missing', files: [], pools: 0, dropped: 0 },
    budgets: { state: 'healthy' },
  };

  // ── 1. ready.tsv — queue depth (+ live/merge fallback evidence) ──────────
  let queueRows: FleetLaneQueueRow[] = [];
  // Lane-open READY rows: open market supply any lane may claim. Null until
  // ready.tsv parses — an unread queue cannot say whether open work waits.
  let openQueueRows: number | null = null;
  try {
    const text = await readBounded(join(queueDir, 'ready.tsv'), MAX_QUEUE_FILE_BYTES);
    if (text !== null) {
      const parsed = parseReadyTsv(text);
      queueRows = parsed.rows;
      openQueueRows = parsed.unhinted;
      sources.queue = {
        state: parsed.dropped > 0 ? 'degraded' : 'healthy',
        file: 'ready.tsv', rows: parsed.rows.length, dropped: parsed.dropped,
        unhinted: parsed.unhinted,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') sources.queue.state = 'degraded';
  }

  // ── 2. queue.v1.json — authoritative live jobs when present ──────────────
  let queueState: QueueV1Read | null = null;
  try {
    const text = await readBounded(join(queueDir, 'queue.v1.json'), MAX_QUEUE_FILE_BYTES);
    if (text !== null) {
      queueState = parseQueueV1Document(text);
      sources.queueState = { state: 'healthy', file: 'queue.v1.json', jobs: queueState.jobs };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') sources.queueState.state = 'degraded';
  }

  // ── 3. jobs.jsonl — merge events in the trailing window ──────────────────
  let ledgerEvents: LaneLedgerEvent[] = [];
  try {
    const text = await readBounded(join(queueDir, 'jobs.jsonl'), MAX_LEDGER_FILE_BYTES);
    if (text === null) throw new Error('ledger unavailable');
    const parsed = parseJobsJsonl(text);
    ledgerEvents = parsed.events;
    sources.ledger = {
      state: parsed.dropped > 0 ? 'degraded' : 'healthy',
      file: 'jobs.jsonl', events: parsed.events.length, dropped: parsed.dropped,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') sources.ledger.state = 'degraded';
  }

  // ── 4. usage journals — per-pool window readings ─────────────────────────
  const usagePaths = options.usageLogPaths ?? defaultUsageLogPaths(queueDir);
  const usageTexts: string[] = [];
  const usageFiles: string[] = [];
  let usageFailed = false;
  for (const path of usagePaths) {
    try {
      const text = await readBounded(path, MAX_LEDGER_FILE_BYTES);
      if (text !== null) { usageTexts.push(text); usageFiles.push('usage-readings.log'); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') usageFailed = true;
    }
  }
  const usage = parseUsageJournals(usageTexts);
  sources.usage = {
    state: usageFiles.length === 0 ? (usageFailed ? 'degraded' : 'missing') : usage.dropped > 0 || usageFailed ? 'degraded' : 'healthy',
    files: usageFiles,
    pools: usage.latest.size,
    dropped: usage.dropped,
  };

  // ── 5. pool budgets — the established credit reader ──────────────────────
  let budgetsDir = options.budgetsDir;
  if (!budgetsDir) {
    try {
      const info = await stat(join(queueDir, 'budgets'));
      budgetsDir = info.isDirectory() ? join(queueDir, 'budgets') : poolBudgetDirectory();
    } catch {
      budgetsDir = poolBudgetDirectory();
    }
  }
  const budgets = await readPoolBudgets(budgetsDir, now);
  sources.budgets.state = budgets.sourceState;

  // ── 6. hold records — independent of the other lane sources ──────────────
  let holdSource: FleetLaneSnapshot['holdSource'] = 'degraded';
  let holdRows: Awaited<ReturnType<typeof readLaneTargets>>['lanes'] = [];
  try {
    const targets = await readLaneTargets({ runsDir: dirname(queueDir) });
    holdSource = targets.sourceState;
    if (holdSource === 'healthy') holdRows = targets.lanes;
  } catch {
    // A failed hold read must not prevent the rest of the snapshot.
  }
  const notes = holdSource === 'healthy' ? [] : [`holds: ${holdSource}`];
  const holds = new Map(holdRows.map(row => [row.lane, row]));

  // ── 7. fold into lanes ────────────────────────────────────────────────────
  const cutoff = now.getTime() - mergeWindowMs;
  const lanes = new Set<string>([
    ...usage.latest.keys(),
    ...queueRows.map(r => r.pool),
    ...(queueState ? queueState.jobPool.values() : []),
    ...ledgerEvents.map(e => e.pool).filter((p): p is string => p !== null),
    ...holds.keys(),
  ]);
  for (const pool of Object.keys(budgets.pools)) lanes.add(pool);

  const mergeCounts = new Map<string, number>();
  const candidates: Array<{ pool: string; job: string | null; pr: string | null }> = [];
  let sawMergeEvidence = sources.ledger.state !== 'missing';
  for (const event of ledgerEvents) {
    const at = eventTimestamp(event.at);
    if (!event.merge || at === null || at > now.getTime() || at < cutoff) continue;
    const pool = event.pool ?? (event.job ? queueState?.jobPool.get(event.job) ?? readyPoolOf(queueRows, event.job) : undefined);
    if (!pool) continue;
    candidates.push({ pool, job: event.job, pr: event.pr });
  }
  // ready.tsv LAND rows with their own timestamps count too — some routers
  // export the whole queue, lands included, in one file.
  let sawReadyLand = false;
  for (const row of queueRows) {
    const at = eventTimestamp(row.at);
    if (!MERGE_WORDS.has(row.status.toLowerCase()) || at === null || at > now.getTime() || at < cutoff) continue;
    sawReadyLand = true;
    candidates.push({ pool: row.pool, job: row.id, pr: null });
  }
  // Prefer PR identity; a legacy job-only observation of that PR is a duplicate.
  const jobsWithPr = new Set(candidates.filter(c => c.pr && c.job).map(c => c.job!));
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.pr && candidate.job && jobsWithPr.has(candidate.job)) continue;
    const key = candidate.pr ? `pr:${candidate.pr}` : candidate.job ? `job:${candidate.job}` : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    mergeCounts.set(candidate.pool, (mergeCounts.get(candidate.pool) ?? 0) + 1);
  }
  sawMergeEvidence = sawMergeEvidence || sawReadyLand || mergeCounts.size > 0;

  // Starts = distinct jobs launched in the window, for the wasteful verdict.
  const startJobs = new Map<string, Set<string>>();
  for (const event of ledgerEvents) {
    const at = eventTimestamp(event.at);
    if (!event.launch || at === null || at > now.getTime() || at < cutoff) continue;
    const pool = event.pool ?? (event.job ? queueState?.jobPool.get(event.job) ?? readyPoolOf(queueRows, event.job) : undefined);
    if (!pool) continue;
    const jobs = startJobs.get(pool) ?? new Set<string>();
    jobs.add(event.job ?? String(at));
    startJobs.set(pool, jobs);
  }
  const sawLaunch = startJobs.size > 0;

  const readyCounts = new Map<string, number>();
  const liveFromTsv = new Map<string, number>();
  for (const row of queueRows) {
    if (row.status === 'READY') readyCounts.set(row.pool, (readyCounts.get(row.pool) ?? 0) + 1);
    else if (LIVE_STATUSES.has(row.status)) liveFromTsv.set(row.pool, (liveFromTsv.get(row.pool) ?? 0) + 1);
  }

  const views: FleetLaneView[] = [...lanes].map(lane => {
    const queueDepth = sources.queue.state !== 'missing'
      ? readyCounts.get(lane) ?? 0
      : queueState !== null ? queueState.ready.get(lane) ?? 0 : null;
    const liveJobs = queueState !== null
      ? queueState.live.get(lane) ?? 0
      : sources.queue.state === 'healthy' || sources.queue.state === 'degraded'
        ? liveFromTsv.get(lane) ?? 0
        : null;
    const mergeCount = mergeCounts.get(lane) ?? 0;
    const mergesPerHour = !sawMergeEvidence ? null
      : Math.round((mergeCount / (mergeWindowMs / 3_600_000)) * 100) / 100;
    const row = holds.get(lane);
    const hold: FleetLaneView['hold'] = row ? {
      held: row.held,
      reason: row.heldReason,
      until: row.heldUntil,
      by: !row.held ? null : row.heldReason?.startsWith('autobackoff') ? 'autobackoff' : 'manual',
      since: row.lastChange,
    } : null;
    const startsInWindow = sawLaunch ? startJobs.get(lane)?.size ?? 0 : null;
    // Placeholder verdict; replaced once the starved read below has run.
    return { lane, queueDepth, liveJobs, mergesPerHour, startsInWindow, health: { state: 'ok' as const, reason: 'ok', number: null }, credit: creditFor(lane, budgets, usage.latest, now.getTime()), slotTarget: row?.target ?? null, hold };
  });

  // Lanes doing something sort first; alphabetical inside each tier.
  views.sort((a, b) => {
    const score = (v: FleetLaneView): number =>
      (v.liveJobs ?? 0) * 4 + (v.queueDepth ?? 0) * 2 + (v.mergesPerHour ?? 0);
    return score(b) - score(a) || a.lane.localeCompare(b.lane);
  });

  // Starved = free slots and no ready rows. A held lane is waiting, not starved; a drained one cannot run what it is given.
  // Lane-open rows are open supply the market may place on any lane, so they keep a free lane from reading as starved.
  let stateText: string | null = null;
  try { stateText = await readBounded(join(options.starvedStateDir ?? join(homedir(), '.ashlr', 'vision', 'leader'), STARVED_STATE_FILE), 16 * 1024); } catch { /* no record yet */ }
  const starved = readStarved(views.map(view => ({
    lane: view.lane,
    floor: holds.get(view.lane)?.floor ?? null,
    running: view.liveJobs,
    ready: view.queueDepth,
    held: view.hold?.held === true,
    drained: view.credit.remainingPct !== null && view.credit.remainingPct <= 0,
  })), parseStarvedState(stateText).since, now.getTime(), openQueueRows);

  const emptyNotes = await laneEmptyNotes(dirname(queueDir), now.getTime(), options.emptyNotes);
  for (const view of views) {
    const row = starved.lanes[view.lane];
    view.health = laneHealthFor({
      lane: view.lane,
      remainingPct: view.credit.remainingPct,
      held: view.hold?.held === true,
      heldReason: view.hold?.reason ?? null,
      slotTarget: view.slotTarget,
      starved: row?.starved === true,
      freeSlots: row?.free_slots ?? null,
      readyRows: view.queueDepth,
      starvedSince: row?.starved_since ?? null,
      starts: view.startsInWindow,
      // Merges are per hour over the window; convert back to a count.
      merged: view.mergesPerHour === null ? null : Math.round(view.mergesPerHour * (mergeWindowMs / 3_600_000)),
      windowMinutes: Math.round(mergeWindowMs / 60_000),
      liveJobs: view.liveJobs,
    }, now.getTime());
    const note = emptyNotes.get(view.lane);
    if (note) view.health.emptyNote = note;
  }

  return {
    schema: 'fleet.lanes.v1',
    generatedAt: now.toISOString(),
    mergeWindowMinutes: Math.round(mergeWindowMs / 60_000),
    holdSource,
    notes,
    sources,
    lanes: views,
    starved,
  };
}

function readyPoolOf(rows: readonly FleetLaneQueueRow[], job: string): string | undefined {
  for (const row of rows) if (row.id === job) return row.pool;
  return undefined;
}
