/**
 * Read-only dispatcher session projection for the TUI Sessions tab.
 *
 * Sources (all under the fleet runs dir — ASHLR_RUNS_DIR, then ~/.ashlr-runs):
 *   queue/status.json          dispatchd.status.v1 lane/queue summary
 *   queue/run/<job>.line       claim record: job \t repo \t lane \t tier \t prompt-path
 *   queue/run/<job>.dispatched launch epoch (seconds) written at claim time
 *   queue/run/<job>.rc         agent exit code written by the lane wrapper
 *   queue/run/<job>.timeout    wall-cap kill marker (local_job.py supervisor)
 *   queue/run/<job>.fin        candidate-dispatcher "seen finished" emit
 *   queue/run/<job>.reaping    directory marker while dispatchd reaps/publishes
 *   queue/run/<job>.keptlogged worktree kept for supervisor marker
 *
 * VALUE-BLIND: only validated identifier/status/timing fields leave this
 * module. The .line prompt-path field, .base worktree paths, .publish RESULT
 * text, .launch output, agent logs and every environment value are never read
 * into the projection (marker contents are read only when they are a bounded
 * epoch/integer). Every emitted string passes scrubSecrets and a strict
 * shape check; malformed rows degrade to null fields, never to guesses.
 *
 * The reader NEVER throws: a missing runs dir yields sourceState 'missing',
 * corrupt sources degrade independently, and the session list is always a
 * bounded array. Read-only: no writes, no process inspection, no network.
 */
import { constants } from 'node:fs';
import { open, readdir, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { GLOBAL_SLOT_KEYS, LANE_ID_RE } from './runs-lane-targets.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type FleetSessionHealth = 'healthy' | 'missing' | 'degraded';

/**
 * Marker-derived lifecycle state. 'running' means the claim markers show a
 * launched attempt with no terminal marker — the state-file view cannot see
 * the process table, so a killed-without-.rc orphan reads as 'running' until
 * dispatchd's own reap logic agrees it is finished.
 */
export type FleetSessionStatus =
  | 'launching'   // .dispatched mtime inside dispatchd's 120s launch grace
  | 'running'     // claimed + launched, no terminal marker yet
  | 'publishing'  // .reaping marker — dispatchd is reaping/publishing the result
  | 'done'        // .rc === 0
  | 'failed'      // .rc !== 0
  | 'timeout'     // .timeout wall-cap kill marker present
  | 'finished'    // .fin present without .rc (candidate dispatcher emit)
  | 'exited'      // .rc present but not a parseable exit code
  | 'unknown';    // .line claim record only — no live or terminal evidence

export interface FleetSessionLane {
  lane: string;
  running: number;
  target: number;
  queued: number;
  held: boolean;
}

export interface FleetSession {
  /** Job id — the queue/run marker namespace (validated, scrubbed). */
  job: string;
  /** Repo name from the .line record (bare name; never a path). */
  repo: string | null;
  lane: string | null;
  tier: string | null;
  status: FleetSessionStatus;
  /** Parsed .rc exit code when present and well-formed. */
  exitCode: number | null;
  /** Attempt start (ms epoch): .dispatched epoch, else .line mtime. */
  startedAtMs: number | null;
  /** Left the running set (ms epoch): .rc/.fin/.reaping mtime for non-active states. */
  endedAtMs: number | null;
  /** .keptlogged present — finished worktree kept for the supervisor. */
  kept: boolean;
}

export interface FleetSessionsView {
  v: 1;
  generatedAt: string;
  runsDirPresent: boolean;
  sourceState: FleetSessionHealth;
  sources: { status: FleetSessionHealth; runs: FleetSessionHealth };
  /** dispatchd.status.v1 fields; null when absent/unparseable. */
  lastTick: string | null;
  paused: boolean | null;
  queueDepth: number | null;
  lanes: FleetSessionLane[];
  sessions: FleetSession[];
  /** True when the bounded scan dropped candidates or capped the output. */
  truncated: boolean;
}

export interface ReadFleetSessionsOptions {
  /** Runs root; default ASHLR_RUNS_DIR ?? ~/.ashlr-runs (fleet convention). */
  runsDir?: string;
  /** Clock for generatedAt/elapsed math; defaults to Date.now. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Bounds + validators (same shapes as runs-dir-state.ts / runs-live-workers.ts)
// ---------------------------------------------------------------------------

const JOB_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const REPO_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TIER_RE = /^[a-z][a-z0-9-]{0,15}$/;
const RC_RE = /^-?\d{1,6}$/;
const EPOCH_RE = /^\d{9,11}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

const LINE_MAX_BYTES = 16 * 1024;
const STATUS_MAX_BYTES = 256 * 1024;
const MARKER_MAX_BYTES = 128;
/** Deep-inspect at most this many .line candidates per read (newest first). */
const SCAN_CAP = 256;
/** Emit at most this many sessions. */
const MAX_SESSIONS = 64;

const validLane = (lane: string): boolean => LANE_ID_RE.test(lane) && !GLOBAL_SLOT_KEYS.has(lane);
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const safeInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const timestamp = (v: unknown): v is string =>
  typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v));
/** A display string is safe only when it survives scrubSecrets unchanged. */
const safeText = (v: unknown, re: RegExp): v is string =>
  typeof v === 'string' && re.test(v) && scrubSecrets(v) === v;

const missing = (e: unknown): boolean => object(e).code === 'ENOENT';

// ---------------------------------------------------------------------------
// Bounded reads — O_NOFOLLOW, size-capped, never follow symlinks
// ---------------------------------------------------------------------------

/** Read a small regular file; null on ENOENT, throws on anything else. */
async function readSmall(path: string, maxBytes: number): Promise<string | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error('invalid source');
    const buf = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buf.length) {
      const r = await file.read(buf, offset, buf.length - offset, offset);
      if (!r.bytesRead) break;
      offset += r.bytesRead;
    }
    return buf.subarray(0, offset).toString('utf8');
  } finally {
    await file.close();
  }
}

interface MarkerInfo {
  exists: boolean;
  mtimeMs: number | null;
}

/** lstat one companion marker; ENOENT → absent, other errors → absent + degraded flag via throw. */
async function marker(path: string): Promise<MarkerInfo> {
  try {
    const s = await lstat(path);
    return { exists: true, mtimeMs: Number.isFinite(s.mtimeMs) ? s.mtimeMs : null };
  } catch (e) {
    if (missing(e)) return { exists: false, mtimeMs: null };
    throw e;
  }
}

/** lstat that tolerates absence (unlike marker(), keeps the Stats for mtime). */
async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// status.json — dispatchd.status.v1 lane/queue summary (bounded, tolerant)
// ---------------------------------------------------------------------------

interface StatusSummary {
  lastTick: string | null;
  paused: boolean | null;
  queueDepth: number | null;
  lanes: FleetSessionLane[];
}

function parseStatusJson(text: string): StatusSummary {
  const out: StatusSummary = {
    lastTick: null, paused: null, queueDepth: null, lanes: [],
  };
  const root = object(JSON.parse(text));
  if (Object.keys(root).length === 0) throw new Error('invalid status');

  if (timestamp(root.last_tick)) out.lastTick = root.last_tick;
  // Same pause semantics as runs-dir-state.pauseState: v1 writes bool|string|null.
  if (typeof root.paused === 'boolean') out.paused = root.paused;
  else if (root.schema === 'dispatchd.status.v1') {
    if (root.paused === null) out.paused = false;
    else if (typeof root.paused === 'string' && root.paused.trim() && root.paused.length <= 500) out.paused = true;
  }
  if (safeInt(root.queue_depth)) out.queueDepth = root.queue_depth;

  const lanes = object(root.lanes);
  for (const [lane, raw] of Object.entries(lanes)) {
    if (!validLane(lane)) continue;
    const l = object(raw);
    if (!safeInt(l.running) || !safeInt(l.target) || !safeInt(l.queued) || typeof l.held !== 'boolean') continue;
    out.lanes.push({ lane, running: l.running, target: l.target, queued: l.queued, held: l.held });
  }
  out.lanes.sort((a, b) => a.lane.localeCompare(b.lane));
  return out;
}

// ---------------------------------------------------------------------------
// queue/run markers — per-job lifecycle
// ---------------------------------------------------------------------------

interface LineFields {
  job: string;
  repo: string | null;
  lane: string | null;
  tier: string | null;
}

/**
 * Parse the .line claim record. Field 4 (prompt path) and any 6th 'pin' field
 * are deliberately dropped — paths and prompt references never leave the
 * module. repo/lane/tier are emitted only when the record's own job id matches
 * the marker-namespace id; a mismatched record is treated as untrusted.
 */
function parseLineRecord(text: string, markerJob: string): LineFields {
  const out: LineFields = { job: markerJob, repo: null, lane: null, tier: null };
  const f = text.replace(/\r?\n$/, '').split('\t');
  if (f.length < 5 || f[0] !== markerJob) return out;
  if (safeText(f[1], REPO_RE)) out.repo = f[1];
  if (safeText(f[2], LANE_ID_RE) && !GLOBAL_SLOT_KEYS.has(f[2]!)) out.lane = f[2];
  if (safeText(f[3], TIER_RE)) out.tier = f[3];
  return out;
}

function parseExitCode(text: string | null): number | null {
  if (text === null) return null;
  const v = text.trim();
  return RC_RE.test(v) ? Number.parseInt(v, 10) : null;
}

/** .dispatched content is `str(int(epoch_seconds))`; bound to a sane window. */
function parseDispatchedEpoch(text: string | null, nowMs: number): number | null {
  if (text === null) return null;
  const v = text.trim();
  if (!EPOCH_RE.test(v)) return null;
  const ms = Number(v) * 1000;
  // 2001-01-01 .. now+5min skew. Anything else is not a dispatch timestamp.
  if (ms < 978307200000 || ms > nowMs + 300_000) return null;
  return ms;
}

const ACTIVE: ReadonlySet<FleetSessionStatus> = new Set(['launching', 'running', 'publishing']);

/** True while a session is still in-flight (no terminal marker observed). */
export function isFleetSessionActive(status: FleetSessionStatus): boolean {
  return ACTIVE.has(status);
}

/** dispatchd GRACE: .dispatched mtime younger than this counts as launching. */
const LAUNCH_GRACE_MS = 120_000;

/**
 * Marker-derived lifecycle state. Attempt-scoped markers (.rc/.timeout/.fin/
 * .reaping/.keptlogged) are only honored when fresh — dispatchd's relaunch
 * path deletes most of them but NOT .fin, and a crash mid-cleanup can leave
 * stragglers; a marker older than the current attempt's claim is stale.
 * '.line'-only claims (launch failed/requeued, awaiting retry) get 'unknown':
 * the record exists but no live or terminal evidence does.
 */
function deriveStatus(m: {
  reaping: boolean; timeout: boolean;
  /** 'absent' | 'unparseable' (present but unreadable/malformed) | exit code. */
  rc: 'absent' | 'unparseable' | number;
  fin: boolean;
  dispatchedPresent: boolean;
  dispatchedAgeMs: number | null;
}): FleetSessionStatus {
  if (m.reaping) return 'publishing';
  if (m.timeout) return 'timeout';
  if (m.rc !== 'absent') {
    if (m.rc === 'unparseable') return 'exited';
    return m.rc === 0 ? 'done' : 'failed';
  }
  if (m.fin) return 'finished';
  if (m.dispatchedPresent) {
    return m.dispatchedAgeMs !== null && m.dispatchedAgeMs < LAUNCH_GRACE_MS ? 'launching' : 'running';
  }
  return 'unknown';
}

interface Candidate {
  job: string;
  lineMtimeMs: number | null;
  dispatchedMtimeMs: number | null;
  rcMtimeMs: number | null;
  finMtimeMs: number | null;
}

async function scanCandidates(runDir: string): Promise<{ list: Candidate[]; truncated: boolean; failed: boolean; present: boolean }> {
  let names: string[];
  try {
    names = await readdir(runDir);
  } catch (e) {
    if (missing(e)) return { list: [], truncated: false, failed: false, present: false };
    return { list: [], truncated: false, failed: true, present: true };
  }
  const jobs = new Set<string>();
  for (const name of names) {
    if (!name.endsWith('.line')) continue;
    const id = name.slice(0, -'.line'.length);
    if (JOB_RE.test(id) && scrubSecrets(id) === id) jobs.add(id);
  }

  const candidates = await Promise.all([...jobs].map(async (job): Promise<Candidate | null> => {
    const base = join(runDir, job);
    try {
      const [line, dispatched, rc, fin] = await Promise.all([
        lstatOrNull(`${base}.line`), lstatOrNull(`${base}.dispatched`),
        lstatOrNull(`${base}.rc`), lstatOrNull(`${base}.fin`),
      ]);
      if (line === null) return null; // .line vanished mid-scan — not an error
      const mt = (s: { mtimeMs: number } | null): number | null =>
        s !== null && Number.isFinite(s.mtimeMs) ? s.mtimeMs : null;
      return {
        job,
        lineMtimeMs: mt(line), dispatchedMtimeMs: mt(dispatched),
        rcMtimeMs: mt(rc), finMtimeMs: mt(fin),
      };
    } catch (e) {
      if (missing(e)) return null; // vanished mid-scan — not an error
      throw e;
    }
  }));

  const list = candidates.filter((c): c is Candidate => c !== null);
  // Rank by most recent lifecycle evidence: claim (.line), finish (.rc/.fin).
  const recency = (c: Candidate): number => Math.max(c.lineMtimeMs ?? 0, c.rcMtimeMs ?? 0, c.finMtimeMs ?? 0);
  list.sort((a, b) => recency(b) - recency(a) || a.job.localeCompare(b.job));
  const truncated = list.length > SCAN_CAP;
  return { list: list.slice(0, SCAN_CAP), truncated, failed: false, present: true };
}

async function readSession(runDir: string, c: Candidate, nowMs: number): Promise<FleetSession> {
  const base = join(runDir, c.job);
  // .line feeds display fields only — a corrupt/oversymlinked record degrades
  // to null fields rather than dropping a session whose markers are healthy.
  const lineText = await readSmall(`${base}.line`, LINE_MAX_BYTES).catch(() => null);
  const [dispatched, rcText, timeout, fin, reaping, keptlogged] = await Promise.all([
    readSmall(`${base}.dispatched`, MARKER_MAX_BYTES).catch(() => null),
    readSmall(`${base}.rc`, MARKER_MAX_BYTES).catch(() => null),
    marker(`${base}.timeout`),
    marker(`${base}.fin`),
    marker(`${base}.reaping`),
    marker(`${base}.keptlogged`),
  ]);
  const fields = lineText === null ? { job: c.job, repo: null, lane: null, tier: null } : parseLineRecord(lineText, c.job);

  // Attempt boundary = the current claim's write time (.dispatched, else
  // .line). Attempt-scoped markers older than it belong to a previous
  // attempt — dispatchd deletes most on relaunch but NOT .fin, and a crash
  // mid-cleanup can strand others. An unreadable mtime can't disprove
  // staleness, so the marker still counts.
  const attemptStartMs = c.dispatchedMtimeMs ?? c.lineMtimeMs;
  const fresh = (info: MarkerInfo): boolean =>
    info.exists && (attemptStartMs === null || info.mtimeMs === null || info.mtimeMs > attemptStartMs);
  const rcPresent = c.rcMtimeMs !== null;
  const rcFresh = rcPresent && (attemptStartMs === null || c.rcMtimeMs === null || c.rcMtimeMs > attemptStartMs);
  const rcCode = rcFresh ? parseExitCode(rcText) : null;
  const rcOutcome: 'absent' | 'unparseable' | number =
    !rcFresh ? 'absent' : rcCode === null ? 'unparseable' : rcCode;

  const dispatchedMs = parseDispatchedEpoch(dispatched, nowMs) ?? c.dispatchedMtimeMs;
  const status = deriveStatus({
    reaping: fresh(reaping), timeout: fresh(timeout),
    rc: rcOutcome, fin: fresh(fin),
    dispatchedPresent: dispatched !== null || c.dispatchedMtimeMs !== null,
    dispatchedAgeMs: dispatchedMs === null ? null : Math.max(0, nowMs - dispatchedMs),
  });
  const startedAtMs = dispatchedMs ?? c.lineMtimeMs;
  // "Ended" ≈ agent exit: earliest terminal-marker mtime (.rc write, else the
  // dispatcher's .fin/.reaping observation). Active states have no end.
  const endedAtMs = isFleetSessionActive(status)
    ? null
    : [rcOutcome !== 'absent' ? c.rcMtimeMs : null, fresh(fin) ? fin.mtimeMs : null, fresh(reaping) ? reaping.mtimeMs : null]
        .filter((v): v is number => v !== null)
        .reduce<number | null>((best, v) => (best === null || v < best ? v : best), null);
  return {
    job: scrubSecrets(fields.job),
    repo: fields.repo, lane: fields.lane, tier: fields.tier,
    status,
    exitCode: typeof rcOutcome === 'number' ? rcOutcome : null,
    startedAtMs,
    endedAtMs,
    kept: fresh(keptlogged),
  };
}

// ---------------------------------------------------------------------------
// Public reader
// ---------------------------------------------------------------------------

export async function readFleetSessions(opts: ReadFleetSessionsOptions = {}): Promise<FleetSessionsView> {
  const root = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const now = (opts.now ?? Date.now)();
  const view: FleetSessionsView = {
    v: 1, generatedAt: new Date(now).toISOString(), runsDirPresent: false,
    sourceState: 'missing',
    sources: { status: 'missing', runs: 'missing' },
    lastTick: null, paused: null, queueDepth: null, lanes: [], sessions: [], truncated: false,
  };

  try {
    if (!(await lstat(root)).isDirectory()) throw new Error('invalid directory');
    view.runsDirPresent = true;
  } catch (e) {
    if (!missing(e)) view.sourceState = 'degraded';
    return view;
  }

  // status.json — independent source; failure degrades only itself.
  try {
    const text = await readSmall(join(root, 'queue/status.json'), STATUS_MAX_BYTES);
    if (text === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    const s = parseStatusJson(text);
    view.lastTick = s.lastTick; view.paused = s.paused; view.queueDepth = s.queueDepth;
    view.lanes = s.lanes;
    view.sources.status = 'healthy';
  } catch (e) {
    view.sources.status = missing(e) ? 'missing' : 'degraded';
  }

  // queue/run markers — independent source. An absent run dir is 'missing'
  // (no marker source at all), an unreadable one is 'degraded'.
  const runDir = join(root, 'queue', 'run');
  let candidates: Candidate[] = [];
  try {
    const scan = await scanCandidates(runDir);
    candidates = scan.list;
    view.truncated = scan.truncated;
    view.sources.runs = !scan.present ? 'missing' : scan.failed ? 'degraded' : 'healthy';
  } catch {
    view.sources.runs = 'degraded';
  }

  const sessions = await Promise.all(candidates.map((c) => readSession(runDir, c, now).catch(() => null)));
  const rows = sessions.filter((s): s is FleetSession => s !== null);
  if (rows.length !== sessions.length) view.sources.runs = 'degraded';

  // Active work first (oldest attempt first — surfaces stuck sessions), then
  // finished work most-recently-ended first. Bounded output.
  const ended = (s: FleetSession): number => s.endedAtMs ?? 0;
  const started = (s: FleetSession): number => s.startedAtMs ?? Number.MAX_SAFE_INTEGER;
  rows.sort((a, b) => {
    const aa = ACTIVE.has(a.status) ? 0 : 1;
    const bb = ACTIVE.has(b.status) ? 0 : 1;
    if (aa !== bb) return aa - bb;
    if (aa === 0) return started(a) - started(b) || a.job.localeCompare(b.job);
    return ended(b) - ended(a) || a.job.localeCompare(b.job);
  });
  view.sessions = rows.slice(0, MAX_SESSIONS);
  if (rows.length > MAX_SESSIONS) view.truncated = true;

  const bothHealthy = view.sources.status === 'healthy' && view.sources.runs === 'healthy';
  const bothMissing = view.sources.status === 'missing' && view.sources.runs === 'missing';
  view.sourceState = bothHealthy ? 'healthy' : bothMissing ? 'missing' : 'degraded';
  return view;
}
