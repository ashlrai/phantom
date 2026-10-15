/**
 * Builtin swarm: the machine-wide outward mutation fence is held only around
 * outward steps (admission gate, filing, cleanup), never across planning or
 * task inference (SPEC-310B §3, V3.10 U6 applied to the swarm runner).
 *
 *   (a) two strict swarms' inference phases overlap (they used to serialize:
 *       the second could not even be admitted while the first was thinking);
 *   (b) KILL armed during inference aborts the in-flight inference, files
 *       nothing, mints no cleanup authority, ends the run aborted, and kill
 *       reports quiescence only after the run's last effect;
 *   (c) authority revoked during inference (unenroll, or a pause that is
 *       resumed again before the model returns) still refuses filing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AshlrConfig, RunState, Sandbox, SwarmPlan } from '../src/core/types.js';

const mocks = vi.hoisted(() => ({
  createSandbox: vi.fn(),
  sandboxDiff: vi.fn(),
  removeSandbox: vi.fn(),
  removeSandboxWithBorrowedAuthority: vi.fn(),
  removeSandboxAsync: vi.fn(),
  createProposal: vi.fn(),
  runGoal: vi.fn(),
  planSwarm: vi.fn(),
  assurePrivateStorage: vi.fn(() => ({ ok: true, reason: 'exact-private-dacl' })),
  snapshotProject: vi.fn((project: string | null) => ({
    project,
    isRepo: false,
    head: null,
    dirty: false,
    stashRef: null,
    ts: new Date().toISOString(),
  })),
}));

vi.mock('../src/core/util/private-storage.js', () => ({
  assurePrivateStoragePath: mocks.assurePrivateStorage,
}));

vi.mock('../src/core/run/orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/run/orchestrator.js')>();
  return { ...actual, runGoal: mocks.runGoal };
});

vi.mock('../src/core/swarm/planner.js', () => ({
  planSwarm: mocks.planSwarm,
}));

vi.mock('../src/core/swarm/rollback.js', () => ({
  snapshotProject: mocks.snapshotProject,
}));

vi.mock('../src/core/sandbox/worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/sandbox/worktree.js')>();
  return {
    ...actual,
    createSandbox: mocks.createSandbox,
    createSandboxAsync: async (...args: Parameters<typeof mocks.createSandbox>) =>
      mocks.createSandbox(...args),
    sandboxDiff: mocks.sandboxDiff,
    removeSandbox: mocks.removeSandbox,
    removeSandboxWithBorrowedAuthority: mocks.removeSandboxWithBorrowedAuthority,
    removeSandboxAsync: mocks.removeSandboxAsync,
  };
});

vi.mock('../src/core/inbox/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/inbox/store.js')>();
  return { ...actual, createProposal: mocks.createProposal };
});

import { enroll, isEnrolled, killSwitchOn, setKill, unenroll } from '../src/core/sandbox/policy.js';
import { runSwarm } from '../src/core/swarm/runner.js';
import { loadSwarm } from '../src/core/swarm/store.js';

function config(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    foundry: { completenessGate: false },
  };
}

function completedRun(goal: string): RunState {
  const now = new Date().toISOString();
  return {
    id: 'fence-release-task-run',
    goal,
    engine: 'builtin',
    provider: 'ollama',
    createdAt: now,
    updatedAt: now,
    budget: { maxTokens: 1_000, maxSteps: 10, allowCloud: false },
    usage: { tokensIn: 1, tokensOut: 1, steps: 1, estCostUsd: 0 },
    tasks: [],
    steps: [],
    status: 'done',
    result: 'task complete',
  };
}

const plan: SwarmPlan = {
  specId: null,
  goal: 'fence release across inference',
  tasks: [{ id: 'build-1', phase: 'build', goal: 'think, then write in the sandbox', deps: [] }],
};

type RunGoalOpts = { signal?: AbortSignal; cwd?: string };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([
    promise,
    new Promise<'timeout'>((r) => { setTimeout(() => r('timeout'), ms); }),
  ]);
}

/** Resolves when `signal` aborts (never, if it has none). */
function aborted(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!signal) return;
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

describe('builtin swarm releases the outward fence across inference', { timeout: 60_000 }, () => {
  let home: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousAshlrHome: string | undefined;

  function strictSwarm(runId: string, project: string): ReturnType<typeof runSwarm> {
    return runSwarm(
      { goal: plan.goal },
      config(),
      {
        runId,
        project,
        sandbox: true,
        requireSandbox: true,
        propose: true,
        noCapture: true,
      },
      () => {},
    );
  }

  beforeEach(() => {
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousAshlrHome = process.env.ASHLR_HOME;
    home = mkdtempSync(join(tmpdir(), 'ashlr-swarm-fence-home-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.ASHLR_HOME = join(home, '.ashlr');
    delete process.env.ASHLR_IN_SWARM;
    vi.clearAllMocks();

    mocks.createSandbox.mockImplementation((sourceRepo: string) => {
      const name = sourceRepo.endsWith('repo-b') ? 'b' : 'a';
      return {
        id: `fence-sandbox-${name}`,
        sourceRepo,
        worktreePath: join(home, `sandbox-${name}`),
        branch: `ashlr/sandbox/fence-${name}`,
        baseHead: 'a'.repeat(40),
        createdAt: new Date().toISOString(),
        ownerPid: process.pid,
      } satisfies Sandbox;
    });
    mocks.sandboxDiff.mockReturnValue({
      patch: 'diff --git a/x.ts b/x.ts\n+inference result\n',
      files: 1,
      insertions: 1,
      deletions: 0,
    });
    mocks.removeSandbox.mockReturnValue({ status: 'complete' });
    mocks.removeSandboxWithBorrowedAuthority.mockReturnValue({ status: 'complete' });
    mocks.removeSandboxAsync.mockResolvedValue({ status: 'complete' });
    mocks.createProposal.mockImplementation((proposal: Record<string, unknown>) => ({
      ...proposal,
      id: `proposal-${String(proposal.runId)}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
    }));
    mocks.planSwarm.mockResolvedValue(plan);
  });

  afterEach(() => {
    setKill(false, { waitMs: 500 });
    delete process.env.ASHLR_IN_SWARM;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
    else process.env.ASHLR_HOME = previousAshlrHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('(a) lets two strict swarms overlap their inference instead of serializing on the fence', async () => {
    const repoA = join(home, 'repo-a');
    const repoB = join(home, 'repo-b');
    expect(enroll(repoA)).toMatchObject({ ok: true });
    expect(enroll(repoB)).toMatchObject({ ok: true });

    // Barrier: each inference waits until BOTH are in flight (or gives up).
    // Serialized swarms can never meet here.
    const entered: string[] = [];
    const firstEntered = deferred();
    const bothEntered = deferred();
    mocks.runGoal.mockImplementation(async (goal: string, _cfg: unknown, opts: RunGoalOpts) => {
      entered.push(opts.cwd ?? '');
      if (entered.length === 1) firstEntered.resolve();
      if (entered.length === 2) bothEntered.resolve();
      await within(bothEntered.promise, 6_000);
      return completedRun(goal);
    });

    const runningA = strictSwarm('fence-overlap-a', repoA);
    await firstEntered.promise;
    // The runner marks its process to refuse nested swarms; this test drives a
    // second, independent swarm from the same process on purpose.
    delete process.env.ASHLR_IN_SWARM;
    const runningB = strictSwarm('fence-overlap-b', repoB);

    expect(await within(bothEntered.promise, 6_000)).not.toBe('timeout');
    const [a, b] = await Promise.all([runningA, runningB]);
    expect(entered.sort()).toEqual([join(home, 'sandbox-a'), join(home, 'sandbox-b')]);
    expect(a.status).toBe('done');
    expect(b.status).toBe('done');
    // Filing still happened, each under its own re-acquired fence.
    expect(mocks.createProposal).toHaveBeenCalledTimes(2);
    expect(mocks.removeSandboxWithBorrowedAuthority).toHaveBeenCalledTimes(2);
    expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });
  });

  it('(b) KILL during inference aborts it, files nothing, and ends the run killed', async () => {
    const project = join(home, 'repo-a');
    expect(enroll(project)).toMatchObject({ ok: true });
    const inInference = deferred();
    let inferenceSignal: AbortSignal | undefined;
    mocks.runGoal.mockImplementationOnce(async (_goal: string, _cfg: unknown, opts: RunGoalOpts) => {
      inferenceSignal = opts.signal;
      inInference.resolve();
      await aborted(opts.signal);
      throw new Error('inference aborted');
    });

    const running = strictSwarm('fence-kill-during-inference', project);
    await inInference.promise;

    // The run is mid-inference, NOT holding the fence: kill takes the fence,
    // arms KILL, aborts the run's lease — and still refuses to report
    // quiescence while the run has effects left.
    const pause = setKill(true, { waitMs: 25 });
    expect(pause).toEqual({
      ok: false,
      changed: true,
      quiesced: false,
      reason: 'kill armed; an outward mutation has not quiesced',
    });
    expect(killSwitchOn()).toBe(true);
    // The in-flight inference is told to stop at once (it used to run on).
    expect(await within(aborted(inferenceSignal), 2_000)).not.toBe('timeout');

    const result = await running;
    expect(result).toMatchObject({
      status: 'aborted',
      result: expect.stringMatching(/kill switch during phase build/i),
    });
    expect(result.tasks[0]).toMatchObject({
      status: 'cancelled',
      error: 'Cancelled because the autonomy kill switch is ON.',
    });
    expect(loadSwarm('fence-kill-during-inference')).toMatchObject({ status: 'aborted' });
    // No outward mutation after KILL: no proposal, no cleanup authority.
    expect(mocks.createProposal).not.toHaveBeenCalled();
    expect(mocks.removeSandboxWithBorrowedAuthority).not.toHaveBeenCalled();
    expect(mocks.removeSandbox).not.toHaveBeenCalled();
    // Only the run's own scratch worktree is removed, via the right minted at
    // admission (KILL off), under a fresh fence inside removeSandboxAsync.
    expect(mocks.removeSandboxAsync).toHaveBeenCalledOnce();
    expect(mocks.removeSandboxAsync.mock.calls[0]![1]).toMatchObject({
      ownRemovalRight: expect.objectContaining({ sandboxId: 'fence-sandbox-a' }),
    });
    expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });
  });

  it('(b) KILL during planning inference aborts the planner and executes no task', async () => {
    const project = join(home, 'repo-a');
    expect(enroll(project)).toMatchObject({ ok: true });
    const inPlanning = deferred();
    mocks.planSwarm.mockImplementationOnce(async (_input: unknown, _cfg: unknown, signal?: AbortSignal) => {
      inPlanning.resolve();
      await aborted(signal);
      throw new Error('planning aborted');
    });

    const running = strictSwarm('fence-kill-during-planning', project);
    await inPlanning.promise;
    expect(setKill(true, { waitMs: 25 })).toMatchObject({ ok: false, quiesced: false });

    expect(await within(running, 5_000)).toMatchObject({
      status: 'aborted',
      result: expect.stringMatching(/kill switch during planning/i),
    });
    expect(mocks.runGoal).not.toHaveBeenCalled();
    expect(mocks.createProposal).not.toHaveBeenCalled();
    expect(mocks.removeSandboxWithBorrowedAuthority).not.toHaveBeenCalled();
    expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });
  });

  it('(c) unenroll during inference revokes authority: the run stops and files nothing', async () => {
    const project = join(home, 'repo-a');
    expect(enroll(project)).toMatchObject({ ok: true });
    const inInference = deferred();
    let inferenceSignal: AbortSignal | undefined;
    const release = deferred();
    // This inference IGNORES its abort and returns a finished result anyway:
    // the fenced gate before filing, not the abort, is what must refuse.
    mocks.runGoal.mockImplementationOnce(async (goal: string, _cfg: unknown, opts: RunGoalOpts) => {
      inferenceSignal = opts.signal;
      inInference.resolve();
      await release.promise;
      return completedRun(goal);
    });

    const running = strictSwarm('fence-unenroll-during-inference', project);
    await inInference.promise;
    expect(unenroll(project, { waitMs: 25 })).toEqual({
      ok: false,
      changed: true,
      quiesced: false,
      reason: 'unenrolled; an autonomous run on this repo has not drained',
    });
    expect(isEnrolled(project)).toBe(false);
    expect(inferenceSignal?.aborted).toBe(true);
    release.resolve();

    const result = await running;
    expect(result).toMatchObject({
      status: 'aborted',
      result: expect.stringMatching(/authority revoked \(repo unenrolled\)/i),
    });
    expect(mocks.createProposal).not.toHaveBeenCalled();
    expect(mocks.removeSandboxWithBorrowedAuthority).not.toHaveBeenCalled();
    expect(mocks.removeSandboxAsync).toHaveBeenCalledOnce();
    expect(unenroll(project, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });
  });

  it('(c) a pause resumed again before inference returns still refuses filing', async () => {
    const project = join(home, 'repo-a');
    expect(enroll(project)).toMatchObject({ ok: true });
    const inInference = deferred();
    const release = deferred();
    mocks.runGoal.mockImplementationOnce(async (goal: string) => {
      inInference.resolve();
      await release.promise;
      return completedRun(goal);
    });

    const running = strictSwarm('fence-pause-resume-during-inference', project);
    await inInference.promise;
    expect(setKill(true, { waitMs: 25 })).toMatchObject({ ok: false, changed: true, quiesced: false });
    // Resume needs the fence; the run does not hold it across inference, so
    // the operator CAN resume now. The run's lease was already revoked.
    expect(setKill(false, { waitMs: 25 })).toMatchObject({ ok: true, changed: true });
    expect(killSwitchOn()).toBe(false);
    release.resolve();

    const result = await running;
    expect(result).toMatchObject({
      status: 'aborted',
      result: expect.stringMatching(/authority revoked \(kill switch armed\)/i),
    });
    expect(mocks.createProposal).not.toHaveBeenCalled();
    expect(mocks.removeSandboxWithBorrowedAuthority).not.toHaveBeenCalled();
    // KILL is off again, so its own removal goes through the ordinary gate.
    expect(mocks.removeSandboxAsync).toHaveBeenCalledOnce();
  });
});
