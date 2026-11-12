/**
 * core/fleet/fleet-board-read.ts — bounded reader + wire contract for the
 * Leader-as-CEO board the last Leader tick wrote at
 * `<runs>/coordination/leader-board.json` (schema `fleet.leader-board.v1`).
 *
 * The writer lives in core/fleet/leader-board.ts (RQ-SWE3-LEADERLOOP-1) and
 * `phm fleet board` prints it. This reader is the console's side of the same
 * file contract: it never rebuilds the board from queue sources — it reads
 * the recording, so the HTTP surface shows exactly what the CLI shows,
 * including the tick's own `generatedAt`. A missing or corrupt board reports
 * 'missing'/'unavailable', never a synthesized one.
 *
 * The response envelope matches `phm fleet board --json` field-for-field
 * ({schema, status, ageSeconds, board}) so the API and the CLI cannot drift
 * into two dialects of the same state file.
 *
 * LOOPBACK-SAFE AND BOUNDED: one capped, symlink-refusing read through the
 * same readSource() the fleet queue readers use. No gh, no network, no
 * model, no writes.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readSource } from './runs-parked-queue.js';

/** Same schema string core/fleet/leader-board.ts writes (LEADER_BOARD_SCHEMA). */
export const FLEET_BOARD_SCHEMA = 'fleet.leader-board.v1' as const;
export const FLEET_BOARD_FILE = 'leader-board.json';

const MAX_BOARD_BYTES = 256 * 1024;
const MAX_LANES = 64;
const MAX_HISTORY = 96;
const MAX_NEEDS_ITEMS = 10;
const MAX_TIER_KEYS = 16;
const MAX_ITEM_TEXT = 300;
const MAX_KEY = 64;

export interface FleetBoardLane {
  lane: string;
  ready: number | null;
  parked: number | null;
  running: number | null;
  mergesLastHour: number | null;
  oldestWaitSeconds: number | null;
}

export interface FleetBoardConflictSample {
  at: string;
  count: number;
}

export type FleetBoardConflictTrend = 'rising' | 'falling' | 'flat' | 'unknown';

export interface FleetBoardNeedsMasonItem {
  id: string;
  text: string;
}

export type FleetBoardNeedsMasonStatus = 'available' | 'missing' | 'unavailable';
export type FleetBoardSourceState = 'healthy' | 'missing' | 'degraded';

export interface FleetBoardV1 {
  schema: typeof FLEET_BOARD_SCHEMA;
  generatedAt: string;
  lanes: FleetBoardLane[];
  queueDepthByTier: Record<string, number> | null;
  mergesLastHour: number | null;
  conflictingPrs: {
    count: number | null;
    delta: number | null;
    trend: FleetBoardConflictTrend;
    history: FleetBoardConflictSample[];
  };
  needsMason: {
    status: FleetBoardNeedsMasonStatus;
    count: number;
    items: FleetBoardNeedsMasonItem[];
  };
  sources: {
    readyTsv: FleetBoardSourceState;
    queueCounts: 'ok' | 'unavailable';
    needsMason: FleetBoardNeedsMasonStatus;
  };
}

export type FleetBoardStatus = 'ok' | 'missing' | 'unavailable';

export type FleetBoardRead =
  | { status: 'ok'; board: FleetBoardV1 }
  | { status: 'missing' | 'unavailable'; board: null };

/**
 * The exact envelope `phm fleet board --json` prints — the API serves this
 * verbatim so the console and the CLI read the same projection.
 */
export interface FleetBoardResponse {
  schema: typeof FLEET_BOARD_SCHEMA;
  status: FleetBoardStatus;
  /** Whole seconds since the recording tick; null when there is no board. */
  ageSeconds: number | null;
  board: FleetBoardV1 | null;
}

export function fleetBoardPath(runsDir: string): string {
  return join(runsDir, 'coordination', FLEET_BOARD_FILE);
}

export function defaultFleetBoardRunsDir(): string {
  return process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
}

// ---------------------------------------------------------------------------
// Strict projection — the file is evidence, not a trusted object. Unknown or
// malformed fields degrade to null/dropped entries; they never throw and are
// never echoed through.
// ---------------------------------------------------------------------------

const finiteOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const countOrNull = (v: unknown): number | null =>
  Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null;

const TRENDS: ReadonlySet<string> = new Set(['rising', 'falling', 'flat', 'unknown']);
const NEEDS_STATUSES: ReadonlySet<string> = new Set(['available', 'missing', 'unavailable']);
const SOURCE_STATES: ReadonlySet<string> = new Set(['healthy', 'missing', 'degraded']);

const rec = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function parseLanes(raw: unknown): FleetBoardLane[] {
  if (!Array.isArray(raw)) return [];
  const lanes: FleetBoardLane[] = [];
  for (const entry of raw.slice(0, MAX_LANES)) {
    const row = rec(entry);
    if (row === null) continue;
    const lane = row['lane'];
    if (typeof lane !== 'string' || lane === '' || lane.length > MAX_KEY) continue;
    lanes.push({
      lane,
      ready: countOrNull(row['ready']),
      parked: countOrNull(row['parked']),
      running: countOrNull(row['running']),
      mergesLastHour: countOrNull(row['mergesLastHour']),
      oldestWaitSeconds: finiteOrNull(row['oldestWaitSeconds']),
    });
  }
  return lanes;
}

function parseDepthByTier(raw: unknown): Record<string, number> | null {
  if (raw === null || raw === undefined) return null;
  const obj = rec(raw);
  if (!obj) return null;
  const out: Record<string, number> = {};
  for (const [tier, count] of Object.entries(obj).slice(0, MAX_TIER_KEYS)) {
    const n = countOrNull(count);
    if (tier === '' || tier.length > MAX_KEY || n === null) continue;
    out[tier] = n;
  }
  return out;
}

function parseConflicts(raw: unknown): FleetBoardV1['conflictingPrs'] {
  const fallback: FleetBoardV1['conflictingPrs'] = { count: null, delta: null, trend: 'unknown', history: [] };
  const obj = rec(raw);
  if (!obj) return fallback;
  const history: FleetBoardConflictSample[] = [];
  if (Array.isArray(obj['history'])) {
    for (const entry of obj['history'].slice(0, MAX_HISTORY)) {
      const sample = rec(entry);
      const count = countOrNull(sample?.['count']);
      if (typeof sample?.['at'] !== 'string' || !Number.isFinite(Date.parse(sample['at'])) || count === null) continue;
      history.push({ at: sample['at'], count });
    }
  }
  const trend = obj['trend'];
  return {
    count: countOrNull(obj['count']),
    delta: Number.isSafeInteger(obj['delta']) ? (obj['delta'] as number) : null,
    trend: typeof trend === 'string' && TRENDS.has(trend) ? (trend as FleetBoardConflictTrend) : 'unknown',
    history,
  };
}

function parseNeedsMason(raw: unknown): FleetBoardV1['needsMason'] {
  const obj = rec(raw);
  const status = obj?.['status'];
  const items: FleetBoardNeedsMasonItem[] = [];
  if (Array.isArray(obj?.['items'])) {
    for (const entry of obj!['items'].slice(0, MAX_NEEDS_ITEMS)) {
      const item = rec(entry);
      const id = item?.['id'];
      const text = item?.['text'];
      if (typeof id !== 'string' || id === '' || id.length > MAX_KEY) continue;
      if (typeof text !== 'string' || text === '') continue;
      items.push({ id, text: text.slice(0, MAX_ITEM_TEXT) });
    }
  }
  return {
    status: typeof status === 'string' && NEEDS_STATUSES.has(status) ? (status as FleetBoardNeedsMasonStatus) : 'unavailable',
    count: countOrNull(obj?.['count']) ?? items.length,
    items,
  };
}

function parseSources(raw: unknown): FleetBoardV1['sources'] {
  const obj = rec(raw);
  const readyTsv = obj?.['readyTsv'];
  const queueCounts = obj?.['queueCounts'];
  const needsMason = obj?.['needsMason'];
  return {
    readyTsv: typeof readyTsv === 'string' && SOURCE_STATES.has(readyTsv) ? (readyTsv as FleetBoardSourceState) : 'degraded',
    queueCounts: queueCounts === 'ok' ? 'ok' : 'unavailable',
    needsMason: typeof needsMason === 'string' && NEEDS_STATUSES.has(needsMason) ? (needsMason as FleetBoardNeedsMasonStatus) : 'unavailable',
  };
}

/**
 * Parse board text into the strict v1 shape. Returns null when the payload is
 * not an object or does not carry the schema marker + a parseable
 * generatedAt — a file that lost its provenance is unavailable, not a board
 * with made-up fields.
 */
export function parseFleetBoard(text: string): FleetBoardV1 | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const obj = rec(raw);
  if (obj === null) return null;
  const generatedAt = obj['generatedAt'];
  if (obj['schema'] !== FLEET_BOARD_SCHEMA || typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt))) {
    return null;
  }
  return {
    schema: FLEET_BOARD_SCHEMA,
    generatedAt,
    lanes: parseLanes(obj['lanes']),
    queueDepthByTier: parseDepthByTier(obj['queueDepthByTier']),
    mergesLastHour: countOrNull(obj['mergesLastHour']),
    conflictingPrs: parseConflicts(obj['conflictingPrs']),
    needsMason: parseNeedsMason(obj['needsMason']),
    sources: parseSources(obj['sources']),
  };
}

// ---------------------------------------------------------------------------
// Read + digest
// ---------------------------------------------------------------------------

/** Bounded, symlink-refusing read of the board file (same readSource the fleet queue readers use). */
export async function readFleetBoard(opts: { runsDir?: string } = {}): Promise<FleetBoardRead> {
  const source = await readSource(fleetBoardPath(opts.runsDir ?? defaultFleetBoardRunsDir()), MAX_BOARD_BYTES, false);
  if (source.state === 'missing') return { status: 'missing', board: null };
  if (source.state !== 'healthy') return { status: 'unavailable', board: null };
  const board = parseFleetBoard(source.text);
  return board === null ? { status: 'unavailable', board: null } : { status: 'ok', board };
}

/**
 * `size:mtimeMs` fingerprint of the board file for the /api/events pusher —
 * the cheap per-tick check that decides whether a `fleet-board` event is owed.
 * null means absent/unreadable; a transition to or from null is itself a change.
 */
export async function fleetBoardDigest(opts: { runsDir?: string } = {}): Promise<string | null> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(fleetBoardPath(opts.runsDir ?? defaultFleetBoardRunsDir()), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_BOARD_BYTES) return null;
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

/** Build the `{schema, status, ageSeconds, board}` envelope — identical fields to `phm fleet board --json`. */
export function fleetBoardResponse(read: FleetBoardRead, nowMs: number): FleetBoardResponse {
  const ageMs = read.board === null ? null : Math.max(0, nowMs - Date.parse(read.board.generatedAt));
  return {
    schema: FLEET_BOARD_SCHEMA,
    status: read.status,
    ageSeconds: ageMs === null || !Number.isFinite(ageMs) ? null : Math.floor(ageMs / 1000),
    board: read.board,
  };
}
