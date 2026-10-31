/**
 * core/fleet/runs-history.ts — durable, bounded JSONL history of fleet-runs
 * samples: what the lanes actually held over time, not just this instant.
 *
 * The browser keeps a ring buffer that dies on reload; this file is the
 * server-side answer. One sample per line, appended by `sampleIfDue` — which
 * runs ON READ (at most one sample per `minIntervalMs`, default 60 s) — so the
 * series is honest about gaps: it covers the time something was watching,
 * never backfilled.
 *
 * File: `$ASHLR_HOME/fleet/runs-history.jsonl` (default `~/.ashlr/fleet/`),
 * NEVER inside the runs directory. `ASHLR_RUNS_HISTORY_FILE` overrides with an
 * absolute path; a relative or empty value is ignored.
 *
 * Bounds: appends trigger a compaction once the file exceeds 2 MiB, rewriting
 * it to keep only lines provably newer than 7 days (one read pass, one write).
 * Reads are capped at 4 MiB (larger files serve the newest 2 MiB, marked
 * degraded). Every line is shape-validated on the way out; malformed lines
 * are skipped and counted in `dropped`.
 *
 * Privacy: samples hold COUNTS ONLY — lane names, running/target/queued,
 * held, workers, leaders, paused. No job ids, prompts, log text or paths.
 */
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { readFleetRunsDirState, type FleetRunsDirState } from './runs-dir-state.js';
import { listLiveWorkers, type LiveWorkersSnapshot } from './runs-live-workers.js';

export interface RunsSampleLane {
  lane: string;
  running: number;
  target: number;
  queued: number;
  held: boolean;
}

export interface RunsSample {
  at: string;
  lanes: RunsSampleLane[];
  workers: number | null;
  leaders: number | null;
  paused: boolean | null;
}

export interface RunsHistory {
  v: 1;
  generatedAt: string;
  from: string;
  to: string;
  sourceState: 'healthy' | 'missing' | 'degraded';
  /** Lines skipped because they did not parse as a RunsSample. */
  dropped: number;
  samples: RunsSample[];
}

/** Rewrite the file once it grows past this, keeping the retention window. */
export const RUNS_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
/** Compaction keeps only lines whose `at` is newer than this. */
export const RUNS_HISTORY_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
/** readRunsHistory never holds more than this much of the file in memory. */
const READ_MAX_BYTES = 4 * 1024 * 1024;
/** When the file exceeds READ_MAX_BYTES, serve the newest tail this large. */
const READ_TAIL_BYTES = 2 * 1024 * 1024;
/** sampleIfDue finds the last line inside this tail; one sample line is ~300 B. */
const LAST_LINE_TAIL_BYTES = 16 * 1024;
const HOUR_MS = 60 * 60 * 1000;
export const RUNS_HISTORY_DEFAULT_HOURS = 24;
export const RUNS_HISTORY_MIN_HOURS = 1;
export const RUNS_HISTORY_MAX_HOURS = 168;
/** Defensive shape bounds: lane sets are small and lane names are identifiers. */
const MAX_LANES = 64;
const MAX_LANE_CHARS = 80;
const MAX_AT_CHARS = 64;

// ---------------------------------------------------------------------------
// File location
// ---------------------------------------------------------------------------

function ashlrHome(): string {
  const configured = process.env['ASHLR_HOME'];
  return typeof configured === 'string' && configured.trim() !== '' && isAbsolute(configured)
    ? configured
    : join(homedir(), '.ashlr');
}

/** History path: `$ASHLR_HOME/fleet/runs-history.jsonl` unless ASHLR_RUNS_HISTORY_FILE (absolute only) overrides. */
export function runsHistoryFile(): string {
  const override = process.env['ASHLR_RUNS_HISTORY_FILE'];
  if (typeof override === 'string' && override !== '' && isAbsolute(override)) return override;
  return join(ashlrHome(), 'fleet', 'runs-history.jsonl');
}

// ---------------------------------------------------------------------------
// Shape validation (line → RunsSample; unknown keys are projected away)
// ---------------------------------------------------------------------------

const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number | null =>
  v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);

function parseRunsSample(value: unknown): RunsSample | null {
  if (!record(value)) return null;
  const at = value['at'];
  if (typeof at !== 'string' || at.length > MAX_AT_CHARS || !Number.isFinite(Date.parse(at))) return null;
  const lanes = value['lanes'];
  if (!Array.isArray(lanes) || lanes.length > MAX_LANES) return null;
  const clean: RunsSampleLane[] = [];
  for (const raw of lanes) {
    if (!record(raw)) return null;
    const { lane, running, target, queued, held } = raw;
    if (typeof lane !== 'string' || lane.length === 0 || lane.length > MAX_LANE_CHARS ||
        typeof running !== 'number' || !Number.isSafeInteger(running) || running < 0 ||
        typeof target !== 'number' || !Number.isSafeInteger(target) || target < 0 ||
        typeof queued !== 'number' || !Number.isSafeInteger(queued) || queued < 0 ||
        typeof held !== 'boolean') return null;
    clean.push({ lane, running, target, queued, held });
  }
  const { workers, leaders, paused } = value;
  if (!count(workers) || !count(leaders) || !(paused === null || typeof paused === 'boolean')) return null;
  return { at, lanes: clean, workers, leaders, paused };
}

/** The `at` timestamp a raw line claims, or null when it cannot prove one. */
function lineAtMs(line: string): number | null {
  let row: unknown;
  try { row = JSON.parse(line); } catch { return null; }
  const at = record(row) ? row['at'] : null;
  const ms = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

function toIso(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(0).toISOString();
}

const missing = (e: unknown): boolean => record(e) && e['code'] === 'ENOENT';

// ---------------------------------------------------------------------------
// Append (+ size-triggered compaction)
// ---------------------------------------------------------------------------

export interface AppendRunsSampleOptions { file?: string; now?: () => number }

/**
 * Append one sample as a single JSON line. When the file then exceeds
 * RUNS_HISTORY_MAX_BYTES it is rewritten keeping only lines whose `at` is
 * newer than RUNS_HISTORY_RETAIN_MS — one read pass, one write (temp + rename
 * so a crash never leaves half a file).
 */
export async function appendRunsSample(sample: RunsSample, opts: AppendRunsSampleOptions = {}): Promise<void> {
  const file = opts.file ?? runsHistoryFile();
  const now = opts.now ?? Date.now;
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(file, 'a+');
  try {
    const { size } = await handle.stat();
    const lastByte = Buffer.alloc(1);
    const { bytesRead } = size > 0 ? await handle.read(lastByte, 0, 1, size - 1) : { bytesRead: 0 };
    const separator = bytesRead > 0 && lastByte[0] !== 0x0a ? '\n' : '';
    await handle.writeFile(`${separator}${JSON.stringify(sample)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  const info = await stat(file);
  if (info.size <= RUNS_HISTORY_MAX_BYTES) return;
  const cutoff = now() - RUNS_HISTORY_RETAIN_MS;
  const text = await readFile(file, 'utf8');
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const at = lineAtMs(line);
    if (at !== null && at >= cutoff) kept.push(line);
  }
  const tmp = `${file}.tmp`;
  await writeFile(tmp, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
  await rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface ReadRunsHistoryOptions { file?: string; hours?: number; now?: () => number }

/**
 * The series for charts and agents: samples with `at` inside the last `hours`
 * hours (clamped 1..168, default 24), in append order. A missing file is
 * `sourceState: 'missing'`; malformed lines are skipped and counted in
 * `dropped` (which also flips the state to 'degraded').
 */
export async function readRunsHistory(opts: ReadRunsHistoryOptions = {}): Promise<RunsHistory> {
  const file = opts.file ?? runsHistoryFile();
  const now = (opts.now ?? Date.now)();
  const requested = opts.hours ?? RUNS_HISTORY_DEFAULT_HOURS;
  const hours = Number.isFinite(requested)
    ? Math.min(RUNS_HISTORY_MAX_HOURS, Math.max(RUNS_HISTORY_MIN_HOURS, Math.floor(requested)))
    : RUNS_HISTORY_DEFAULT_HOURS;
  const fromMs = now - hours * HOUR_MS;
  const history: RunsHistory = {
    v: 1, generatedAt: toIso(now), from: toIso(fromMs), to: toIso(now),
    sourceState: 'healthy', dropped: 0, samples: [],
  };

  let text: string;
  try {
    const info = await stat(file);
    if (!info.isFile()) { history.sourceState = 'degraded'; return history; }
    if (info.size <= READ_MAX_BYTES) {
      text = await readFile(file, 'utf8');
    } else {
      // The appender bounds this file, so oversized means external growth:
      // serve only the newest tail rather than slurping it.
      const handle = await open(file, 'r');
      try {
        const size = Math.min(info.size, READ_TAIL_BYTES);
        const buf = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buf, 0, size, info.size - size);
        const tail = buf.subarray(0, bytesRead).toString('utf8');
        text = tail.slice(tail.indexOf('\n') < 0 ? tail.length : tail.indexOf('\n') + 1);
      } finally { await handle.close(); }
      history.sourceState = 'degraded';
    }
  } catch (e) {
    history.sourceState = missing(e) ? 'missing' : 'degraded';
    return history;
  }

  for (const line of text.split('\n')) {
    if (!line) continue;
    let row: unknown;
    try { row = JSON.parse(line); } catch { history.dropped++; continue; }
    const sample = parseRunsSample(row);
    if (sample === null) { history.dropped++; continue; }
    if (Date.parse(sample.at) < fromMs) continue;
    history.samples.push(sample);
  }
  if (history.dropped > 0) history.sourceState = 'degraded';
  return history;
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

export interface CollectRunsSampleOptions {
  now?: () => number;
  readRunsDir?: () => Promise<FleetRunsDirState>;
  listWorkers?: () => Promise<LiveWorkersSnapshot>;
}

/**
 * One sample from the two live sources, each failing INDEPENDENTLY: a
 * throwing runs-dir read yields `lanes: []` + `paused: null`; a throwing (or
 * self-reporting 'unavailable') process read yields `workers`/`leaders` null
 * rather than a dishonest 0. Never throws.
 */
export async function collectRunsSample(opts: CollectRunsSampleOptions = {}): Promise<RunsSample> {
  const now = opts.now ?? Date.now;
  const readRunsDir = opts.readRunsDir ?? (() => readFleetRunsDirState({ now }));
  const listWorkers = opts.listWorkers ?? (() => listLiveWorkers({ now }));
  const [dir, live] = await Promise.all([
    readRunsDir().catch(() => null),
    listWorkers().catch(() => null),
  ]);
  return {
    at: toIso(now()),
    lanes: dir === null ? [] : dir.lanes.map((l) => ({
      lane: l.lane, running: l.running, target: l.target, queued: l.queued, held: l.held,
    })),
    paused: dir === null ? null : dir.paused,
    workers: live !== null && live.sourceState === 'healthy' ? live.workers.length : null,
    leaders: live !== null && live.sourceState === 'healthy' ? live.leaders.length : null,
  };
}

/** `at` of the last line in the file, from a small tail read; null when absent or unparseable. */
async function lastSampleAtMs(file: string): Promise<number | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0) return null;
    const size = Math.min(info.size, LAST_LINE_TAIL_BYTES);
    const buf = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buf, 0, size, info.size - size);
    const last = buf.subarray(0, bytesRead).toString('utf8').split('\n').filter(Boolean).pop();
    return last === undefined ? null : lineAtMs(last);
  } catch {
    return null;
  } finally {
    try { await handle?.close(); } catch { /* best-effort */ }
  }
}

export interface SampleIfDueOptions {
  file?: string;
  now?: () => number;
  minIntervalMs?: number;
  /** Takes the sample when due; defaults to collectRunsSample. */
  read?: (now: () => number) => Promise<RunsSample>;
}

/**
 * Sample on read, at most once per `minIntervalMs` (default 60 s): reads the
 * last line's `at` and, when it is older than the interval (or absent —
 * missing file, empty, unparseable), takes a sample through `read()` and
 * appends it. Returns whether it sampled. An unreadable file counts as absent
 * so a wedged history never stalls the sampler; append errors still throw.
 */
export async function sampleIfDue(opts: SampleIfDueOptions = {}): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const read = opts.read ?? ((clock: () => number) => collectRunsSample({ now: clock }));
  const file = opts.file ?? runsHistoryFile();
  const last = await lastSampleAtMs(file);
  if (last !== null && now() - last < (opts.minIntervalMs ?? 60_000)) return false;
  await appendRunsSample(await read(now), { file, now });
  return true;
}
