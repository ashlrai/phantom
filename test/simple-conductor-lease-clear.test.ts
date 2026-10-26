/**
 * Operator recovery for simple-conductor tasks stuck in
 * `reconciliation-required` (`ashlr loop leases`).
 *
 * Invariants:
 *  - A lease is cleared ONLY when its owner is provably not running: owner pid
 *    gone (ESRCH), owner pid reused by a process started after the claim once
 *    the lease outlived its full duration, or a claim from before the boot.
 *  - A possibly-live owner, an active lease, a done task or an unknown id is
 *    refused with a reason and the store is left byte-identical.
 *  - Clearing keeps attempts and known proposal ids so the conductor still
 *    reconciles before redispatch; --dry-run writes nothing.
 *  - New claims record the owner pid; legacy leases without one still parse.
 *
 * Real IO: private HOME task stores and real child processes for the CLI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claimSimpleConductorTask,
  clearReconciliationRequiredSimpleConductorTask,
  listReconciliationRequiredSimpleConductorTasks,
  simpleConductorTaskGenerationId,
  type LeaseOwnerProbe,
  type TaskSpec,
} from '../src/core/simple-conductor-task-store.js';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
let home: string;

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const HOUR = 60 * 60_000;
const TOKEN = '12345678-1234-4123-8123-123456789abc';

function tasksPath(): string {
  return join(home, '.ashlr', 'tasks.json');
}

function baseTask(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return { id: 'task-1', repo: '/tmp/enrolled-repo', instruction: 'repair the failing verifier', ...overrides };
}

function stuckTask(lease: { claimedAt: string; expiresAt: string; ownerPid?: number }, overrides: Partial<TaskSpec> = {}): TaskSpec {
  const row = baseTask(overrides);
  return {
    ...row,
    attempts: 2,
    revision: 4,
    candidateProposalId: 'candidate-1',
    dispatchLease: { token: TOKEN, generationId: simpleConductorTaskGenerationId(row), ...lease },
  };
}

function writeTasks(tasks: TaskSpec[]): void {
  const dir = join(home, '.ashlr');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(tasksPath(), `${JSON.stringify(tasks, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function rawTasks(): string {
  return readFileSync(tasksPath(), 'utf8');
}

const expired = {
  claimedAt: new Date(NOW - 30 * HOUR).toISOString(),
  expiresAt: new Date(NOW - 6 * HOUR).toISOString(),
};

// Probe of a host that booted long before every claim and whose pids all live.
const liveHost: LeaseOwnerProbe = {
  selfPid: 1,
  signal: () => 'exists',
  startedAtMs: () => NOW - 365 * 24 * HOUR,
  bootTimeMs: () => NOW - 400 * 24 * HOUR,
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sc-lease-clear-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(home, { recursive: true, force: true });
});

describe('simple-conductor lease clearing (store)', () => {
  it('lists only reconciliation-required tasks', () => {
    const active = { claimedAt: new Date(NOW - HOUR).toISOString(), expiresAt: new Date(NOW + 23 * HOUR).toISOString() };
    const skewed = { claimedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 30 * 24 * HOUR).toISOString() };
    writeTasks([
      stuckTask(expired, { id: 'stuck-expired' }),
      stuckTask(skewed, { id: 'stuck-skewed' }),
      stuckTask(active, { id: 'running' }),
      { ...stuckTask(expired, { id: 'finished' }), done: true },
      baseTask({ id: 'idle' }),
    ]);
    const listed = listReconciliationRequiredSimpleConductorTasks(NOW);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.tasks.map((entry) => [entry.task.id, entry.leaseState])).toEqual([
        ['stuck-expired', 'expired'],
        ['stuck-skewed', 'skewed'],
      ]);
    }
  });

  it('refuses while the recorded owner may be live and leaves the store untouched', () => {
    writeTasks([stuckTask({ ...expired, ownerPid: 4242 })]);
    const before = rawTasks();
    // Owner pid exists and started before the claim: it may be the claimant.
    const result = clearReconciliationRequiredSimpleConductorTask('task-1', { nowMs: NOW, probe: liveHost });
    expect(result).toMatchObject({ ok: false, reason: 'owner-not-disproved' });
    expect(rawTasks()).toBe(before);
  });

  it('refuses a legacy lease (no owner pid) when the host has not rebooted since the claim', () => {
    writeTasks([stuckTask(expired)]);
    const before = rawTasks();
    const result = clearReconciliationRequiredSimpleConductorTask('task-1', { nowMs: NOW, probe: liveHost });
    expect(result).toMatchObject({ ok: false, reason: 'owner-not-disproved' });
    if (!result.ok) expect(result.detail).toContain('predates owner-pid recording');
    expect(rawTasks()).toBe(before);
  });

  it('refuses when the owner pid is reused but the lease has not outlived its duration', () => {
    const skewed = { claimedAt: new Date(NOW - HOUR).toISOString(), expiresAt: new Date(NOW + 30 * 24 * HOUR).toISOString(), ownerPid: 4242 };
    writeTasks([stuckTask(skewed)]);
    const result = clearReconciliationRequiredSimpleConductorTask('task-1', {
      nowMs: NOW,
      probe: { ...liveHost, startedAtMs: () => NOW - 60_000 },
    });
    expect(result).toMatchObject({ ok: false, reason: 'owner-not-disproved' });
  });

  it('clears a dead owner back to a claimable row, keeping attempts and candidate ids', () => {
    writeTasks([stuckTask({ ...expired, ownerPid: 4242 })]);
    const result = clearReconciliationRequiredSimpleConductorTask('task-1', {
      nowMs: NOW,
      probe: { ...liveHost, signal: () => 'dead' },
    });
    expect(result).toMatchObject({ ok: true, changed: true, proof: 'owner-dead', leaseState: 'expired' });
    const [row] = JSON.parse(rawTasks()) as TaskSpec[];
    expect(row.dispatchLease).toBeUndefined();
    expect(row).toMatchObject({ attempts: 2, revision: 5, candidateProposalId: 'candidate-1' });
    expect(row.lastError).toContain('cleared by operator');

    const reclaimed = claimSimpleConductorTask('task-1', simpleConductorTaskGenerationId(row), NOW);
    expect(reclaimed.ok).toBe(true);
    if (reclaimed.ok) expect(reclaimed.claim.task.dispatchLease?.ownerPid).toBe(process.pid);
  });

  it('clears an owner pid reused by a process that started after the claim', () => {
    writeTasks([stuckTask({ ...expired, ownerPid: 4242 })]);
    const result = clearReconciliationRequiredSimpleConductorTask('task-1', {
      nowMs: NOW,
      probe: { ...liveHost, startedAtMs: () => NOW - 60_000 },
    });
    expect(result).toMatchObject({ ok: true, proof: 'owner-pid-reused' });
  });

  it('clears a legacy lease claimed before the current boot', () => {
    writeTasks([stuckTask(expired)]);
    const result = clearReconciliationRequiredSimpleConductorTask('task-1', {
      nowMs: NOW,
      probe: { ...liveHost, bootTimeMs: () => NOW - 2 * HOUR },
    });
    expect(result).toMatchObject({ ok: true, proof: 'claimed-before-boot' });
  });

  it('dry-run proves without writing', () => {
    writeTasks([stuckTask({ ...expired, ownerPid: 4242 })]);
    const before = rawTasks();
    const result = clearReconciliationRequiredSimpleConductorTask('task-1', {
      nowMs: NOW,
      dryRun: true,
      probe: { ...liveHost, signal: () => 'dead' },
    });
    expect(result).toMatchObject({ ok: true, changed: false, proof: 'owner-dead' });
    expect(rawTasks()).toBe(before);
  });

  it('refuses unknown ids, active leases and done tasks', () => {
    const active = { claimedAt: new Date(NOW - HOUR).toISOString(), expiresAt: new Date(NOW + 23 * HOUR).toISOString(), ownerPid: 4242 };
    writeTasks([
      stuckTask(active, { id: 'running' }),
      { ...stuckTask({ ...expired, ownerPid: 4242 }, { id: 'finished' }), done: true },
    ]);
    const dead: LeaseOwnerProbe = { ...liveHost, signal: () => 'dead' };
    expect(clearReconciliationRequiredSimpleConductorTask('nope', { nowMs: NOW, probe: dead }))
      .toMatchObject({ ok: false, reason: 'not-found' });
    expect(clearReconciliationRequiredSimpleConductorTask('running', { nowMs: NOW, probe: dead }))
      .toMatchObject({ ok: false, reason: 'not-reconciliation-required' });
    expect(clearReconciliationRequiredSimpleConductorTask('finished', { nowMs: NOW, probe: dead }))
      .toMatchObject({ ok: false, reason: 'not-reconciliation-required' });
  });

  it('never treats this process as a dead owner', () => {
    writeTasks([stuckTask({ ...expired, ownerPid: 4242 })]);
    const result = clearReconciliationRequiredSimpleConductorTask('task-1', {
      nowMs: NOW,
      probe: { ...liveHost, selfPid: 4242, signal: () => 'dead' },
    });
    expect(result).toMatchObject({ ok: false, reason: 'owner-not-disproved' });
  });
});

describe('ashlr loop leases (CLI wiring)', () => {
  function liveChild(): { pid: number; kill: () => Promise<void> } {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    if (typeof child.pid !== 'number') throw new Error('could not spawn');
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    return { pid: child.pid, kill: async () => { child.kill('SIGKILL'); await exited; } };
  }

  async function runLoop(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
    try {
      const { cmdLoop } = await import('../src/cli/loop.js');
      const code = await cmdLoop(args);
      return { code, out: out.join('\n'), err: err.join('\n') };
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  }

  function auditLines(): string[] {
    const dir = join(home, '.ashlr', 'audit');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => readFileSync(join(dir, name), 'utf8').trim().split('\n'));
  }

  // A lease written under a skewed clock: reconciliation-required right now.
  function skewedLease(ownerPid: number) {
    const now = Date.now();
    return { claimedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 30 * 24 * HOUR).toISOString(), ownerPid };
  }

  it('lists stuck tasks as JSON', async () => {
    writeTasks([stuckTask(skewedLease(999_999), { id: 'stuck' })]);
    const { code, out } = await runLoop(['leases', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: true, tasks: [{ id: 'stuck', leaseState: 'skewed', ownerPid: 999_999 }] });
  });

  it('refuses to clear a task whose owner is a live process', async () => {
    const owner = liveChild();
    try {
      writeTasks([stuckTask(skewedLease(owner.pid))]);
      const before = rawTasks();
      const { code, out } = await runLoop(['leases', 'clear', 'task-1', '--json']);
      expect(code).toBe(1);
      expect(JSON.parse(out)).toMatchObject({ ok: false, reason: 'owner-not-disproved' });
      expect(rawTasks()).toBe(before);
      expect(auditLines().some((line) => line.includes('simple-conductor:lease-clear') && line.includes('"refused"'))).toBe(true);
    } finally {
      await owner.kill();
    }
  });

  it('clears a task whose owner process has exited, and audits it', async () => {
    const owner = liveChild();
    await owner.kill();
    writeTasks([stuckTask(skewedLease(owner.pid))]);

    const preview = await runLoop(['leases', 'clear', 'task-1', '--dry-run', '--json']);
    expect(JSON.parse(preview.out)).toMatchObject({ ok: true, dryRun: true, changed: false, proof: 'owner-dead' });
    expect((JSON.parse(rawTasks()) as TaskSpec[])[0].dispatchLease).toBeDefined();

    const { code, out } = await runLoop(['leases', 'clear', 'task-1', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: true, changed: true, proof: 'owner-dead' });
    expect((JSON.parse(rawTasks()) as TaskSpec[])[0].dispatchLease).toBeUndefined();
    expect(auditLines().some((line) => line.includes('simple-conductor:lease-clear') && line.includes('"ok"'))).toBe(true);
  });

  it('reports an unknown task id', async () => {
    writeTasks([baseTask()]);
    const { code, err } = await runLoop(['leases', 'clear', 'missing']);
    expect(code).toBe(1);
    expect(err).toContain('not-found');
  });

  it('rejects malformed invocations with usage', async () => {
    expect((await runLoop(['leases', 'clear'])).code).toBe(2);
    expect((await runLoop(['leases', '--dry-run'])).code).toBe(2);
    expect((await runLoop(['leases', '--force'])).code).toBe(2);
  });
});
