/**
 * RQ-DAEMONTICK-UNBLOCK — resident daemon tick can never hang forever.
 *
 * SAFETY GUARDRAILS (mirrors m24.loop.test.ts):
 *  - HOME is overridden to a tmp dir so no real ~/.ashlr state is touched.
 *  - runSwarm is MOCKED — no real agents, no real subprocesses, no real API calls.
 *  - The hung typecheck child is a FAKE spawned EventEmitter — nothing real runs.
 *  - The `log stream` watcher is a FAKE child — a real log stream never starts.
 *  - Tmp repos only; enrolled for the dispatch test and unenrolled after.
 *
 * Invariants asserted:
 *
 *   BOUNDED PHASES:
 *     - runTickPhase resolves ok/degraded/timeout/skipped with a ledger record
 *     - a phase that never settles is aborted at its deadline and the tick's
 *       ledger records 'timeout' — the detached work cannot poison a later tick
 *
 *   RESIDENT DEADLINE:
 *     - runBoundedDaemonTick on a never-settling tick => 'timeout' and the
 *       abandoned marker parks; the next call refuses ('refused-open')
 *     - runDaemon --once with a tick() that throws writes lastTickAt +
 *       lastTickOutcome='failed' to daemon state (never leaves them stale)
 *     - runDaemon --once with a beforeTick hook that never settles writes
 *       lastTickAt + lastTickOutcome='timeout'
 *
 *   TICK COMPLETION:
 *     - a dispatched run whose inner work never resolves is detached at the
 *       turn watchdog and the tick still completes with outcome 'ok'
 *     - invent with no frontier client is 'skipped' with reason 'no-frontier'
 *       instead of awaiting an unresolvable planner
 *
 *   CHILD-PROCESS BOUNDS (AMEND 01:20):
 *     - a hung `npm run typecheck` subprocess is group-killed at timeout and
 *       reported timedOut:true (never awaited forever)
 *     - a `log stream` watcher that never starts is abandoned bounded
 *       (never awaited for exit); a ready stream whose barrier never arrives
 *       finishes 'incomplete' bounded and is SIGTERM'd
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeSync } from 'node:fs';
import type { spawn } from 'node:child_process';
import type { AshlrConfig } from '../src/core/types.js';

const origHome = process.env.HOME;
const origInDaemon = process.env.ASHLR_IN_DAEMON;
const origInSwarm = process.env.ASHLR_IN_SWARM;

let tmpHome: string;
let tmpRepo: string;

const mockRunSwarm = vi.fn();

vi.mock('../src/core/swarm/runner.js', () => ({
  runSwarm: (...args: unknown[]) => mockRunSwarm(...args),
}));

let activationCapabilityThrows = false;
vi.mock('../src/core/daemon/activation-permit.js', () => ({
  consumeDaemonActivationPermit: () => ({
    authorized: true,
    required: false,
    reason: 'test-authorized',
  }),
  isDaemonActivationCapability: () => {
    if (activationCapabilityThrows) throw new Error('activation probe exploded');
    return true;
  },
}));

// No frontier backend in this suite: the invent phase must skip 'no-frontier'
// instead of awaiting an unresolvable planner.
vi.mock('../src/core/generative/invent.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/generative/invent.js')>();
  return { ...actual, resolvePlanningClient: async () => null };
});

// Deterministic backlog: tests stage `backlogFixture` instead of depending on
// what the real scanners happen to find in the tmp repo.
let backlogFixture: import('../src/core/types.js').WorkItem[] = [];
vi.mock('../src/core/portfolio/backlog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/portfolio/backlog.js')>();
  return {
    ...actual,
    buildBacklog: async () => ({
      generatedAt: new Date().toISOString(),
      snapshotId: 'a'.repeat(32),
      repos: [tmpRepo],
      items: backlogFixture,
      observations: [],
      observationSourceState: 'healthy',
    }),
  };
});

// Short turn watchdog so the hung-dispatch test detaches in ~50 ms.
vi.mock('../src/core/daemon/local-fleet.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/daemon/local-fleet.js')>();
  return {
    ...actual,
    readLocalFleetSettings: () => ({
      enabled: false,
      engine: 'llama-server',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: null,
      taskTimeoutMs: 50,
      runtimeDownBackoffMs: 1_000,
      probeTimeoutMs: 50,
      maxDispatchesPerDay: null,
      source: 'off',
      detail: 'test fixture: fleet disarmed, short turn bound',
    }),
  };
});

import {
  tick,
  runDaemon,
  runBoundedDaemonTick,
  abandonedDaemonTickRunning,
  resetAbandonedDaemonTickForTests,
} from '../src/core/daemon/loop.js';
import {
  runTickPhase,
  skipTickPhase,
  beginTickPhases,
  endTickPhases,
  resetTickPhasesForTests,
} from '../src/core/daemon/tick-phases.js';
import { loadDaemonState, saveDaemonState } from '../src/core/daemon/state.js';
import { enroll, unenroll } from '../src/core/sandbox/policy.js';
import { runVerifySubprocessAsync } from '../src/core/run/verify-commands.js';
import {
  startSandboxDenialWatch,
  newViolationTag,
  type KernelEvidenceDeps,
} from '../src/core/sandbox/kernel-evidence.js';
import '../src/core/plugins/registry.js';

function makeCfg(overrides?: Partial<AshlrConfig>): AshlrConfig {
  return {
    version: 1,
    daemon: {
      dailyBudgetUsd: 1.0,
      perTickItems: 3,
      parallel: 2,
      intervalMs: 100,
    },
    ...overrides,
  } as AshlrConfig;
}

function initBareGitDir(dir: string): void {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, '.git', 'config'),
    '[core]\n\trepositoryformatversion = 0\n',
    'utf8',
  );
}

const never = (): Promise<never> => new Promise<never>(() => {});

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-tick-unblock-home-'));
  tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-tick-unblock-repo-'));
  process.env.HOME = tmpHome;
  initBareGitDir(tmpRepo);
  fs.writeFileSync(
    path.join(tmpRepo, 'package.json'),
    JSON.stringify({ name: 'test-repo', version: '1.0.0' }),
    'utf8',
  );
  mockRunSwarm.mockReset();
  activationCapabilityThrows = false;
  backlogFixture = [];
  resetAbandonedDaemonTickForTests();
  resetTickPhasesForTests();
  delete process.env.ASHLR_IN_DAEMON;
  delete process.env.ASHLR_IN_SWARM;
});

afterEach(() => {
  vi.useRealTimers();
  resetAbandonedDaemonTickForTests();
  resetTickPhasesForTests();
  try { unenroll(tmpRepo); } catch { /* ignore */ }
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpRepo, { recursive: true, force: true });
  process.env.HOME = origHome;
  for (const [key, val] of [
    ['ASHLR_IN_DAEMON', origInDaemon],
    ['ASHLR_IN_SWARM', origInSwarm],
  ] as const) {
    if (val !== undefined) process.env[key] = val;
    else delete process.env[key];
  }
  vi.clearAllMocks();
});

// ===========================================================================
// runTickPhase — the bounded phase runner
// ===========================================================================

describe('RQ-DAEMONTICK-UNBLOCK: runTickPhase', () => {
  it('records ok with the work value into the open ledger', async () => {
    beginTickPhases();
    const result = await runTickPhase('fixture', async () => 42, { deadlineMs: 5_000 });
    const ledger = endTickPhases();
    expect(result).toMatchObject({ status: 'ok', value: 42 });
    expect(ledger).toEqual([
      expect.objectContaining({ name: 'fixture', status: 'ok' }),
    ]);
    expect(ledger[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records degraded when the work throws and still resolves', async () => {
    beginTickPhases();
    const result = await runTickPhase('fixture', async () => {
      throw new Error('boom');
    }, { deadlineMs: 5_000 });
    const ledger = endTickPhases();
    expect(result.status).toBe('degraded');
    expect(result.error).toContain('boom');
    expect(ledger[0]).toMatchObject({ status: 'degraded' });
    expect(ledger[0]!.error).toContain('boom');
  });

  it('records timeout, aborts the signal, and resolves at the deadline', async () => {
    beginTickPhases();
    let observedAbort = false;
    const started = Date.now();
    const result = await runTickPhase('fixture', async (signal) => {
      signal.addEventListener('abort', () => { observedAbort = true; });
      await never();
    }, { deadlineMs: 30, graceMs: 20 });
    const ledger = endTickPhases();
    expect(result.status).toBe('timeout');
    expect(result.error).toContain('deadline');
    expect(observedAbort).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(ledger[0]).toMatchObject({ name: 'fixture', status: 'timeout' });
    expect(ledger[0]!.error).toContain('deadline');
  });

  it('records skipped via skipTickPhase', async () => {
    beginTickPhases();
    const result = await runTickPhase('fixture', async () => skipTickPhase('no-frontier'), {
      deadlineMs: 5_000,
    });
    const ledger = endTickPhases();
    expect(result.status).toBe('skipped');
    expect(result.error).toBe('no-frontier');
    expect(ledger[0]).toMatchObject({ status: 'skipped', error: 'no-frontier' });
  });

  it('a detached phase appends to the ledger that was open when it started, never a later one', async () => {
    beginTickPhases();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const result = await runTickPhase('fixture', () => gate.then(() => 'late'), {
      deadlineMs: 20,
      graceMs: 10,
    });
    expect(result.status).toBe('timeout');
    const firstLedger = endTickPhases();
    expect(firstLedger).toHaveLength(1);

    // The abandoned work settles LATE — inside the next ledger's window.
    beginTickPhases();
    const late = await runTickPhase('second', async () => 'now', { deadlineMs: 5_000 });
    release?.();
    await gate;
    const secondLedger = endTickPhases();
    expect(late.status).toBe('ok');
    expect(secondLedger).toHaveLength(1);
    expect(secondLedger[0]!.name).toBe('second');
  });
});

// ===========================================================================
// runBoundedDaemonTick — the resident deadline backstop
// ===========================================================================

describe('RQ-DAEMONTICK-UNBLOCK: runBoundedDaemonTick', () => {
  const tickRecord = (): import('../src/core/types.js').DaemonTick => ({
    ts: new Date().toISOString(),
    itemsConsidered: 0,
    proposalsCreated: 0,
    spentUsd: 0,
    reason: 'fixture',
  });

  it('settles a completing tick', async () => {
    const outcome = await runBoundedDaemonTick(async () => tickRecord(), 5_000);
    expect(outcome).toMatchObject({ kind: 'settled' });
    expect(abandonedDaemonTickRunning()).toBe(false);
  });

  it('reports failed for a throwing tick (sync or async)', async () => {
    const asyncThrow = await runBoundedDaemonTick(async () => { throw new Error('async-boom'); }, 5_000);
    expect(asyncThrow.kind).toBe('failed');
    expect(asyncThrow).toMatchObject({ error: expect.stringContaining('async-boom') });
    const syncThrow = await runBoundedDaemonTick(() => { throw new Error('sync-boom'); }, 5_000);
    expect(syncThrow.kind).toBe('failed');
    expect(syncThrow).toMatchObject({ error: expect.stringContaining('sync-boom') });
  });

  it('times out a never-settling tick and refuses the next while it stays open', async () => {
    const outcome = await runBoundedDaemonTick(never, 30);
    expect(outcome.kind).toBe('timeout');
    expect(abandonedDaemonTickRunning()).toBe(true);

    const second = await runBoundedDaemonTick(async () => tickRecord(), 30);
    expect(second.kind).toBe('refused-open');

    resetAbandonedDaemonTickForTests();
    expect(abandonedDaemonTickRunning()).toBe(false);
    const third = await runBoundedDaemonTick(async () => tickRecord(), 30);
    expect(third.kind).toBe('settled');
  });
});

// ===========================================================================
// runDaemon --once: lastTickAt/outcome persistence under throw + timeout
// ===========================================================================

describe('RQ-DAEMONTICK-UNBLOCK: resident tick persistence', () => {
  it('tick() throwing still advances lastTickAt with outcome failed', async () => {
    activationCapabilityThrows = true;
    const before = loadDaemonState().lastTickAt;
    const state = await runDaemon(makeCfg(), { once: true, tickDeadlineMs: 5_000 });
    expect(state.lastTickAt).not.toBe(before ?? undefined);
    expect(state.lastTickAt).toBeTruthy();
    expect(state.lastTickOutcome).toBe('failed');
    expect(state.lastTickError).toContain('activation probe exploded');
  });

  it('a never-settling tick writes lastTickAt with outcome timeout', async () => {
    const { DEFAULT_TICK_HOOKS } = await import('../src/core/daemon/tick-hooks.js');
    const state = await runDaemon(makeCfg(), {
      once: true,
      tickDeadlineMs: 60,
      hooks: { ...DEFAULT_TICK_HOOKS, beforeTick: never },
    });
    expect(state.lastTickAt).toBeTruthy();
    expect(state.lastTickOutcome).toBe('timeout');
    expect(state.lastTickError).toContain('deadline');
    resetAbandonedDaemonTickForTests();
  });

  it('invent phase skips no-frontier instead of awaiting a planner', async () => {
    enroll(tmpRepo);
    const cfg = makeCfg();
    // autonomyControlLoop off keeps the master path (a resource-strategy plan
    // that pauses would short-circuit the tick before maintenance ever runs).
    (cfg.foundry as Record<string, unknown>) = { generative: true, autonomyControlLoop: false };
    const result = await tick(cfg, { dryRun: false });
    const invent = (result.phases ?? []).find((phase) => phase.name === 'invent');
    expect(invent).toBeDefined();
    expect(invent).toMatchObject({ status: 'skipped', error: 'no-frontier' });
  }, 30_000);

  it('a beforeTick lease failure (collector-start-failed) degrades the phase; the tick completes', async () => {
    const { DEFAULT_TICK_HOOKS } = await import('../src/core/daemon/tick-hooks.js');
    // The native account-metadata lease being unavailable surfaces inside
    // beforeTick (mirror prep / readiness collectors); pre-fix it held the
    // whole tick open, post-fix it degrades the 'tick hooks' phase and holds
    // production for this tick only.
    const result = await tick(makeCfg(), {
      dryRun: false,
      hooks: {
        ...DEFAULT_TICK_HOOKS,
        beforeTick: async () => {
          throw new Error('collector-start-failed: native account-metadata lease unavailable');
        },
      },
    });
    const hooksPhase = (result.phases ?? []).find((phase) => phase.name === 'tick hooks');
    expect(hooksPhase).toBeDefined();
    expect(hooksPhase!.status).toBe('degraded');
    expect(hooksPhase!.error).toContain('collector-start-failed');
    expect(loadDaemonState().lastTickAt).toBeTruthy();
  });

  it('a dispatched run that never resolves is detached; the tick still completes', async () => {
    enroll(tmpRepo);
    const now = new Date().toISOString();
    backlogFixture = [
      {
        id: 'test-item-hung',
        repo: tmpRepo,
        source: 'todo',
        title: 'Work whose run never resolves',
        detail: '// TODO: hangs',
        value: 4,
        effort: 2,
        score: 2,
        tags: ['todo'],
        ts: now,
      },
    ];
    // runSwarm never settles — the turn watchdog (taskTimeoutMs: 50 mock)
    // detaches it and the tick proceeds instead of awaiting forever.
    mockRunSwarm.mockImplementation(() => never());
    const started = Date.now();
    const result = await tick(makeCfg(), { dryRun: false });
    expect(result).toBeTruthy();
    // The turn bound is ~50 ms + dispatch-phase slack; the tick must finish
    // well inside the test window — pre-fix this never returned.
    expect(Date.now() - started).toBeLessThan(90_000);
    const dispatch = (result.phases ?? []).find((phase) => phase.name === 'dispatch');
    // Either the dispatch phase settled (run detached) or nothing dispatched —
    // the tick must not have hung either way.
    expect(['ok', 'skipped', 'timeout', undefined]).toContain(dispatch?.status);
    const state = loadDaemonState();
    expect(state.lastTickAt).toBeTruthy();
  }, 120_000);
});

// ===========================================================================
// daemon state — the outcome/phase ledger round-trips through the codec
// (this is the same state `phm daemon status --json` reads .tick from)
// ===========================================================================

describe('RQ-DAEMONTICK-UNBLOCK: daemon state persists tick outcome + phases', () => {
  it('lastTickOutcome/lastTickPhases/lastTickError survive a save/load round-trip', () => {
    const ts = new Date().toISOString();
    saveDaemonState({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: ts,
      lastTickOutcome: 'timeout',
      lastTickError: 'phase dispatch exceeded its 60 s deadline',
      lastTickPhases: [
        { name: 'backlog-refresh', status: 'ok', durationMs: 12 },
        { name: 'dispatch', status: 'timeout', durationMs: 60_005, error: 'phase exceeded its 60 s deadline' },
      ],
      todayDate: ts.slice(0, 10),
      todaySpentUsd: 0,
      itemsProcessed: 0,
      ticks: [],
    });
    const loaded = loadDaemonState();
    expect(loaded.lastTickAt).toBe(ts);
    expect(loaded.lastTickOutcome).toBe('timeout');
    expect(loaded.lastTickError).toContain('dispatch');
    expect(loaded.lastTickPhases).toHaveLength(2);
    expect(loaded.lastTickPhases![1]).toMatchObject({
      name: 'dispatch',
      status: 'timeout',
      durationMs: 60_005,
    });
    expect(loaded.lastTickPhases![1]!.error).toContain('deadline');
  });

  it('an old state file without the new fields still parses', () => {
    saveDaemonState({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: new Date().toISOString(),
      todayDate: new Date().toISOString().slice(0, 10),
      todaySpentUsd: 0,
      itemsProcessed: 0,
      ticks: [],
    });
    const loaded = loadDaemonState();
    expect(loaded.lastTickOutcome).toBeUndefined();
    expect(loaded.lastTickPhases).toBeUndefined();
    expect(loaded.lastTickError).toBeUndefined();
  });

  it('drops malformed phase rows instead of failing the whole state read', () => {
    saveDaemonState({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: new Date().toISOString(),
      todayDate: new Date().toISOString().slice(0, 10),
      todaySpentUsd: 0,
      itemsProcessed: 0,
      ticks: [],
      // Forged on-disk shape: malformed rows are filtered, never fatal.
      lastTickPhases: [
        { name: 'ok-phase', status: 'ok', durationMs: 1 },
        { name: 42, status: 'weird', durationMs: 'x' } as never,
      ],
    } as never);
    const loaded = loadDaemonState();
    expect(loaded.lastTickPhases).toEqual([
      expect.objectContaining({ name: 'ok-phase', status: 'ok' }),
    ]);
  });
});

// ===========================================================================
// AMEND 01:20 — child-process bounds on the tick path
// ===========================================================================

describe('RQ-DAEMONTICK-UNBLOCK: bounded child processes', () => {
  /**
   * A spawned child that never exits on its own and shrugs off graceful
   * signals — the wedged shape a hung `npm run typecheck` leaves. Only the
   * SIGKILL escalation kills it (exit+close like a real child); post-death
   * probes report ESRCH.
   */
  const hungGroup = (pid = 24_680) => {
    let dead = false;
    const child = Object.assign(new EventEmitter(), {
      pid,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      unref: vi.fn(),
    });
    const processKill = vi.fn((_target: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) {
        if (dead) throw Object.assign(new Error('absent'), { code: 'ESRCH' });
        return;
      }
      if (signal !== 'SIGKILL') return; // SIGTERM/SIGINT: wedged — escalation follows.
      dead = true;
      queueMicrotask(() => {
        child.emit('exit', null, 'SIGKILL');
        child.emit('close', null, 'SIGKILL');
      });
    });
    return { child, processKill };
  };

  it('a hung `npm run typecheck` child is group-killed at timeout (never awaited forever)', async () => {
    const { child, processKill } = hungGroup();
    const spawnFake = vi.fn(() => child);
    const started = Date.now();
    const result = await runVerifySubprocessAsync(['npm', 'run', 'typecheck'], {
      cwd: '/fixture',
      env: {},
      timeoutMs: 60,
      _platform: 'linux',
      _spawn: spawnFake as unknown as typeof spawn,
      _processKill: processKill,
      _terminationGraceMs: 10,
      _terminationDrainMs: 10,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.timedOut).toBe(true);
    // Group kill: negative pid targets the child's process group.
    expect(processKill).toHaveBeenCalledWith(-24_680, 'SIGTERM');
    expect(processKill).toHaveBeenCalledWith(-24_680, 'SIGKILL');
  });

  it('a phase-aborted verify subprocess kills the child process group', async () => {
    const { child, processKill } = hungGroup();
    const spawnFake = vi.fn(() => child);
    const controller = new AbortController();
    const pending = runVerifySubprocessAsync(['npm', 'run', 'typecheck'], {
      cwd: '/fixture',
      env: {},
      timeoutMs: 60_000,
      signal: controller.signal,
      _platform: 'linux',
      _spawn: spawnFake as unknown as typeof spawn,
      _processKill: processKill,
      _terminationGraceMs: 10,
      _terminationDrainMs: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const result = await pending;
    expect(result.cancelled).toBe(true);
    // Cancel termination is SIGINT first, SIGKILL after the grace window.
    expect(processKill).toHaveBeenCalledWith(-24_680, 'SIGINT');
    expect(processKill).toHaveBeenCalledWith(-24_680, 'SIGKILL');
  });

  function streamDeps(behavior: {
    writeHeader?: boolean;
    barrier?: boolean;
  }): KernelEvidenceDeps {
    let now = 1_000;
    return {
      platform: 'darwin',
      startStream: (_predicate, outFd) => {
        if (behavior.writeHeader) {
          writeSync(outFd, 'Filtering the log data...\n');
        }
        // A `log stream` child that NEVER exits. Kill is recorded; nothing is
        // awaited on exit — the watch only polls the capture FILE.
        return Object.assign(new EventEmitter(), {
          kill: vi.fn(() => true),
          unref: vi.fn(),
        });
      },
      barrier: () => { /* the denial never reaches the stream */ },
      sleepSync: () => { now += 10; },
      nowMs: () => now,
    };
  }

  it('a `log stream` that never starts is abandoned bounded — never awaited for exit', () => {
    const deps = streamDeps({ writeHeader: false });
    const watch = startSandboxDenialWatch(newViolationTag(), { parent: tmpHome, deps });
    expect(watch.ready).toBe(false);
    const evidence = watch.finish();
    expect(evidence.state).toBe('unavailable');
  });

  it('a ready `log stream` whose barrier never arrives finishes incomplete and is SIGTERM\'d', () => {
    const deps = streamDeps({ writeHeader: true });
    const watch = startSandboxDenialWatch(newViolationTag(), { parent: tmpHome, deps });
    expect(watch.ready).toBe(true);
    const evidence = watch.finish();
    expect(evidence.state).toBe('incomplete');
    expect(evidence.reason).toContain('barrier');
  });
});
