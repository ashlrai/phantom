import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AshlrConfig, RunTask } from '../src/core/types.js';
import { makeCfg, withTmpHome, type DisposableRepo } from './helpers/h1-fixture.js';

const privateStorageMocks = vi.hoisted(() => ({ useRealAssurance: false }));

vi.mock('../src/core/util/private-storage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/util/private-storage.js')>();
  return {
    ...actual,
    assurePrivateStoragePath: (
      ...args: Parameters<typeof actual.assurePrivateStoragePath>
    ) => privateStorageMocks.useRealAssurance
      ? actual.assurePrivateStoragePath(...args)
      : { ok: true, reason: 'exact-private-dacl' },
  };
});

vi.mock('../src/core/run/engines.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/run/engines.js')>();
  return { ...actual, spawnEngine: vi.fn() };
});

vi.mock('../src/core/run/agent-loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/run/agent-loop.js')>();
  return { ...actual, runTask: vi.fn() };
});

import { runTask } from '../src/core/run/agent-loop.js';
import { spawnEngine } from '../src/core/run/engines.js';
import {
  runApiModelSandboxed,
  runEngineSandboxed,
  type SandboxedEngineResult,
} from '../src/core/run/sandboxed-engine.js';
import { listProposals } from '../src/core/inbox/store.js';
import { killSwitchOn, setKill } from '../src/core/sandbox/policy.js';
import { listSandboxes } from '../src/core/sandbox/worktree.js';
import { countLiveExecutionLeases } from '../src/core/sandbox/execution-leases.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../src/core/sandbox/mutation-fence.js';

interface SourceSnapshot {
  tree: string;
  status: string;
  branch: string;
  branches: string[];
  worktrees: string;
}

function sourceSnapshot(repo: DisposableRepo): SourceSnapshot {
  return {
    tree: repo.shasumTree(),
    status: repo.gitStatus(),
    branch: repo.currentBranch(),
    branches: repo.branches().slice().sort(),
    worktrees: execFileSync('git', ['-C', repo.dir, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30_000,
    }).trim(),
  };
}

function prepareAuthorityRoots(): void {
  privateStorageMocks.useRealAssurance = true;
  try {
    const fence = acquireOutwardMutationFence();
    try {
      if (!ownsOutwardMutationFence(fence)) {
        throw new Error('M409 fixture failed to establish private authority roots');
      }
    } finally {
      releaseOutwardMutationFence(fence);
    }
  } finally {
    privateStorageMocks.useRealAssurance = false;
  }
}

function makeConfig(): AshlrConfig {
  return makeCfg({
    models: { providerChain: [] },
    foundry: {
      completenessGate: false,
      dispatchRetries: 0,
      fleetMcp: false,
      models: {
        claude: 'claude-sonnet-4-5',
        'local-coder': 'qwen2.5:72b-instruct-q4_K_M',
      },
    },
  } as Partial<AshlrConfig>);
}

function abortGate(): {
  entered: Promise<void>;
  wait: (signal: AbortSignal | undefined) => Promise<void>;
} {
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  return {
    entered,
    wait: (signal) => {
      markEntered();
      if (signal?.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };
}

async function withAnyRepoAllowed<T>(fixture: () => Promise<T>): Promise<T> {
  const previous = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  try {
    return await fixture();
  } finally {
    // Setup and run cleanup can both fail; neither may leak this test-only flag.
    if (previous === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
    else process.env.ASHLR_TEST_ALLOW_ANY_REPO = previous;
  }
}

async function awaitProducerEntry(
  gate: ReturnType<typeof abortGate>,
  running: Promise<SandboxedEngineResult>,
): Promise<void> {
  // A producer can refuse before reaching its inert mock. Report that boundary
  // immediately instead of leaving the entry gate pending until the test timeout.
  // Fixed messages avoid copying raw producer errors or private fixture paths.
  await Promise.race([
    gate.entered,
    running.then(
      () => { throw new Error('producer completed before mock entry'); },
      () => { throw new Error('producer rejected before mock entry'); },
    ),
  ]);
}

const spawnEngineMock = vi.mocked(spawnEngine);
const runTaskMock = vi.mocked(runTask);

afterEach(() => {
  vi.clearAllMocks();
});

describe('M409 engine execution outward mutation fence', () => {
  const cases: Array<{
    label: string;
    start: (
      repo: DisposableRepo,
      cfg: AshlrConfig,
      controller: AbortController,
      gate: ReturnType<typeof abortGate>,
    ) => Promise<SandboxedEngineResult>;
  }> = [
    {
      label: 'CLI agent',
      start: (repo, cfg, controller, gate) => {
        spawnEngineMock.mockImplementationOnce(async (_cmd, _cfg, opts) => {
          await gate.wait(opts.signal);
          return {
            ok: false,
            output: '',
            error: 'run cancelled',
            terminationReason: 'cancelled',
          };
        });
        return runEngineSandboxed('claude', 'remain blocked until cancelled', cfg, {
          sourceRepo: repo.dir,
          propose: true,
          signal: controller.signal,
        });
      },
    },
    {
      label: 'API-model agent',
      start: (repo, cfg, controller, gate) => {
        runTaskMock.mockImplementationOnce(async (task: RunTask, _client, ctx) => {
          await gate.wait(ctx.signal);
          return task;
        });
        return runApiModelSandboxed('local-coder', 'remain blocked until cancelled', cfg, {
          sourceRepo: repo.dir,
          propose: true,
          signal: controller.signal,
        });
      },
    },
  ];

  // V3.10 U6: an agent no longer HOLDS the outward fence across inference (that
  // capped the machine at one agent); it holds a shared execution lease that
  // kill aborts and waits for. The guarantee this suite pins is unchanged —
  // kill cannot report quiescence while an agent admitted before it is still
  // running, and that agent files nothing. V3.10 INT4: the agent still
  // removes its OWN throwaway worktree under KILL (a removal right minted at
  // admission, while KILL was off); nothing else is cleaned up under KILL.
  it.each(cases)('$label: kill cannot quiesce while its execution lease is live, and it files nothing', async ({ start }) => {
    await withTmpHome(async (fx) => withAnyRepoAllowed(async () => {
      const controller = new AbortController();
      const gate = abortGate();
      let running: Promise<SandboxedEngineResult> | undefined;

      try {
        prepareAuthorityRoots();
        const repo = fx.makeRepo();
        repo.enroll();
        const before = sourceSnapshot(repo);
        running = start(repo, makeConfig(), controller, gate);
        await awaitProducerEntry(gate, running);

        expect(listSandboxes()).toHaveLength(1);
        expect(listProposals()).toEqual([]);
        expect(setKill(true, { waitMs: 25 })).toEqual({
          ok: false,
          changed: true,
          quiesced: false,
          reason: 'kill armed; an outward mutation has not quiesced',
        });
        expect(killSwitchOn()).toBe(true);

        controller.abort();
        const result = await running;

        expect(result.state).toMatchObject({
          status: 'aborted',
          terminationReason: 'cancelled',
        });
        expect(result).not.toHaveProperty('proposalId');
        expect(result).not.toHaveProperty('proposalDraft');
        expect(result).not.toHaveProperty('proposalOutcome');
        expect(listProposals()).toEqual([]);
        // The run has ended, so its lease is gone and kill now quiesces.
        expect(countLiveExecutionLeases()).toBe(0);
        expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });

        // V3.10 (INT4, B-U6 request 6): a run admitted before KILL removes
        // its OWN worktree even under KILL (its removal right was minted at
        // admission). It used to be stranded until resume / the orphan sweep.
        // The source branch and tree were never touched.
        expect(listSandboxes()).toEqual([]);
        expect(repo.currentBranch()).toBe(before.branch);
        expect(repo.shasumTree()).toBe(before.tree);
        expect(repo.gitStatus()).toBe(before.status);

        expect(setKill(false, { waitMs: 500 })).toMatchObject({
          ok: true,
          quiesced: true,
        });
        expect(killSwitchOn()).toBe(false);
        expect(listSandboxes()).toEqual([]);
        expect(sourceSnapshot(repo)).toEqual(before);
      } finally {
        controller.abort();
        await running?.catch(() => undefined);
        setKill(false, { waitMs: 500 });
      }
    }));
  }, 15_000);

  it('reports actual producer cancellation before mock entry and restores the fixture flag', async () => {
    const previous = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
    await withTmpHome(async (fx) => {
      const controller = new AbortController();
      controller.abort();
      let running: Promise<SandboxedEngineResult> | undefined;
      await expect(withAnyRepoAllowed(async () => {
        try {
          running = runEngineSandboxed('claude', 'remain blocked until cancelled', makeConfig(), {
            sourceRepo: fx.home,
            propose: true,
            signal: controller.signal,
          });
          await awaitProducerEntry(abortGate(), running);
        } finally {
          controller.abort();
          await running?.catch(() => undefined);
        }
      })).rejects.toThrow('producer completed before mock entry');
      expect((await running!).state).toMatchObject({ status: 'aborted', terminationReason: 'cancelled' });
      expect(spawnEngineMock).not.toHaveBeenCalled();
      expect(countLiveExecutionLeases()).toBe(0);
      expect(listSandboxes()).toEqual([]);
      expect(listProposals()).toEqual([]);
      expect(process.env.ASHLR_TEST_ALLOW_ANY_REPO).toBe(previous);
      await expect(awaitProducerEntry(abortGate(), Promise.reject(new Error('fixture rejection'))))
        .rejects.toThrow('producer rejected before mock entry');
    });
  }, 15_000);

  it.each([undefined, 'fixture-previous'])('restores prior fixture flag %s when setup throws', async (previous) => {
    const original = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
    try {
      if (previous === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      else process.env.ASHLR_TEST_ALLOW_ANY_REPO = previous;
      await expect(withAnyRepoAllowed(async () => {
        expect(process.env.ASHLR_TEST_ALLOW_ANY_REPO).toBe('1');
        throw new Error('fixture setup refused');
      })).rejects.toThrow('fixture setup refused');
      expect(process.env.ASHLR_TEST_ALLOW_ANY_REPO).toBe(previous);
    } finally {
      if (original === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
      else process.env.ASHLR_TEST_ALLOW_ANY_REPO = original;
    }
  });
});
