/**
 * core/fleet/leader-board.ts — the Leader-as-CEO board (RQ-SWE3-LEADERLOOP-1).
 *
 * Every Leader tick records one structured board state at
 * `<runs>/coordination/leader-board.json`; `phm fleet board` surfaces it. The
 * board is the observability backbone for autonomous operation: what the
 * lanes look like, how deep the queue is per tier, whether merges are
 * landing, whether conflicting PRs are piling up, and what is blocked on
 * Mason.
 *
 * LOOPBACK-SAFE AND BOUNDED. Every input is a local file under the runs dir
 * (queue/ready.tsv, queue/jobs.jsonl, NEEDS-MASON.md) through the same
 * capped readers the fleet verbs use — no gh, no network, no model. Nothing
 * here grants or revokes authority: the board describes, it never acts.
 * `recordLeaderBoard` never throws so a broken source can never break the
 * tick that produced it.
 *
 * CONFLICTING-PR PROXY. GitHub's mergeable flag needs a live `gh pr list`,
 * which a tick must not spend. Queuegen instead enqueues an
 * `RQ-REBASE-<REPO>-<pr>-<sha7>` job only for PRs GitHub reports DIRTY, so a
 * distinct-PR count over ready.tsv's rebase rows is the fleet's own honest
 * local view of "PRs sitting in conflicts" — it drops to zero as rebase jobs
 * launch and land.
 */
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { parseReadyTsv } from './lane-console.js';
import { readSource } from './runs-parked-queue.js';
import { getLaneQueueCounts } from './queue-counts.js';
import { readNeedsMason, type NeedsMasonItem } from './needs-mason-resolve.js';
import { sanitizePublicJson } from '../util/public-json.js';

export const LEADER_BOARD_SCHEMA = 'fleet.leader-board.v1' as const;
export const LEADER_BOARD_FILE = 'leader-board.json';

const MAX_READY_BYTES = 2 * 1024 * 1024;
const MAX_BOARD_BYTES = 256 * 1024;
/** Rolling conflict observations kept on the board (a few hours of ticks). */
const MAX_HISTORY = 96;
const MAX_NEEDS_ITEMS = 10;
const MAX_TIER_KEYS = 16;
const TIER_RE = /^[a-z][a-z0-9-]{0,15}$/;
/** RQ-REBASE-<REPO>-<pr number>-<head sha7> from queuegen (queuegen.rebaseId), anywhere in a queue row. */
const REBASE_JOB_RE = /RQ-REBASE-([A-Z0-9][A-Z0-9-]*)-(\d{1,7})-[0-9a-f]{7,40}/i;

export interface LeaderBoardLane {
  lane: string;
  ready: number | null;
  parked: number | null;
  running: number | null;
  mergesLastHour: number | null;
  oldestWaitSeconds: number | null;
}

export interface LeaderBoardConflictSample {
  at: string;
  count: number;
}

export type LeaderBoardConflictTrend = 'rising' | 'falling' | 'flat' | 'unknown';

export interface LeaderBoardV1 {
  schema: typeof LEADER_BOARD_SCHEMA;
  generatedAt: string;
  lanes: LeaderBoardLane[];
  /** READY rows by queue tier; 'unknown' covers rows naming no/invalid tier. null when ready.tsv was unreadable. */
  queueDepthByTier: Record<string, number> | null;
  /** Unique merged jobs/PRs in the trailing hour across lanes; null without a healthy merge ledger. */
  mergesLastHour: number | null;
  conflictingPrs: {
    /** Distinct PRs with an RQ-REBASE row queued; null when ready.tsv was unreadable. */
    count: number | null;
    /** count minus the previous recorded sample; null without one. */
    delta: number | null;
    trend: LeaderBoardConflictTrend;
    history: LeaderBoardConflictSample[];
  };
  needsMason: {
    status: 'available' | 'missing' | 'unavailable';
    count: number;
    items: NeedsMasonItem[];
  };
  sources: {
    readyTsv: 'healthy' | 'missing' | 'degraded';
    queueCounts: 'ok' | 'unavailable';
    needsMason: 'available' | 'missing' | 'unavailable';
  };
}

export type LeaderBoardRead =
  | { status: 'ok'; board: LeaderBoardV1 }
  | { status: 'missing' | 'unavailable'; board: null };

export type LeaderBoardRecordResult =
  | { wrote: true; path: string; board: LeaderBoardV1 }
  | { wrote: false; path: string; reason: string };

export function leaderBoardPath(runsDir: string): string {
  return join(runsDir, 'coordination', LEADER_BOARD_FILE);
}

function defaultRunsDir(): string {
  return process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Same parked marker runs-parked-queue recognizes, in either queue encoding's cell. */
const PARKED_CELL = /^PARKED-[A-Za-z0-9_-]+(?:\.[A-Za-z0-9][A-Za-z0-9._@-]{0,63})?$/i;

function parkedCell(cell: string | undefined): boolean {
  return PARKED_CELL.test((cell ?? '').replace(/^[A-Za-z][A-Za-z0-9._-]{0,31}=/, ''));
}

/** READY depth per tier. Unknown/invalid/missing tiers fold into 'unknown'. */
export function queueDepthByTier(rows: readonly { status: string; tier?: string }[]): Record<string, number> {
  const byTier: Record<string, number> = {};
  let keys = 0;
  for (const row of rows) {
    if (row.status !== 'READY') continue;
    const raw = (row.tier ?? '').trim().toLowerCase();
    const tier = TIER_RE.test(raw) ? raw : 'unknown';
    if (byTier[tier] === undefined) {
      if (keys >= MAX_TIER_KEYS) { byTier['unknown'] = (byTier['unknown'] ?? 0) + 1; continue; }
      keys++;
    }
    byTier[tier] = (byTier[tier] ?? 0) + 1;
  }
  return byTier;
}

/**
 * Parse ready.tsv for the tier projection with parked lines removed first.
 * Status-first PARKED-<reason>.<lane> and dispatcher 5-column rows
 * (job \t repo \t PARKED-<reason>.<lane> \t tier \t prompt) are holds, not
 * depth — left in, a PARKED cell lands in the positional id or pool slot and
 * would inflate the READY count.
 */
export function readyRowsForDepth(text: string): ReturnType<typeof parseReadyTsv>['rows'] {
  const kept = text.split('\n').filter((line) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return true;
    const cells = line.split('\t');
    return !parkedCell(cells[0]) && !parkedCell(cells[2]);
  });
  return parseReadyTsv(kept.join('\n')).rows;
}

/**
 * Distinct PRs named by RQ-REBASE rows in raw ready.tsv text — see the header
 * for why this is the conflict proxy. A raw scan, not parsed rows: the two
 * parked-row encodings and statuses parseReadyTsv drops all still count —
 * a parked rebase job is still a PR sitting in conflicts.
 */
export function conflictingPrIds(readyTsvText: string): Set<string> {
  const prs = new Set<string>();
  for (const raw of readyTsvText.split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const match = REBASE_JOB_RE.exec(raw);
    if (match) prs.add(`${match[1]!.toUpperCase()}-${match[2]!}`);
  }
  return prs;
}

function conflictTrend(history: readonly LeaderBoardConflictSample[]): { delta: number | null; trend: LeaderBoardConflictTrend } {
  const samples = history.filter((s) => Number.isSafeInteger(s.count));
  const latest = samples.at(-1);
  if (!latest || samples.length < 2) return { delta: null, trend: 'unknown' };
  const previous = samples.at(-2)!;
  const delta = latest.count - previous.count;
  const first = samples[0]!.count;
  return { delta, trend: latest.count > first ? 'rising' : latest.count < first ? 'falling' : 'flat' };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function parseBoard(text: string): LeaderBoardV1 | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw['schema'] !== LEADER_BOARD_SCHEMA || typeof raw['generatedAt'] !== 'string') return null;
    return raw as unknown as LeaderBoardV1;
  } catch {
    return null;
  }
}

/** Bounded, symlink-refusing read of the board file. */
export async function readLeaderBoard(opts: { runsDir?: string } = {}): Promise<LeaderBoardRead> {
  const path = leaderBoardPath(opts.runsDir ?? defaultRunsDir());
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_BOARD_BYTES) return { status: 'unavailable', board: null };
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return { status: 'unavailable', board: null };
      offset += bytesRead;
    }
    const board = parseBoard(bytes.toString('utf8'));
    return board === null ? { status: 'unavailable', board: null } : { status: 'ok', board };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable', board: null };
  } finally {
    await file?.close().catch(() => undefined);
  }
}

/** The prior conflict history on disk — validated, never trusted past shape and bound. */
function previousHistory(board: LeaderBoardV1 | null): LeaderBoardConflictSample[] {
  if (!board || !Array.isArray(board.conflictingPrs?.history)) return [];
  return board.conflictingPrs.history
    .filter((s): s is LeaderBoardConflictSample =>
      s !== null && typeof s === 'object' && typeof s.at === 'string'
      && Number.isFinite(Date.parse(s.at)) && Number.isSafeInteger(s.count) && s.count >= 0)
    .slice(-MAX_HISTORY);
}

// ---------------------------------------------------------------------------
// Build + write
// ---------------------------------------------------------------------------

async function buildLeaderBoard(runsDir: string, nowMs: number, previous: LeaderBoardConflictSample[]): Promise<LeaderBoardV1> {
  const at = new Date(nowMs);
  const [readySource, counts, needs] = await Promise.all([
    readSource(join(runsDir, 'queue', 'ready.tsv'), MAX_READY_BYTES, false),
    getLaneQueueCounts({ runsDir, now: () => at }).then(
      (report) => ({ state: 'ok' as const, report }),
      () => ({ state: 'unavailable' as const, report: null }),
    ),
    Promise.resolve().then(() => {
      try { return readNeedsMason({ runsDir }); } catch { return { status: 'unavailable' as const, items: [] }; }
    }),
  ]);

  const depthRows = readySource.state === 'healthy' ? readyRowsForDepth(readySource.text) : null;
  const lanes: LeaderBoardLane[] = (counts.report?.lanes ?? []).map((row) => ({
    lane: row.lane,
    ready: row.ready,
    parked: row.parked,
    running: row.running,
    mergesLastHour: row.merges,
    oldestWaitSeconds: row.oldestWaitSeconds,
  }));

  const conflictCount = readySource.state === 'healthy' ? conflictingPrIds(readySource.text).size : null;
  const history = [...previous, ...(conflictCount === null ? [] : [{ at: at.toISOString(), count: conflictCount }])].slice(-MAX_HISTORY);
  // An unmeasured count reports unknown — never a trend computed on stale samples.
  const { delta, trend } = conflictCount === null ? { delta: null, trend: 'unknown' as const } : conflictTrend(history);

  return sanitizePublicJson({
    schema: LEADER_BOARD_SCHEMA,
    generatedAt: at.toISOString(),
    lanes,
    queueDepthByTier: depthRows === null ? null : queueDepthByTier(depthRows),
    mergesLastHour: counts.report?.totals.merges ?? null,
    conflictingPrs: { count: conflictCount, delta, trend, history },
    needsMason: { status: needs.status, count: needs.items.length, items: needs.items.slice(0, MAX_NEEDS_ITEMS) },
    sources: {
      readyTsv: readySource.state,
      queueCounts: counts.state,
      needsMason: needs.status,
    },
  }) as LeaderBoardV1;
}

/**
 * Record this tick's board. Reads the previous board first (for the conflict
 * trend), builds, then writes atomically (0600 temp + rename into a 0700
 * coordination dir). Never throws: a failure degrades this sample only.
 */
export async function recordLeaderBoard(opts: { runsDir?: string; nowMs?: number } = {}): Promise<LeaderBoardRecordResult> {
  const runsDir = opts.runsDir ?? defaultRunsDir();
  const path = leaderBoardPath(runsDir);
  try {
    if (!isAbsolute(runsDir)) return { wrote: false, path, reason: 'runs dir is not absolute' };
    const nowMs = opts.nowMs ?? Date.now();
    const previous = previousHistory((await readLeaderBoard({ runsDir })).board);
    const board = await buildLeaderBoard(runsDir, nowMs, previous);
    const dir = join(runsDir, 'coordination');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(board, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temp, path);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
    return { wrote: true, path, board };
  } catch (error) {
    return { wrote: false, path, reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' };
  }
}
