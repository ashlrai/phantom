/**
 * The resident's tick loop can stop while the process stays alive (owner's
 * Mac: ~5.6 h without a tick, liveness `alive`, tickInProgress null). The loop
 * beacon makes that an explicit state — `tickLoop.state: 'stalled'` — and the
 * in-process watchdog wakes the loop, then requests a supervised restart.
 * HOME is isolated per worker (test/setup/home.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { probeDaemonLiveness, resetDaemonLivenessCache } from '../src/core/daemon/liveness.js';
import { daemonLockPath } from '../src/core/daemon/state.js';
import {
  assessTickLoop,
  readTickLoopBeacon,
  startTickLoopWatchdog,
  tickLoopStallThresholdMs,
  writeTickLoopBeacon,
  TICK_LOOP_STALL_INTERVALS,
  type TickLoopBeaconV1,
} from '../src/core/daemon/tick-loop.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const INTERVAL_MS = 5 * 60_000;
const PID = 4242;

function beacon(over: Partial<TickLoopBeaconV1> = {}): TickLoopBeaconV1 {
  const at = over.at ?? new Date(NOW - 60_000).toISOString();
  return {
    v: 1, pid: PID, at, stage: 'park', reason: 'interval',
    expectedBy: new Date(Date.parse(at) + INTERVAL_MS).toISOString(),
    intervalMs: INTERVAL_MS, ticks: 12, recoveries: 0, ...over,
  };
}

function writeLock(pid: number, heartbeatAt: string): void {
  const path = daemonLockPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ pid, token: 't'.repeat(32), hostname: 'test', acquiredAt: heartbeatAt, heartbeatAt }), { mode: 0o600 });
}

beforeEach(() => {
  resetDaemonLivenessCache();
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
});
afterEach(() => {
  resetDaemonLivenessCache();
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
});

describe('assessTickLoop', () => {
  it('a loop between ticks on schedule is ticking', () => {
    expect(assessTickLoop({ beacon: beacon(), nowMs: NOW }).state).toBe('ticking');
  });

  it(`no move for > ${TICK_LOOP_STALL_INTERVALS} intervals past the expected wake is stalled`, () => {
    const threshold = tickLoopStallThresholdMs(INTERVAL_MS);
    expect(threshold).toBe(TICK_LOOP_STALL_INTERVALS * INTERVAL_MS);
    const at = new Date(NOW - INTERVAL_MS - threshold - 1_000).toISOString();
    const verdict = assessTickLoop({ beacon: beacon({ at }), nowMs: NOW });
    expect(verdict.state).toBe('stalled');
    expect(verdict.summary).toMatch(/tick loop has STOPPED/);
    // Just inside the threshold is still on schedule.
    const inside = new Date(NOW - INTERVAL_MS - threshold + 1_000).toISOString();
    expect(assessTickLoop({ beacon: beacon({ at: inside }), nowMs: NOW }).state).toBe('ticking');
  });

  it('a tick is allowed its own deadline before the loop counts as stalled', () => {
    const at = new Date(NOW - 50 * 60_000).toISOString();
    const inTick = beacon({ at, stage: 'tick', reason: null, expectedBy: new Date(Date.parse(at) + 61 * 60_000).toISOString() });
    expect(assessTickLoop({ beacon: inTick, nowMs: NOW }).state).toBe('ticking');
  });

  it('a deliberate park says why instead of looking healthy or stalled', () => {
    const verdict = assessTickLoop({
      beacon: beacon({ reason: 'authority-withdrawn: grant expired', expectedBy: new Date(NOW - 1_000).toISOString() }),
      nowMs: NOW,
    });
    expect(verdict.state).toBe('parked');
    expect(verdict.summary).toMatch(/authority-withdrawn/);
  });

  it("another pid's beacon (a previous daemon) is unknown, never ticking", () => {
    expect(assessTickLoop({ beacon: beacon(), nowMs: NOW, expectPid: PID + 1 }).state).toBe('unknown');
    expect(assessTickLoop({ beacon: null, nowMs: NOW }).state).toBe('unknown');
  });
});

describe('liveness surfaces a stopped tick loop', () => {
  it('a live daemon (fresh heartbeat) whose loop stopped 5.6 h ago reports tickLoop stalled', () => {
    writeLock(PID, new Date(NOW - 10_000).toISOString());
    const stoppedAt = new Date(NOW - 5.6 * 3_600_000).toISOString();
    writeTickLoopBeacon(beacon({ at: stoppedAt, expectedBy: new Date(Date.parse(stoppedAt) + INTERVAL_MS).toISOString() }));
    expect(readTickLoopBeacon()?.pid).toBe(PID);
    const verdict = probeDaemonLiveness({ nowMs: NOW, pidProbe: () => 'alive' });
    expect(verdict.state).toBe('alive');
    expect(verdict.tickLoop?.state).toBe('stalled');
    expect(verdict.reason).toMatch(/tick loop has STOPPED/);
  });

  it('a live daemon whose loop is moving reports tickLoop ticking', () => {
    writeLock(PID, new Date(NOW - 10_000).toISOString());
    writeTickLoopBeacon(beacon());
    const verdict = probeDaemonLiveness({ nowMs: NOW, pidProbe: () => 'alive' });
    expect(verdict.tickLoop?.state).toBe('ticking');
    expect(verdict.reason).not.toMatch(/STOPPED/);
  });

  it('a dead daemon carries no tick-loop verdict', () => {
    writeLock(PID, new Date(NOW - 10_000).toISOString());
    writeTickLoopBeacon(beacon());
    const verdict = probeDaemonLiveness({ nowMs: NOW, pidProbe: () => 'dead' });
    expect(verdict.state).toBe('stale');
    expect(verdict.tickLoop).toBeUndefined();
  });
});

describe('tick-loop watchdog self-recovery', () => {
  it('wakes a stalled loop once, then requests a restart if it still has not moved', () => {
    let nowMs = NOW;
    const stalled = beacon({ at: new Date(NOW - 30 * 60_000).toISOString(), expectedBy: new Date(NOW - 25 * 60_000).toISOString() });
    const current: TickLoopBeaconV1 = stalled;
    const wake = vi.fn();
    const restart = vi.fn();
    const watchdog = startTickLoopWatchdog({ current: () => current, wake, restart, now: () => nowMs, everyMs: 3_600_000 });
    try {
      expect(watchdog.check().state).toBe('stalled');
      expect(wake).toHaveBeenCalledTimes(1);
      expect(restart).not.toHaveBeenCalled();
      // Checked again before a threshold has passed since the wake: no escalation yet.
      nowMs += 60_000;
      watchdog.check();
      expect(wake).toHaveBeenCalledTimes(1);
      expect(restart).not.toHaveBeenCalled();
      // Still not moving one threshold after the wake: supervised restart, once.
      nowMs += tickLoopStallThresholdMs(INTERVAL_MS) + 1;
      watchdog.check();
      watchdog.check();
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      watchdog.stop();
    }
  });

  it('a wake that gets the loop moving ends the episode without a restart', () => {
    let nowMs = NOW;
    let current: TickLoopBeaconV1 = beacon({ at: new Date(NOW - 30 * 60_000).toISOString(), expectedBy: new Date(NOW - 25 * 60_000).toISOString() });
    const restart = vi.fn();
    const watchdog = startTickLoopWatchdog({
      current: () => current,
      wake: () => { current = beacon({ at: new Date(nowMs).toISOString(), expectedBy: new Date(nowMs + INTERVAL_MS).toISOString() }); },
      restart,
      now: () => nowMs,
      everyMs: 3_600_000,
    });
    try {
      watchdog.check();
      nowMs += tickLoopStallThresholdMs(INTERVAL_MS);
      expect(watchdog.check().state).toBe('ticking');
      expect(restart).not.toHaveBeenCalled();
    } finally {
      watchdog.stop();
    }
  });
});
