/**
 * The shared pid-reuse proof used by the daemon lock and the resident daemon
 * state: a recorded pid is "reused" only when its owner's heartbeat has been
 * silent long enough AND the process now holding the pid provably started
 * after the owner recorded it. Every unprovable input fails closed.
 */
import { describe, expect, it } from 'vitest';

import type { DaemonActivityReadResult } from '../src/core/daemon/activity.js';
import {
  PID_REUSE_MIN_SILENCE_MS,
  PID_REUSE_SLACK_MS,
  RESIDENT_PID_REUSE_STALE_MS,
  pidProvablyReusedSince,
  residentPidProvablyReused,
} from '../src/core/daemon/pid-reuse-proof.js';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const ACQUIRED = Date.parse('2026-10-14T00:00:00.000Z');
const startedRecently = () => NOW - 30_000;

const missingActivity: DaemonActivityReadResult = {
  sourceState: 'missing', freshness: 'unknown', ownerState: 'unknown', activity: null, phaseStartedAt: null, ageMs: null,
};

describe('pidProvablyReusedSince', () => {
  const base = { pid: 4242, acquiredAtMs: ACQUIRED, heartbeatAtMs: ACQUIRED, staleMs: 0, nowMs: NOW, startedAtMs: startedRecently };

  it('proves reuse when silent and the current process started after acquisition', () => {
    expect(pidProvablyReusedSince(base)).toBe(true);
  });

  it('refuses while the heartbeat is within max(staleMs, floor)', () => {
    expect(pidProvablyReusedSince({ ...base, heartbeatAtMs: NOW - PID_REUSE_MIN_SILENCE_MS + 1 })).toBe(false);
    expect(pidProvablyReusedSince({ ...base, heartbeatAtMs: NOW - 5 * 60_000, staleMs: 10 * 60_000 })).toBe(false);
  });

  it('refuses when the process may be the owner (started before acquisition + slack)', () => {
    expect(pidProvablyReusedSince({ ...base, startedAtMs: () => ACQUIRED + PID_REUSE_SLACK_MS })).toBe(false);
    expect(pidProvablyReusedSince({ ...base, startedAtMs: () => ACQUIRED - 1 })).toBe(false);
  });

  it('refuses when ps cannot prove a start time or timestamps are unparsable', () => {
    expect(pidProvablyReusedSince({ ...base, startedAtMs: () => null })).toBe(false);
    expect(pidProvablyReusedSince({ ...base, acquiredAtMs: Number.NaN })).toBe(false);
    expect(pidProvablyReusedSince({ ...base, heartbeatAtMs: Number.NaN })).toBe(false);
    expect(pidProvablyReusedSince({ ...base, pid: 0 })).toBe(false);
  });
});

describe('residentPidProvablyReused', () => {
  const state = { pid: 4242, startedAt: '2026-10-14T00:00:00.000Z', lastTickAt: '2026-10-14T01:00:00.000Z' };
  const opts = { nowMs: NOW, startedAtMs: startedRecently };

  it('proves reuse for a long-silent resident whose pid now names a newer process', () => {
    expect(residentPidProvablyReused(state, missingActivity, opts)).toBe(true);
  });

  it('uses the latest heartbeat: a recent tick or activity row blocks the proof', () => {
    const recent = new Date(NOW - RESIDENT_PID_REUSE_STALE_MS + 1_000).toISOString();
    expect(residentPidProvablyReused({ ...state, lastTickAt: recent }, missingActivity, opts)).toBe(false);
    const activity: DaemonActivityReadResult = {
      ...missingActivity,
      sourceState: 'healthy',
      activity: {
        schemaVersion: 1, observedAt: recent, authority: 'none', instanceId: 'x', pid: 4242,
        processStartRef: null, daemonStartedAt: state.startedAt, phase: 'idle', activeChildren: 0,
      },
    };
    expect(residentPidProvablyReused(state, activity, opts)).toBe(false);
  });

  it('fails closed on a degraded activity journal, missing pid or unparsable timestamps', () => {
    expect(residentPidProvablyReused(state, { ...missingActivity, sourceState: 'degraded' }, opts)).toBe(false);
    expect(residentPidProvablyReused({ ...state, pid: null }, missingActivity, opts)).toBe(false);
    expect(residentPidProvablyReused({ ...state, startedAt: null }, missingActivity, opts)).toBe(false);
    expect(residentPidProvablyReused({ ...state, lastTickAt: 'garbage' }, missingActivity, opts)).toBe(false);
  });
});
