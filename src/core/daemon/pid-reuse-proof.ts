/**
 * Proof that a live pid is NOT the daemon that recorded it (pid reuse).
 *
 * After a crash or reboot the pid a daemon recorded (in daemon.lock or the
 * resident daemon state) can name an unrelated live process, possibly one
 * owned by another user so `process.kill(pid, 0)` fails with EPERM instead of
 * ESRCH. Treating such a pid as alive blocks every restart forever.
 *
 * The pid is proven reused only when BOTH hold:
 *  1. the recorded owner's heartbeat has been silent for at least
 *     max(staleMs, PID_REUSE_MIN_SILENCE_MS) (a live owner keeps refreshing it);
 *  2. `/bin/ps -o etime=` proves the process now holding the pid started more
 *     than PID_REUSE_SLACK_MS after the owner recorded it, so it cannot be
 *     the owner.
 * Anything unprovable (no ps, unparsable timestamps, recent heartbeat) is NOT
 * a proof; callers stay fail-closed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { DaemonState } from '../types.js';
import type { DaemonActivityReadResult } from './activity.js';

/** Pids that started this far (ms) after the owner recorded them are not the owner; covers ps's 1 s granularity and clock jitter. */
export const PID_REUSE_SLACK_MS = 60_000;
/** Floor on heartbeat silence: three missed 30 s heartbeats. */
export const PID_REUSE_MIN_SILENCE_MS = 3 * 30_000;
/** Default silence for the resident daemon state, matching the daemon lock's default stale window. */
export const RESIDENT_PID_REUSE_STALE_MS = 10 * 60_000;

export type ProcessStartedAtMs = (pid: number, nowMs: number) => number | null;

/** Epoch ms `pid` started, from `ps -o etime=` ([[dd-]hh:]mm:ss); null when unprovable. */
export function processStartedAtMs(pid: number, nowMs: number): number | null {
  if (process.platform === 'win32' || !existsSync('/bin/ps')) return null;
  try {
    const result = spawnSync('/bin/ps', ['-o', 'etime=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 1_024, shell: false, env: { ...process.env, LC_ALL: 'C' },
    });
    const match = result.status === 0 ? /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(result.stdout ?? '') : null;
    if (!match) return null;
    const [days, hours, minutes, seconds] = [match[1], match[2], match[3], match[4]].map((v) => Number(v ?? 0));
    return nowMs - ((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000);
  } catch {
    return null;
  }
}

/**
 * True only when the two-condition proof holds for `pid`: heartbeat silent for
 * max(staleMs, PID_REUSE_MIN_SILENCE_MS) AND the pid's current process started
 * more than PID_REUSE_SLACK_MS after `acquiredAtMs`.
 */
export function pidProvablyReusedSince(input: {
  pid: number;
  acquiredAtMs: number;
  heartbeatAtMs: number;
  staleMs: number;
  nowMs?: number;
  startedAtMs?: ProcessStartedAtMs;
}): boolean {
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) return false;
  if (!Number.isFinite(input.heartbeatAtMs) || !Number.isFinite(input.acquiredAtMs)) return false;
  if (nowMs - input.heartbeatAtMs < Math.max(input.staleMs, PID_REUSE_MIN_SILENCE_MS)) return false;
  const startedMs = (input.startedAtMs ?? processStartedAtMs)(input.pid, nowMs);
  return startedMs !== null && Number.isFinite(startedMs) && startedMs > input.acquiredAtMs + PID_REUSE_SLACK_MS;
}

/**
 * Resident daemon state flavor of the proof, for a recorded pid that exists
 * but cannot be signalled (EPERM). "Acquired" is the recorded `startedAt`;
 * the heartbeat is the latest of `startedAt`, `lastTickAt` and the activity
 * journal's latest row for that same daemon pid. A degraded activity journal
 * cannot prove silence, so it is not a proof.
 */
export function residentPidProvablyReused(
  state: Pick<DaemonState, 'pid' | 'startedAt' | 'lastTickAt'>,
  activity: DaemonActivityReadResult,
  opts: { staleMs?: number; nowMs?: number; startedAtMs?: ProcessStartedAtMs } = {},
): boolean {
  if (typeof state.pid !== 'number' || typeof state.startedAt !== 'string') return false;
  if (activity.sourceState === 'degraded') return false;
  const acquiredAtMs = Date.parse(state.startedAt);
  const beats = [acquiredAtMs];
  if (state.lastTickAt !== null) beats.push(Date.parse(state.lastTickAt));
  if (activity.activity && activity.activity.pid === state.pid) beats.push(Date.parse(activity.activity.observedAt));
  if (beats.some((ms) => !Number.isFinite(ms))) return false;
  return pidProvablyReusedSince({
    pid: state.pid,
    acquiredAtMs,
    heartbeatAtMs: Math.max(...beats),
    staleMs: opts.staleMs ?? RESIDENT_PID_REUSE_STALE_MS,
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
    ...(opts.startedAtMs ? { startedAtMs: opts.startedAtMs } : {}),
  });
}
