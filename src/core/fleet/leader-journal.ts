import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { redactHomePaths, scrubPrivateText } from '../util/scrub.js';
import { readSource } from './runs-parked-queue.js';

export const VERSE_OPS_LEADER_JOURNAL_PATH = '/api/verse/ops/leader-journal';
export interface JournalSection { title: string; bullets: string[] }
export interface LeaderNote { at: string; bullets: string[] }
export interface JournalPass { at: string; sections: JournalSection[] }
export interface DropIngestRow { verb: string; file: string; reason: string | null }
export interface DropIngestedRow { at: string; id: string; leader: string; lane: string; tier: string; title: string }
export interface LeaderJournalV1 {
  v: 1; generatedAt: string;
  sources: Record<'planLog' | 'ingestLog' | 'ingested' | 'orchestration', 'healthy' | 'missing' | 'degraded'>;
  notes: LeaderNote[];
  passes: JournalPass[]; ingest: DropIngestRow[]; ingested: DropIngestedRow[];
  rejectedLastHour: number | null;
}

const TAIL_BYTES = 256 * 1024;
const SENSITIVE = /token|secret|api[_-]?key|authorization|bearer/i;
const limitTo = (n: number, max: number) => Number.isFinite(n) ? Math.min(max, Math.max(0, Math.floor(n))) : 0;
function clean(text: string, max: number): string {
  return redactHomePaths(scrubPrivateText(text)).replace(/\p{Cc}/gu, ' ').slice(0, max);
}
function safeLine(line: string): string { return SENSITIVE.test(line) ? '[redacted line]' : line; }

export function parsePlanLog(markdown: string, limit = 8): JournalPass[] {
  const passes: JournalPass[] = [];
  let pass: JournalPass | undefined;
  let section: JournalSection | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      pass = { at: clean(safeLine(heading[1]), 80), sections: [] };
      passes.push(pass);
      section = undefined;
      continue;
    }
    const title = /^\s*\*\*(.+?)\*\*\s*$/.exec(line);
    if (title && pass) {
      section = pass.sections.length < 32 ? { title: clean(safeLine(title[1]), 80), bullets: [] } : undefined;
      if (section) pass.sections.push(section);
      continue;
    }
    const bullet = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (bullet && section && section.bullets.length < 12) section.bullets.push(clean(safeLine(bullet[1]), 300));
  }
  return passes.reverse().slice(0, limitTo(limit, 8));
}

export function parseLeaderNotes(markdown: string, limit = 12): LeaderNote[] {
  const notes: LeaderNote[] = [];
  let note: LeaderNote | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      const heading = /^## Leader notes, (.+?)(?: \(.*)?$/.exec(line);
      note = heading ? { at: clean(safeLine(heading[1].trim()), 80), bullets: [] } : undefined;
      if (note) notes.push(note);
    } else if (note && line.startsWith('- ')) {
      note.bullets.push(clean(safeLine(line.slice(2).trim()), 400));
    }
  }
  return notes.reverse().slice(0, limitTo(limit, 12));
}

// Accept timestamps only as a prefix, so a timestamp in a reason cannot change the count.
function ingestParts(line: string): { at: number | null; body: string } {
  const match = /^\[?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\]?\s+(.+)$/.exec(line);
  if (!match) return { at: null, body: line };
  const at = Date.parse(match[1]);
  return { at: Number.isFinite(at) ? at : null, body: match[2] };
}
export function parseIngestLog(text: string, limit = 30): DropIngestRow[] {
  return text.split(/\r?\n/).filter(Boolean).slice(-30).reverse().flatMap(line => {
    const safe = safeLine(line);
    if (safe === '[redacted line]') return [{ verb: clean(safe, 80), file: '', reason: null }];
    const match = /^(\S+)\s+(\S+)(?:\s+(.+))?$/.exec(ingestParts(safe).body.trim());
    return match ? [{ verb: clean(match[1], 80), file: clean(match[2], 300), reason: match[3] ? clean(match[3], 300) : null }] : [];
  }).slice(0, limitTo(limit, 30));
}
export function parseIngestedTsv(text: string, limit = 30): DropIngestedRow[] {
  return text.split(/\r?\n/).filter(Boolean).slice(-30).reverse().flatMap(line => {
    const fields = line.split('\t');
    if (fields.length !== 6) return [];
    if (SENSITIVE.test(line)) fields.splice(0, 6, '[redacted line]', '', '', '', '', '');
    const [at, id, leader, lane, tier, title] = fields.map(value => clean(value, 300));
    return [{ at, id, leader, lane, tier, title }];
  }).slice(0, limitTo(limit, 30));
}

async function directory(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) throw new Error('invalid directory');
}
async function readTail(path: string): Promise<{ text: string; truncated: boolean }> {
  if (!(await lstat(path)).isFile()) throw new Error('invalid source');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('invalid source');
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, start + used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const text = buffer.subarray(0, used).toString('utf8');
    return { text: start ? text.slice(text.indexOf('\n') + 1 || text.length) : text, truncated: start > 0 };
  } finally { await file.close(); }
}
export async function readLeaderJournal(opts: { runsDir?: string; now?: () => number } = {}): Promise<LeaderJournalV1> {
  let now = Date.now();
  try { const value = (opts.now ?? Date.now)(); if (Number.isFinite(value) && Math.abs(value) <= 8.64e15) now = value; } catch { /* use the system clock */ }
  const state: LeaderJournalV1 = { v: 1, generatedAt: new Date(now).toISOString(),
    sources: { orchestration: 'missing', planLog: 'missing', ingestLog: 'missing', ingested: 'missing' },
    notes: [], passes: [], ingest: [], ingested: [], rejectedLastHour: null };
  const root = opts.runsDir ?? join(homedir(), '.ashlr-runs');
  const leader = join(root, 'leader');
  const drop = join(leader, 'drop');
  async function source(key: keyof LeaderJournalV1['sources'], path: string, dirs: string[], consume: (text: string, truncated: boolean) => void): Promise<void> {
    try {
      if (!isAbsolute(root)) throw new Error('invalid runs directory');
      for (const dir of dirs) await directory(dir);
      const result = await readTail(path);
      consume(result.text, result.truncated);
      state.sources[key] = 'healthy';
    } catch (error) { state.sources[key] = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'degraded'; }
  }
  await Promise.all([
    source('orchestration', join(leader, 'ORCHESTRATION.md'), [root, leader], text => { state.notes = parseLeaderNotes(text); }),
    source('planLog', join(leader, 'PLAN-LOG.md'), [root, leader], text => { state.passes = parsePlanLog(text); }),
    source('ingestLog', join(drop, 'ingest.log'), [root, leader, drop], (text, truncated) => {
      state.ingest = parseIngestLog(text);
      let found = false; let count = 0;
      for (const line of text.split(/\r?\n/)) {
        const { at, body } = ingestParts(line);
        if (at === null) continue;
        found = true;
        if (at <= now && at >= now - 3600000 && /^reject(?:\s|$)/i.test(body)) count++;
      }
      state.rejectedLastHour = found && !truncated ? count : null;
    }),
    source('ingested', join(drop, 'ingested.tsv'), [root, leader, drop], text => { state.ingested = parseIngestedTsv(text); }),
  ]);
  return state;
}

// ---------------------------------------------------------------------------
// Leader-as-CEO board (RQ-SWE3-BOARDUI-1) — bounded reader + wire contract for
// the board the last Leader tick wrote at `<runs>/coordination/leader-board.json`
// (schema `fleet.leader-board.v1`).
//
// The writer lives in core/fleet/leader-board.ts (RQ-SWE3-LEADERLOOP-1) and
// `phm fleet board` prints it. This reader is the console's side of the same
// file contract: it never rebuilds the board from queue sources — it reads
// the recording, so the HTTP surface shows exactly what the CLI shows,
// including the tick's own `generatedAt`. A missing or corrupt board reports
// 'missing'/'unavailable', never a synthesized one.
//
// The response envelope matches `phm fleet board --json` field-for-field
// ({schema, status, ageSeconds, board}) so the API and the CLI cannot drift
// into two dialects of the same state file.
//
// LOOPBACK-SAFE AND BOUNDED: one capped, symlink-refusing read through the
// same readSource() the fleet queue readers use. No gh, no network, no
// model, no writes.
// ---------------------------------------------------------------------------

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

// Strict projection — the file is evidence, not a trusted object. Unknown or
// malformed fields degrade to null/dropped entries; they never throw and are
// never echoed through.

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
