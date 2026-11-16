/**
 * runs-sessions.ts — fleet.sessions.v1: the unified agent-session list behind
 * GET /api/fleet/sessions and the console's Sessions view.
 *
 * One row per dispatchd session — queued, parked, launching, running,
 * publishing, exited, stale or recently finished — assembled from the
 * documented local state under the runs dir (`~/.ashlr-runs`, or
 * ASHLR_RUNS_DIR / the injected runsDir):
 *
 *   queue/ready.tsv        waiting jobs: `job repo lane tier prompt-path`,
 *                          plus PARKED-DEP[.lane] status-first and lane-column
 *                          parked dialects (restock.py / dispatchd.py).
 *   queue/claimed.tsv      restock claim receipts `job lane tier HH:MM epoch`.
 *   queue/precheck-parked.json  precheck park state {job:{retry_at}}.
 *   queue/status.json      dispatcher snapshot (last_tick, paused).
 *   queue/run/<job>.line   claim record `job repo lane tier prompt-path`.
 *   queue/run/<job>.dispatched  claim epoch (seconds) written at dispatch.
 *   queue/run/<job>.enqueued    first-observation epoch (float seconds).
 *   queue/run/<job>.fin    completion marker keyed by .base mtime (dispatchd
 *                          emit_finish); absent on hosts running older
 *                          dispatchd — the finish ledger event covers those.
 *   queue/run/<job>.rc     agent exit code written by launch.sh.
 *   queue/run/<job>.reaping/    publisher actively running (a directory).
 *   queue/run/<job>.batched     owning batch id.
 *   queue/run/<job>.timeout     agent timeout marker.
 *   <job>.launch / .base / .log / .base.meta / .publish   worker artifacts at
 *                          the runs root (launch.sh / reap-one.sh outputs).
 *   metrics/jobs.jsonl     append-only event ledger (enqueue/claim/launch/
 *                          finish/publish) — tail-read only.
 *   process table          listLiveWorkers (ps) confirms live workers.
 *
 * VALUE-BLIND GUARDRAILS (same contract as runs-job-detail.ts):
 *  - Read-only, bounded fs reads. Never writes, never spawns except the
 *    injectable ps snapshot, never touches credentials or the network.
 *  - The prompt path (ready.tsv / .line field 5 / .prompt file) NEVER leaves
 *    this module — only job/repo/lane/tier metadata is emitted.
 *  - Every emitted string passes scrubSecrets and is length-capped; every
 *    source degrades independently — the snapshot never throws and never
 *    invents zeros for unreadable inputs.
 *  - lstat/O_NOFOLLOW discipline on every file read; symlinks are refused.
 */
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { listLiveWorkers, type ListLiveWorkersOptions } from './runs-live-workers.js';

// ---------------------------------------------------------------------------
// Public types — the fleet.sessions.v1 wire shape.
// ---------------------------------------------------------------------------

export type FleetSessionSourceState = 'healthy' | 'missing' | 'degraded';
export type FleetSessionStatus =
  | 'queued'      // ready.tsv row awaiting a dispatch slot
  | 'parked'      // ready.tsv row gated on dependencies or a precheck retry
  | 'launching'   // dispatched; launch grace window, no worker confirmed yet
  | 'running'     // live worker process or fresh on-disk agent activity
  | 'publishing'  // .reaping marker: the publisher owns the finished worktree
  | 'exited'      // .rc written (agent exit observed), awaiting finish/reap
  | 'stale'       // dispatched but no liveness evidence remains
  | 'finished';   // completion marker / finish ledger event (bounded recent tail)
export type FleetSessionLive = 'yes' | 'no' | 'unknown';
export type FleetSessionOutcome = 'pr' | 'empty' | 'failed' | 'unknown';

export interface FleetSessionV1 {
  job: string;
  repo: string | null;
  /** Dispatch lane/provider (codex-cmp, claude, devin, …). */
  lane: string | null;
  tier: string | null;
  status: FleetSessionStatus;
  /** Resolved model id when a launch ledger event or .base.meta recorded one. */
  model: string | null;
  /** Owning batch id when the job was claimed as a batch member. */
  batchId: string | null;
  pid: number | null;
  /** Process-table evidence: yes = ps matched, no = ps ran and found none,
   *  unknown = the ps read itself was unavailable. */
  live: FleetSessionLive;
  exitCode: number | null;
  timedOut: boolean;
  /** First observed in ready.tsv (.enqueued receipt / enqueue ledger event). */
  enqueuedAt: string | null;
  /** Dispatch claim time (.dispatched epoch / claim ledger event). */
  claimedAt: string | null;
  /** launch.sh start (.launch mtime / launch ledger ts). */
  launchedAt: string | null;
  /** Best session start: launchedAt ?? claimedAt ?? enqueuedAt. */
  startedAt: string | null;
  finishedAt: string | null;
  /** Active sessions: seconds since startedAt (queued/parked: seconds
   *  waiting). Finished sessions: null — see durationSeconds. */
  elapsedSeconds: number | null;
  /** Finished sessions: finishedAt - startedAt, preferring the ledger wall_s. */
  durationSeconds: number | null;
  /** claimedAt - enqueuedAt when both are known (dispatch latency). */
  queueWaitSeconds: number | null;
  /** Ledger-measured finish totals for THIS attempt; null while running or
   *  when the ledger tail did not cover the finish. */
  tokensTotal: number | null;
  wallSeconds: number | null;
  diffLines: number | null;
  /** Finished sessions only: publish/exit outcome. */
  outcome: FleetSessionOutcome | null;
  prUrl: string | null;
}

export interface FleetSessionsDispatcherV1 {
  lastTick: string | null;
  paused: boolean | null;
  tickAgeSeconds: number | null;
}

export interface FleetSessionsV1 {
  schema: 'fleet.sessions.v1';
  generatedAt: string;
  runsDirPresent: boolean;
  sourceState: FleetSessionSourceState;
  sources: Record<'runDir' | 'ready' | 'claimed' | 'precheck' | 'status' | 'metrics' | 'live', FleetSessionSourceState>;
  dispatcher: FleetSessionsDispatcherV1 | null;
  /** Active sessions (everything not finished), sorted by status rank. */
  sessions: FleetSessionV1[];
  /** Bounded tail of finished sessions, newest first. */
  recent: FleetSessionV1[];
  counts: {
    queued: number; parked: number; launching: number; running: number;
    publishing: number; exited: number; stale: number;
  };
  /** ready.tsv / .line / ledger rows that failed validation and were dropped. */
  malformed: number;
  truncated: boolean;
}

export interface FleetSessionsOptions {
  /** Runs directory. Default ASHLR_RUNS_DIR ?? ~/.ashlr-runs. Must be absolute. */
  runsDir?: string;
  /** Clock seam for tests (ms epoch). */
  now?: () => number;
  /** Process-table runner for the live-worker join; injectable for tests. */
  runPs?: ListLiveWorkersOptions['runPs'];
  /** Cap on active sessions returned. Default 500. */
  maxSessions?: number;
  /** Cap on finished sessions in `recent`. Default 50. */
  maxRecent?: number;
  /** Cap on .line markers scanned per read. Default 2000. */
  maxRunJobs?: number;
}

// ---------------------------------------------------------------------------
// Constants and small guards
// ---------------------------------------------------------------------------

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const REPO_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const TIER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
/** dispatchd TIERS plus 'low' (runs-live-workers accepts it; a queued 'low'
 *  row is still an honest queue entry even if this host's dispatchd skips it). */
const TIERS = new Set(['frontier', 'work', 'mid', 'fast', 'low']);
const PARKED = /^PARKED-([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9][A-Za-z0-9._@-]{0,63}))?$/i;
const PR_URL = /^https:\/\/github\.com\/[^\s?#]{1,200}$/;

const MAX_READY_FILE = 2 * 1024 * 1024;
const MAX_CLAIMED_FILE = 1024 * 1024;
const MAX_PRECHECK_FILE = 256 * 1024;
const MAX_STATUS_FILE = 1024 * 1024;
const MAX_METRICS_TAIL = 1024 * 1024;
const SMALL_READ = 16 * 1024;
const PUBLISH_TAIL = 64 * 1024;
const MAX_FIELD = 200;
const MAX_ROWS = 50_000;

/** dispatchd GRACE: a fresh .dispatched marker means the launch is in flight. */
const LAUNCH_GRACE_MS = 120_000;
/** dispatchd's own "still running" recency window on .base/.log mtimes. */
const DISK_ACTIVE_MS = 180_000;
const DEFAULT_MAX_SESSIONS = 500;
const DEFAULT_MAX_RECENT = 50;
const DEFAULT_MAX_RUN_JOBS = 2_000;
const SCAN_CHUNK = 64;

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

/** Control bytes cannot survive into the projection; cap length per value. */
function cleanField(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control bytes is the point.
  return scrubSecrets(value).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, MAX_FIELD);
}

const iso = (ms: number): string | null =>
  Number.isFinite(ms) && ms >= 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null;

const epochSeconds = (text: string): number | null => {
  const n = Number(text.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
};

const parseIsoMs = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

// ---------------------------------------------------------------------------
// Bounded reads — lstat + O_NOFOLLOW, same discipline as runs-dir-state.ts.
// ---------------------------------------------------------------------------

interface Probe {
  kind: 'file' | 'dir' | 'other' | 'missing' | 'error';
  size: number;
  mtimeMs: number | null;
}

async function probe(path: string): Promise<Probe> {
  try {
    const st = await lstat(path);
    return {
      kind: st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other',
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { kind: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'error', size: 0, mtimeMs: null };
  }
}

const missing = (p: Probe) => p.kind === 'missing';

/**
 * Read up to maxBytes of a regular file, tail-first: when the file is larger
 * the read starts at the last whole line boundary inside the window (a
 * partial first line is dropped). Returns null on any fs/shape failure —
 * callers degrade their own source. `clipped` marks a nonzero start offset.
 */
async function readSlice(path: string, maxBytes: number): Promise<{ text: string; clipped: boolean } | null> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile()) return null;
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile()) return null;
    const start = Math.max(0, info.size - maxBytes);
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, start + length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    let text = buffer.subarray(0, length).toString('utf8');
    if (start > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    return { text, clipped: start > 0 };
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function readSmall(path: string): Promise<string | null> {
  const slice = await readSlice(path, SMALL_READ);
  return slice?.text ?? null;
}

// ---------------------------------------------------------------------------
// ready.tsv — the waiting queue. Three positional dialects, all bounded.
// ---------------------------------------------------------------------------

export interface ReadySessionRow {
  job: string;
  repo: string | null;
  lane: string | null;
  tier: string | null;
  /** 'dependency' | 'precheck' | other PARKED-* reason | null when plain READY. */
  parked: string | null;
}

const parkedReason = (token: string | undefined): string | null => {
  const m = PARKED.exec(token ?? '');
  if (!m) return null;
  const reason = m[1]!.toUpperCase();
  return reason === 'DEP' || reason === 'DEPENDENCY' ? 'dependency' : reason.toLowerCase();
};

function validQueuedFields(job: string, repo: string, lane: string, tier: string): boolean {
  return JOB_ID.test(job) && REPO_ID.test(repo) && LANE_ID.test(lane) && TIERS.has(tier);
}

/**
 * Parse one ready.tsv line into a queued session row, or null when the row
 * is not a dispatchd launchable/parked record (comments, headers, kv rows,
 * malformed cells). The prompt-path cell is never retained.
 */
export function parseReadySessionLine(line: string): ReadySessionRow | null {
  const cells = line.replace(/\r$/, '').split('\t');
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  if (cells.length < 5) return null;
  const first = cells[0]!;
  if (first.startsWith('#') || first.includes('=')) return null;

  // Status-first parked dialect: PARKED-DEP[.lane] job lane tier repo prompt
  const leadParked = parkedReason(first);
  if (leadParked !== null) {
    if (cells.length < 6) return null;
    const [job, lane, tier, repo] = [cells[1]!, cells[2]!, cells[3]!, cells[4]!];
    if (!validQueuedFields(job, repo, lane, tier)) return null;
    return { job, repo: cleanField(repo), lane: cleanField(lane), tier: cleanField(tier), parked: leadParked };
  }

  // Lane-column parked dialect: job repo PARKED-DEP[.lane] tier prompt
  const laneParked = parkedReason(cells[2]);
  if (laneParked !== null) {
    const [job, repo, tier] = [cells[0]!, cells[1]!, cells[3]!];
    const lane = PARKED.exec(cells[2]!)?.[2] ?? null;
    if (!JOB_ID.test(job) || !REPO_ID.test(repo) || !TIERS.has(tier) || (lane !== null && !LANE_ID.test(lane))) return null;
    return { job, repo: cleanField(repo), lane: lane === null ? null : cleanField(lane), tier: cleanField(tier), parked: laneParked };
  }

  // Normal dialect: job repo lane tier prompt
  const [job, repo, lane, tier] = [cells[0]!, cells[1]!, cells[2]!, cells[3]!];
  if (!validQueuedFields(job, repo, lane, tier)) return null;
  return { job, repo: cleanField(repo), lane: cleanField(lane), tier: cleanField(tier), parked: null };
}

// ---------------------------------------------------------------------------
// queue/run markers — the per-session lifecycle record.
// ---------------------------------------------------------------------------

export interface RunMarkers {
  /** Job id from the .line FILENAME (the marker namespace dispatchd uses). */
  job: string;
  /** Job id inside the .line content; a mismatch marks the row malformed. */
  contentJob: string | null;
  lineMtimeMs: number | null;
  repo: string | null;
  lane: string | null;
  tier: string | null;
  fin: Probe;
  finKey: string | null;
  rc: number | null;
  rcMalformed: boolean;
  /** Claim epoch seconds from .dispatched content. */
  dispatched: number | null;
  /** First-observation epoch seconds (float) from .enqueued content. */
  enqueued: number | null;
  /** .reaping exists as a directory — the publisher owns this job now. */
  reaping: boolean;
  batched: string | null;
  timedOut: boolean;
}

/** `.line` content: job repo lane tier prompt-path — prompt never retained. */
export function parseSessionLine(text: string): { job: string; repo: string | null; lane: string | null; tier: string | null } | null {
  const cells = text.replace(/\r$/, '').split('\t');
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  if (cells.length < 4) return null;
  const [job, repo, lane, tier] = [cells[0]!, cells[1]!, cells[2]!, cells[3]!];
  if (!JOB_ID.test(job)) return null;
  return {
    job,
    repo: REPO_ID.test(repo) ? cleanField(repo) : null,
    lane: LANE_ID.test(lane) ? cleanField(lane) : null,
    tier: TIERS.has(tier) || TIER_ID.test(tier) ? cleanField(tier) : null,
  };
}

async function readMarkers(runDir: string, job: string, lineText: string, lineMtimeMs: number | null): Promise<RunMarkers> {
  const file = (suffix: string) => join(runDir, `${job}.${suffix}`);
  const [pFin, pRc, pDispatched, pEnqueued, pReaping, pBatched, pTimeout, pLine] = await Promise.all(
    ['fin', 'rc', 'dispatched', 'enqueued', 'reaping', 'batched', 'timeout', 'line'].map(s => probe(file(s))),
  );
  const [finText, rcText, dispatchedText, enqueuedText, batchedText] = await Promise.all([
    pFin.kind === 'file' ? readSmall(file('fin')) : Promise.resolve(null),
    pRc.kind === 'file' ? readSmall(file('rc')) : Promise.resolve(null),
    pDispatched.kind === 'file' ? readSmall(file('dispatched')) : Promise.resolve(null),
    pEnqueued.kind === 'file' ? readSmall(file('enqueued')) : Promise.resolve(null),
    pBatched.kind === 'file' ? readSmall(file('batched')) : Promise.resolve(null),
  ]);
  const parsed = parseSessionLine(lineText);
  const rc = rcText === null ? null : (() => {
    const v = rcText.trim();
    return /^-?\d{1,6}$/.test(v) ? Number(v) : null;
  })();
  const batched = batchedText === null ? null : cleanField(batchedText);
  return {
    job,
    contentJob: parsed?.job ?? null,
    lineMtimeMs: pLine.mtimeMs ?? lineMtimeMs,
    repo: parsed?.repo ?? null,
    lane: parsed?.lane ?? null,
    tier: parsed?.tier ?? null,
    fin: pFin,
    finKey: finText === null ? null : finText.trim().slice(0, 32),
    rc,
    rcMalformed: rcText !== null && rc === null,
    dispatched: dispatchedText === null ? null : epochSeconds(dispatchedText),
    enqueued: enqueuedText === null ? null : epochSeconds(enqueuedText),
    reaping: pReaping.kind === 'dir',
    batched: batched !== null && BATCH_ID.test(batched) ? batched : null,
    timedOut: pTimeout.kind === 'file' || pTimeout.kind === 'dir' || pTimeout.kind === 'other',
  };
}

/** .fin is keyed by the .base mtime (dispatchd emit_finish). A mismatch means
 *  the marker belongs to a previous attempt — the job is NOT finished. */
function finMatchesBase(finKey: string | null, baseMtimeMs: number | null): boolean {
  if (finKey === null || finKey === '') return false;
  if (baseMtimeMs === null) return true; // cannot verify; marker is the only evidence
  return finKey === String(Math.floor(baseMtimeMs / 1000));
}

// ---------------------------------------------------------------------------
// metrics/jobs.jsonl — tail-read event ledger; per-job launch/finish facts.
// ---------------------------------------------------------------------------

export interface JobMetricFacts {
  launchTsMs: number | null;
  launchModel: string | null;
  finishTsMs: number | null;
  tokensTotal: number | null;
  wallSeconds: number | null;
  diffLines: number | null;
  exitCode: number | null;
  empty: boolean | null;
  enqueueTsMs: number | null;
  claimTsMs: number | null;
  publishTsMs: number | null;
  prUrl: string | null;
}

const emptyFacts = (): JobMetricFacts => ({
  launchTsMs: null, launchModel: null, finishTsMs: null, tokensTotal: null,
  wallSeconds: null, diffLines: null, exitCode: null, empty: null,
  enqueueTsMs: null, claimTsMs: null, publishTsMs: null, prUrl: null,
});

function parseMetricTs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  // dispatchd writes local time `%Y-%m-%dT%H:%M:%S%z`; Date.parse handles it.
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const nonNegInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;

/**
 * Reduce a jobs.jsonl tail to the LAST relevant event per job. Malformed
 * lines are skipped (counted by the caller); nothing here throws.
 */
export function parseSessionMetrics(text: string): { facts: Map<string, JobMetricFacts>; malformed: number } {
  const facts = new Map<string, JobMetricFacts>();
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) { malformed++; continue; }
      row = parsed as Record<string, unknown>;
    } catch { malformed++; continue; }
    const job = row.job;
    // Jobless ledger events (concurrency, pool, …) carry no session facts —
    // they are skipped silently, not counted malformed.
    if (typeof job !== 'string') continue;
    if (!JOB_ID.test(job)) { malformed++; continue; }
    const ts = parseMetricTs(row.ts);
    const f = facts.get(job) ?? emptyFacts();
    facts.set(job, f);
    switch (row.event) {
      case 'enqueue':
        if (ts !== null) f.enqueueTsMs = ts;
        break;
      case 'claim':
        if (ts !== null) f.claimTsMs = ts;
        break;
      case 'launch': {
        if (ts !== null) f.launchTsMs = ts;
        if (typeof row.model === 'string' && MODEL_ID.test(row.model)) f.launchModel = cleanField(row.model);
        break;
      }
      case 'finish': {
        if (ts !== null) f.finishTsMs = ts;
        f.tokensTotal = nonNegInt(row.tokens_total);
        f.wallSeconds = typeof row.wall_s === 'number' && Number.isFinite(row.wall_s) && row.wall_s >= 0
          ? Math.floor(row.wall_s) : null;
        f.diffLines = nonNegInt(row.diff_lines);
        f.exitCode = typeof row.exit_code === 'number' && Number.isSafeInteger(row.exit_code) ? row.exit_code : null;
        f.empty = typeof row.empty === 'boolean' ? row.empty : null;
        break;
      }
      case 'publish': {
        if (ts !== null) f.publishTsMs = ts;
        const url = typeof row.url === 'string' && PR_URL.test(row.url) && scrubSecrets(row.url) === row.url ? row.url : null;
        if (url) f.prUrl = url;
        break;
      }
      default:
        break;
    }
  }
  return { facts, malformed };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface SessionDraft {
  job: string;
  repo: string | null;
  lane: string | null;
  tier: string | null;
  queued: boolean;
  parked: string | null;
  markers: RunMarkers | null;
}

function emptySession(job: string): FleetSessionV1 {
  return {
    job, repo: null, lane: null, tier: null, status: 'queued', model: null, batchId: null,
    pid: null, live: 'no', exitCode: null, timedOut: false,
    enqueuedAt: null, claimedAt: null, launchedAt: null, startedAt: null, finishedAt: null,
    elapsedSeconds: null, durationSeconds: null, queueWaitSeconds: null,
    tokensTotal: null, wallSeconds: null, diffLines: null, outcome: null, prUrl: null,
  };
}

export async function getFleetSessions(options: FleetSessionsOptions = {}): Promise<FleetSessionsV1> {
  const nowMs = (options.now ?? Date.now)();
  const root = options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(root)) throw new Error('runsDir must be an absolute path');
  const maxSessions = boundedLimit(options.maxSessions, DEFAULT_MAX_SESSIONS, 5000);
  const maxRecent = boundedLimit(options.maxRecent, DEFAULT_MAX_RECENT, 500);
  const maxRunJobs = boundedLimit(options.maxRunJobs, DEFAULT_MAX_RUN_JOBS, 20000);
  const queueDir = join(root, 'queue');
  const runDir = join(queueDir, 'run');

  const sources: FleetSessionsV1['sources'] = {
    runDir: 'missing', ready: 'missing', claimed: 'missing',
    precheck: 'missing', status: 'missing', metrics: 'missing', live: 'missing',
  };
  let malformed = 0;
  let truncated = false;

  // ── queue/run listing: every <job>.line is a dispatched session ──────────
  let runEntries: string[] = [];
  try {
    runEntries = await readdir(runDir);
    sources.runDir = 'healthy';
  } catch (error) {
    sources.runDir = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded';
  }
  const lineJobs = [...new Set(
    runEntries.filter(n => n.endsWith('.line') && n.length > 5)
      .map(n => n.slice(0, -5)).filter(j => JOB_ID.test(j)),
  )];

  // ── queue/ready.tsv — waiting sessions ───────────────────────────────────
  const readyRows: ReadySessionRow[] = [];
  const readyProbe = await probe(join(queueDir, 'ready.tsv'));
  if (readyProbe.kind === 'file') {
    const slice = await readSlice(join(queueDir, 'ready.tsv'), MAX_READY_FILE);
    if (slice === null) {
      sources.ready = 'degraded';
    } else {
      sources.ready = 'healthy';
      let rows = 0;
      let bad = 0;
      for (const line of slice.text.split(/\r?\n/)) {
        if (rows >= MAX_ROWS) { truncated = true; break; }
        if (!line.trim() || line.trimStart().startsWith('#')) continue;
        rows++;
        const parsed = parseReadySessionLine(line);
        if (parsed === null) { malformed++; bad++; continue; }
        readyRows.push(parsed);
      }
      // Same convention as runs-parked-queue: unparseable queue rows mean
      // the waiting-session view is incomplete — degrade, don't hide.
      if (bad > 0 || slice.clipped) sources.ready = 'degraded';
    }
  } else {
    sources.ready = missing(readyProbe) ? 'missing' : 'degraded';
  }

  // ── queue/claimed.tsv — restock claim receipts (enqueuedAt fallback) ─────
  const claimedAt = new Map<string, number>();
  const claimedProbe = await probe(join(queueDir, 'claimed.tsv'));
  if (claimedProbe.kind === 'file') {
    const slice = await readSlice(join(queueDir, 'claimed.tsv'), MAX_CLAIMED_FILE);
    if (slice === null) {
      sources.claimed = 'degraded';
    } else {
      sources.claimed = 'healthy';
      let rows = 0;
      let bad = 0;
      for (const line of slice.text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (rows >= MAX_ROWS) { truncated = true; break; }
        rows++;
        const cells = line.split('\t');
        const [job, , , , epoch] = cells;
        if (cells.length !== 5 || !JOB_ID.test(job ?? '') || !/^\d{1,12}$/.test(epoch ?? '')) { bad++; continue; }
        const ms = Number(epoch) * 1000;
        if (Number.isFinite(ms)) claimedAt.set(job, ms);
      }
      if (bad > 0 || slice.clipped) sources.claimed = 'degraded';
    }
  } else {
    sources.claimed = missing(claimedProbe) ? 'missing' : 'degraded';
  }

  // ── queue/precheck-parked.json — precheck park retries ───────────────────
  const precheckRetryAt = new Map<string, number>();
  const precheckProbe = await probe(join(queueDir, 'precheck-parked.json'));
  if (precheckProbe.kind === 'file') {
    const slice = await readSlice(join(queueDir, 'precheck-parked.json'), MAX_PRECHECK_FILE);
    if (slice === null) {
      sources.precheck = 'degraded';
    } else {
      try {
        const doc: unknown = JSON.parse(slice.text);
        if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) {
          sources.precheck = 'healthy';
          for (const [job, entry] of Object.entries(doc as Record<string, unknown>)) {
            if (!JOB_ID.test(job) || entry === null || typeof entry !== 'object') continue;
            const retryAt = (entry as Record<string, unknown>).retry_at;
            if (typeof retryAt === 'number' && Number.isFinite(retryAt) && retryAt > 0) {
              precheckRetryAt.set(job, retryAt * 1000);
            }
          }
        } else {
          sources.precheck = 'degraded';
        }
      } catch {
        sources.precheck = 'degraded';
      }
    }
  } else {
    sources.precheck = missing(precheckProbe) ? 'missing' : 'degraded';
  }

  // ── queue/status.json — dispatcher snapshot for header context ───────────
  let dispatcher: FleetSessionsDispatcherV1 | null = null;
  const statusProbe = await probe(join(queueDir, 'status.json'));
  if (statusProbe.kind === 'file') {
    const slice = await readSlice(join(queueDir, 'status.json'), MAX_STATUS_FILE);
    if (slice === null) {
      sources.status = 'degraded';
    } else {
      try {
        const doc = JSON.parse(slice.text) as Record<string, unknown>;
        const lastTickMs = parseIsoMs(typeof doc.last_tick === 'string' ? doc.last_tick : null);
        const paused = typeof doc.paused === 'boolean' ? doc.paused
          : typeof doc.paused === 'string' && doc.paused.trim() ? true
            : doc.paused === null && doc.schema === 'dispatchd.status.v1' ? false
              : null;
        dispatcher = {
          lastTick: lastTickMs !== null ? new Date(lastTickMs).toISOString() : null,
          paused,
          tickAgeSeconds: lastTickMs !== null ? Math.max(0, Math.round((nowMs - lastTickMs) / 1000)) : null,
        };
        sources.status = 'healthy';
      } catch {
        sources.status = 'degraded';
      }
    }
  } else {
    sources.status = missing(statusProbe) ? 'missing' : 'degraded';
  }

  // ── metrics/jobs.jsonl tail — launch/finish/enqueue facts per job ────────
  const metricFacts = new Map<string, JobMetricFacts>();
  const metricsPath = join(root, 'metrics', 'jobs.jsonl');
  const metricsProbe = await probe(metricsPath);
  if (missing(metricsProbe)) {
    sources.metrics = 'missing';
  } else if (metricsProbe.kind !== 'file') {
    sources.metrics = 'degraded';
  } else {
    const metricsSlice = await readSlice(metricsPath, MAX_METRICS_TAIL);
    if (metricsSlice === null) {
      sources.metrics = 'degraded';
    } else {
      const parsed = parseSessionMetrics(metricsSlice.text);
      for (const [job, facts] of parsed.facts) metricFacts.set(job, facts);
      sources.metrics = metricsSlice.clipped || parsed.malformed > 0 ? 'degraded' : 'healthy';
      malformed += Math.min(parsed.malformed, 1000);
    }
  }

  // ── live workers — ps snapshot joined by job id ──────────────────────────
  const live = await listLiveWorkers({ runPs: options.runPs, now: () => nowMs });
  sources.live = live.sourceState === 'healthy' ? 'healthy' : 'degraded';
  const workerByJob = new Map(live.workers.map(w => [w.job, w]));
  const psHealthy = live.sourceState === 'healthy';

  // ── scan queue/run .line jobs: probe all, newest marker first, then cap ──
  const lineProbes = await Promise.all(
    lineJobs.map(async job => ({ job, probe: await probe(join(runDir, `${job}.line`)) })),
  );
  lineProbes.sort((a, b) => (b.probe.mtimeMs ?? 0) - (a.probe.mtimeMs ?? 0));
  const fileProbes = lineProbes.filter(p => p.probe.kind === 'file');
  const scanned = fileProbes.slice(0, maxRunJobs);
  if (fileProbes.length > maxRunJobs) truncated = true;

  const drafts: SessionDraft[] = [];
  const dispatchedJobs = new Set<string>();
  for (let i = 0; i < scanned.length; i += SCAN_CHUNK) {
    const chunk = scanned.slice(i, i + SCAN_CHUNK);
    const markers = await Promise.all(chunk.map(async ({ job, probe: p }) => {
      const text = await readSmall(join(runDir, `${job}.line`));
      return text === null ? null : readMarkers(runDir, job, text, p.mtimeMs);
    }));
    for (const m of markers) {
      if (m === null) continue;
      dispatchedJobs.add(m.job);
      if (m.contentJob === null || m.contentJob !== m.job || m.rcMalformed) {
        malformed++;
        sources.runDir = 'degraded';
      }
      drafts.push({ job: m.job, repo: m.repo, lane: m.lane, tier: m.tier, queued: false, parked: null, markers: m });
    }
  }

  // ── ready.tsv rows not already dispatched become queued sessions ─────────
  // readyJobSet also drives the requeue case below: a job whose .line markers
  // show a finished/exited/stale attempt but which restock already re-queued
  // is honestly 'queued' for its next attempt, not 'finished'.
  const readyJobSet = new Set(readyRows.map(r => r.job));
  const seenQueued = new Set<string>();
  for (const row of readyRows) {
    if (dispatchedJobs.has(row.job) || seenQueued.has(row.job)) continue;
    seenQueued.add(row.job);
    const precheckAt = precheckRetryAt.get(row.job);
    const parked = row.parked ?? (precheckAt !== undefined && precheckAt > nowMs ? 'precheck' : null);
    drafts.push({ job: row.job, repo: row.repo, lane: row.lane, tier: row.tier, queued: true, parked, markers: null });
  }

  // ── assemble sessions ────────────────────────────────────────────────────
  const sessions: FleetSessionV1[] = [];
  const recent: FleetSessionV1[] = [];
  const counts = { queued: 0, parked: 0, launching: 0, running: 0, publishing: 0, exited: 0, stale: 0 };

  for (const draft of drafts) {
    const m = draft.markers;
    const facts = metricFacts.get(draft.job) ?? null;
    const worker = m === null ? undefined : workerByJob.get(draft.job);
    const session = emptySession(draft.job);
    session.repo = draft.repo;
    session.lane = draft.lane;
    session.tier = draft.tier;
    session.batchId = m?.batched ?? null;
    session.timedOut = m?.timedOut ?? false;
    session.live = worker ? 'yes' : psHealthy ? 'no' : 'unknown';
    session.pid = worker?.pid ?? null;

    if (draft.queued) {
      // Queued: first-observed time only — the .enqueued receipt dispatchd
      // leaves in queue/run even for waiting jobs, else claimed.tsv, else
      // the enqueue ledger event. Never a claim or launch timestamp (this
      // attempt has neither).
      let enqueuedMs: number | null = null;
      const enqSlice = await readSlice(join(runDir, `${draft.job}.enqueued`), SMALL_READ);
      const enqEpoch = enqSlice === null ? null : epochSeconds(enqSlice.text);
      if (enqEpoch !== null) enqueuedMs = enqEpoch * 1000;
      if (enqueuedMs === null) enqueuedMs = claimedAt.get(draft.job) ?? facts?.enqueueTsMs ?? null;
      session.enqueuedAt = enqueuedMs !== null ? iso(enqueuedMs) : null;
      session.status = draft.parked !== null ? 'parked' : 'queued';
      session.startedAt = session.enqueuedAt;
      session.elapsedSeconds = session.enqueuedAt !== null
        ? Math.max(0, Math.round((nowMs - Date.parse(session.enqueuedAt)) / 1000)) : null;
      counts[session.status === 'parked' ? 'parked' : 'queued']++;
      sessions.push(session);
      continue;
    }

    // ── Dispatched session — run markers exist. ──────────────────────────
    const lineMs = m!.lineMtimeMs ?? 0;
    // Ledger facts scoped to THIS attempt: events must postdate the .line
    // claim (2s tolerance — ledger ts has one-second precision) or they
    // belong to a previous attempt of the same job id.
    const attemptLaunch = facts !== null && facts.launchTsMs !== null && facts.launchTsMs >= lineMs - 2000 ? facts : null;
    const attemptFinish = facts !== null && facts.finishTsMs !== null && facts.finishTsMs > lineMs ? facts : null;
    const attemptPublish = facts !== null && facts.publishTsMs !== null && facts.publishTsMs > lineMs ? facts.prUrl : null;

    const baseProbe = await probe(join(root, `${draft.job}.base`));
    const launchProbe = await probe(join(root, `${draft.job}.launch`));
    const logProbe = await probe(join(root, `${draft.job}.log`));
    const publishProbe = await probe(join(root, `${draft.job}.publish`));
    const metaProbe = await probe(join(root, `${draft.job}.base.meta`));

    session.model = attemptLaunch?.launchModel ?? null;
    session.exitCode = m!.rc ?? attemptFinish?.exitCode ?? null;

    // Timestamps: marker content first (exact epochs), file mtimes next,
    // ledger ts last. Unknown stays null — nothing is fabricated.
    session.enqueuedAt = m!.enqueued !== null ? iso(m!.enqueued * 1000)
      : (facts?.enqueueTsMs !== null && facts?.enqueueTsMs !== undefined ? iso(facts.enqueueTsMs)
        : claimedAt.get(draft.job) !== undefined ? iso(claimedAt.get(draft.job)!) : null);
    session.claimedAt = m!.dispatched !== null ? iso(m!.dispatched * 1000)
      : (facts?.claimTsMs !== null && facts?.claimTsMs !== undefined ? iso(facts.claimTsMs) : null);
    session.launchedAt = attemptLaunch?.launchTsMs !== null && attemptLaunch?.launchTsMs !== undefined
      ? iso(attemptLaunch.launchTsMs)
      : (launchProbe.mtimeMs !== null ? iso(launchProbe.mtimeMs) : null);
    session.startedAt = session.launchedAt ?? session.claimedAt ?? session.enqueuedAt;

    // Finished? .fin keyed to this attempt's .base mtime, a finish ledger
    // event newer than the claim, or a publish RESULT with an exit code on
    // a host whose dispatchd never wrote .fin.
    const finFresh = m!.fin.kind === 'file' && finMatchesBase(m!.finKey, baseProbe.mtimeMs);
    const publishText = publishProbe.kind === 'file'
      ? (await readSlice(join(root, `${draft.job}.publish`), PUBLISH_TAIL))?.text ?? null
      : null;
    const finished = finFresh || attemptFinish !== null
      || (publishText !== null && m!.rc !== null && !m!.reaping);

    // Liveness evidence shared by the requeue guard and status classification:
    // ps worker, .reaping publisher, launch grace, or fresh agent artifacts
    // (.base/.log/.launch within dispatchd's own 180s recency window) while
    // no exit code has been written.
    const diskFreshMs = Math.max(
      baseProbe.mtimeMs ?? 0, logProbe.mtimeMs ?? 0, launchProbe.mtimeMs ?? 0, lineMs,
    );
    const dispatchedMs = m!.dispatched !== null ? m!.dispatched * 1000 : lineMs;
    const withinGrace = m!.rc === null && nowMs - dispatchedMs <= LAUNCH_GRACE_MS;
    const diskLive = m!.rc === null && diskFreshMs > 0 && nowMs - diskFreshMs <= DISK_ACTIVE_MS;
    const attemptLive = worker !== undefined || m!.reaping || withinGrace || diskLive;

    // Requeue: the job already sits in ready.tsv again while its last
    // attempt's markers remain. Unless this attempt is provably live the
    // honest status is 'queued' for the next attempt — not 'finished'.
    if (readyJobSet.has(draft.job) && !attemptLive) {
      session.status = 'queued';
      session.startedAt = session.enqueuedAt;
      session.elapsedSeconds = session.enqueuedAt !== null
        ? Math.max(0, Math.round((nowMs - Date.parse(session.enqueuedAt)) / 1000)) : null;
      counts.queued++;
      sessions.push(session);
      continue;
    }

    if (finished) {
      session.status = 'finished';
      const finMs = m!.fin.mtimeMs;
      const diskEnd = Math.max(baseProbe.mtimeMs ?? 0, logProbe.mtimeMs ?? 0);
      const finishedMs = finMs ?? attemptFinish?.finishTsMs ?? (diskEnd > 0 ? diskEnd : null);
      session.finishedAt = finishedMs !== null && finishedMs !== undefined ? iso(finishedMs) : null;
      session.durationSeconds = attemptFinish?.wallSeconds
        ?? (session.finishedAt !== null && session.startedAt !== null
          ? Math.max(0, Math.round((Date.parse(session.finishedAt) - Date.parse(session.startedAt)) / 1000))
          : null);
      session.tokensTotal = attemptFinish?.tokensTotal ?? null;
      session.wallSeconds = attemptFinish?.wallSeconds ?? null;
      session.diffLines = attemptFinish?.diffLines ?? null;
      const prMatch = publishText?.match(/^RESULT\s+PR\s+(\S+)/m);
      session.prUrl = attemptPublish
        ?? (prMatch && PR_URL.test(prMatch[1]!) && scrubSecrets(prMatch[1]!) === prMatch[1] ? prMatch[1]! : null);
      session.outcome = session.prUrl !== null ? 'pr'
        : publishText !== null && publishText.includes('RESULT EMPTY') ? 'empty'
          : session.exitCode !== null && session.exitCode !== 0 ? 'failed'
            : attemptFinish?.empty === true ? 'empty' : 'unknown';
      recent.push(session);
      continue;
    }

    // ── Active dispatched session. ────────────────────────────────────────
    if (m!.reaping) {
      session.status = 'publishing';
    } else if (m!.rc !== null) {
      session.status = 'exited';
    } else if (worker) {
      session.status = 'running';
    } else if (withinGrace) {
      session.status = 'launching';
    } else if (diskLive) {
      session.status = 'running'; // unconfirmed: ps found nothing but artifacts are fresh
    } else {
      session.status = 'stale';
    }

    // Model fallback: .base.meta `MODEL <lane> <tier> <model>` for jobs whose
    // launch ledger event predates the tail or was never emitted.
    if (session.model === null && metaProbe.kind === 'file') {
      const meta = await readSmall(join(root, `${draft.job}.base.meta`));
      const mm = meta?.match(/^MODEL\s+\S+\s+\S+\s+(\S+)/m);
      if (mm && MODEL_ID.test(mm[1]!)) session.model = cleanField(mm[1]!);
    }

    session.elapsedSeconds = session.startedAt !== null
      ? Math.max(0, Math.round((nowMs - Date.parse(session.startedAt)) / 1000)) : null;
    session.queueWaitSeconds = session.enqueuedAt !== null && session.claimedAt !== null
      ? Math.max(0, Math.round((Date.parse(session.claimedAt) - Date.parse(session.enqueuedAt)) / 1000)) : null;
    counts[session.status as keyof typeof counts]++;
    sessions.push(session);
  }

  // Sort: in-flight work first (running → launching → publishing → exited →
  // stale), then the waiting queue (queued → parked); oldest start first so
  // the longest-running session leads. `recent` is finishedAt-desc.
  const rank: Record<FleetSessionStatus, number> = {
    running: 0, launching: 1, publishing: 2, exited: 3, stale: 4, queued: 5, parked: 6, finished: 7,
  };
  const startMs = (s: FleetSessionV1): number => {
    const ms = s.startedAt === null ? Number.NaN : Date.parse(s.startedAt);
    return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
  };
  sessions.sort((a, b) =>
    rank[a.status] - rank[b.status]
    || startMs(a) - startMs(b)
    || a.job.localeCompare(b.job));
  const finishMs = (s: FleetSessionV1): number => {
    const ms = s.finishedAt === null ? Number.NaN : Date.parse(s.finishedAt);
    return Number.isFinite(ms) ? ms : 0;
  };
  recent.sort((a, b) => finishMs(b) - finishMs(a) || a.job.localeCompare(b.job));
  if (sessions.length > maxSessions) { sessions.length = maxSessions; truncated = true; }
  if (recent.length > maxRecent) { recent.length = maxRecent; truncated = true; }

  // 'missing' describes the runs-dir evidence: the ps join is orthogonal
  // infra, so a dead runs dir reports 'missing' even when ps is healthy.
  const fileStates = (Object.keys(sources) as Array<keyof typeof sources>)
    .filter(k => k !== 'live').map(k => sources[k]);
  const sourceState: FleetSessionSourceState = fileStates.every(s => s === 'missing') ? 'missing'
    : Object.values(sources).every(s => s === 'healthy') ? 'healthy' : 'degraded';

  return {
    schema: 'fleet.sessions.v1',
    generatedAt: new Date(nowMs).toISOString(),
    runsDirPresent: sources.runDir !== 'missing' || sources.ready !== 'missing',
    sourceState,
    sources,
    dispatcher,
    sessions,
    recent,
    counts,
    malformed,
    truncated,
  };
}
