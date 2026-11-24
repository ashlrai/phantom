/**
 * Tick-loop beacon and watchdog: is the resident loop still scheduling ticks?
 *
 * Why this exists (owner's Mac, 3.30.24): after a run of timed-out ticks the
 * resident stopped ticking for ~5.6 h while the process stayed alive —
 * liveness `alive` (the lock heartbeat runs on its own timer), tickInProgress
 * null — until authority was re-granted. Nothing said the loop had stopped.
 *
 * The loop writes a small beacon every time it moves: when a tick starts, when
 * post-tick work starts, and before every park with the time it expects to
 * wake. `assessTickLoop` turns that into an explicit state:
 *   - `ticking`  — the loop is running a tick or is between ticks on schedule;
 *   - `parked`   — the loop is deliberately parked (pause, withdrawn authority,
 *                  budget day) and says why;
 *   - `stalled`  — the process is alive but the loop has not moved for more
 *                  than TICK_LOOP_STALL_INTERVALS intervals past when it said
 *                  it would;
 *   - `unknown`  — no beacon from this daemon (an older build, or unreadable).
 *
 * The in-process watchdog checks the same assessment on its own unref'd timer.
 * On a stall it first wakes the loop (aborting its park sleep), and if the loop
 * still has not moved one threshold later it requests a supervised restart
 * (orderly shutdown; launchd's KeepAlive starts a fresh resident).
 *
 * OBSERVATIONAL for readers: nothing outside the watchdog gates on the beacon.
 * Writes are best-effort and never throw.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** The loop counts as stopped after this many intervals without moving past its expected wake. */
export const TICK_LOOP_STALL_INTERVALS = 3;
/** Floor for the interval used in the stall threshold (continuous mode idles for seconds). */
export const TICK_LOOP_MIN_INTERVAL_MS = 60_000;
/** How often the in-process watchdog checks the loop. */
export const TICK_LOOP_WATCHDOG_EVERY_MS = 60_000;

export type TickLoopStage = 'tick' | 'post-tick' | 'park';
export type TickLoopState = 'ticking' | 'parked' | 'stalled' | 'unknown';

export interface TickLoopBeaconV1 {
  v: 1;
  pid: number;
  /** When the loop last moved. */
  at: string;
  stage: TickLoopStage;
  /** Why the loop is parked (`interval`, `paused`, `authority-withdrawn`, …) or null. */
  reason: string | null;
  /** When the loop expects to move again (tick deadline, park wake). */
  expectedBy: string;
  /** The configured tick interval the stall threshold is scaled by. */
  intervalMs: number;
  /** Ticks started by this process. */
  ticks: number;
  /** Watchdog recoveries this process has performed. */
  recoveries: number;
}

export interface TickLoopAssessment {
  state: TickLoopState;
  stage: TickLoopStage | null;
  reason: string | null;
  /** Time since the loop last moved. */
  beaconAgeMs: number | null;
  /** How far past its expected wake the loop is (0 when on schedule). */
  overdueMs: number | null;
  /** Overdue beyond this is `stalled`. */
  thresholdMs: number | null;
  recoveries: number;
  /** One specific sentence. */
  summary: string;
}

function storageRoot(): string {
  const configured = process.env['ASHLR_HOME'];
  if (typeof configured === 'string' && configured.length > 0 && isAbsolute(configured) && resolve(configured) === configured) {
    return configured;
  }
  return join(homedir(), '.ashlr');
}

export function tickLoopBeaconPath(): string {
  return join(storageRoot(), 'daemon-tick-loop.json');
}

export function writeTickLoopBeacon(beacon: TickLoopBeaconV1): void {
  const root = storageRoot();
  const temporary = join(root, `.daemon-tick-loop.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(beacon)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, tickLoopBeaconPath());
  } catch {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

const isIso = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));

export function readTickLoopBeacon(): TickLoopBeaconV1 | null {
  try {
    const parsed = JSON.parse(readFileSync(tickLoopBeaconPath(), 'utf8')) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) return null;
    const stage = parsed.stage;
    if (typeof parsed.pid !== 'number' || !isIso(parsed.at) || !isIso(parsed.expectedBy)) return null;
    if (stage !== 'tick' && stage !== 'post-tick' && stage !== 'park') return null;
    return {
      v: 1,
      pid: parsed.pid,
      at: parsed.at,
      stage,
      reason: typeof parsed.reason === 'string' ? parsed.reason : null,
      expectedBy: parsed.expectedBy,
      intervalMs: typeof parsed.intervalMs === 'number' && parsed.intervalMs > 0 ? parsed.intervalMs : TICK_LOOP_MIN_INTERVAL_MS,
      ticks: typeof parsed.ticks === 'number' ? parsed.ticks : 0,
      recoveries: typeof parsed.recoveries === 'number' ? parsed.recoveries : 0,
    };
  } catch {
    return null;
  }
}

export function tickLoopStallThresholdMs(intervalMs: number, intervals = TICK_LOOP_STALL_INTERVALS): number {
  return Math.max(1, intervals) * Math.max(TICK_LOOP_MIN_INTERVAL_MS, intervalMs);
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
}

/** Pure: what state is the loop that wrote `beacon` in at `nowMs`? */
export function assessTickLoop(input: {
  beacon: TickLoopBeaconV1 | null;
  nowMs: number;
  /** The proven daemon pid; a beacon from another pid is a previous daemon's. */
  expectPid?: number | null;
  intervals?: number;
}): TickLoopAssessment {
  const { beacon, nowMs } = input;
  if (!beacon || (input.expectPid != null && beacon.pid !== input.expectPid)) {
    return {
      state: 'unknown', stage: null, reason: null, beaconAgeMs: null, overdueMs: null, thresholdMs: null, recoveries: 0,
      summary: 'No tick-loop beacon from this daemon, so whether its loop is moving cannot be said.',
    };
  }
  const beaconAgeMs = Math.max(0, nowMs - Date.parse(beacon.at));
  const overdueMs = Math.max(0, nowMs - Date.parse(beacon.expectedBy));
  const thresholdMs = tickLoopStallThresholdMs(beacon.intervalMs, input.intervals);
  const base = { stage: beacon.stage, reason: beacon.reason, beaconAgeMs, overdueMs, thresholdMs, recoveries: beacon.recoveries };
  if (overdueMs > thresholdMs) {
    return {
      ...base,
      state: 'stalled',
      summary: `The tick loop has STOPPED: it last moved ${minutes(beaconAgeMs)} ago (${beacon.stage}`
        + `${beacon.reason ? `: ${beacon.reason}` : ''}) and is ${minutes(overdueMs)} past when it expected to move again, `
        + `beyond ${TICK_LOOP_STALL_INTERVALS} intervals (${minutes(thresholdMs)}).`,
    };
  }
  if (beacon.stage === 'park' && beacon.reason !== null && beacon.reason !== 'interval') {
    return { ...base, state: 'parked', summary: `The tick loop is parked (${beacon.reason}).` };
  }
  return {
    ...base,
    state: 'ticking',
    summary: beacon.stage === 'park'
      ? 'The tick loop is between ticks on schedule.'
      : `The tick loop is in ${beacon.stage === 'tick' ? 'a tick' : 'post-tick work'}.`,
  };
}

export interface TickLoopWatchdogOptions {
  /** The beacon this process last wrote (in memory; no file read). */
  current: () => TickLoopBeaconV1 | null;
  /** First recovery step: wake the loop out of its park. */
  wake: (assessment: TickLoopAssessment) => void;
  /** Escalation when a wake did not get the loop moving: an orderly, supervised restart. */
  restart: (assessment: TickLoopAssessment) => void;
  now?: () => number;
  everyMs?: number;
  intervals?: number;
}

export interface TickLoopWatchdog {
  /** Run one check now (the timer calls this). */
  check(): TickLoopAssessment;
  stop(): void;
}

/**
 * Self-recovery for a stopped loop. Each stall episode (keyed by the beacon's
 * `at`) gets one wake; if the beacon has not moved one threshold after the
 * wake, one restart request. A beacon that moves ends the episode.
 */
export function startTickLoopWatchdog(opts: TickLoopWatchdogOptions): TickLoopWatchdog {
  const now = opts.now ?? Date.now;
  let wokeFor: { at: string; atMs: number } | null = null;
  let restartedFor: string | null = null;
  const check = (): TickLoopAssessment => {
    const beacon = opts.current();
    const nowMs = now();
    const assessment = assessTickLoop({ beacon, nowMs, ...(opts.intervals ? { intervals: opts.intervals } : {}) });
    if (assessment.state !== 'stalled' || !beacon) {
      wokeFor = null;
      return assessment;
    }
    if (wokeFor === null || wokeFor.at !== beacon.at) {
      wokeFor = { at: beacon.at, atMs: nowMs };
      try { opts.wake(assessment); } catch { /* recovery must not throw into a timer */ }
      return assessment;
    }
    if (restartedFor !== beacon.at && nowMs - wokeFor.atMs > (assessment.thresholdMs ?? 0)) {
      restartedFor = beacon.at;
      try { opts.restart(assessment); } catch { /* best effort */ }
    }
    return assessment;
  };
  const timer = setInterval(check, opts.everyMs ?? TICK_LOOP_WATCHDOG_EVERY_MS);
  timer.unref?.();
  return { check, stop: () => clearInterval(timer) };
}
