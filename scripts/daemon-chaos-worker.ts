/**
 * One simulated agent (or one simulated daemon restart) for scripts/daemon-chaos.mjs.
 *
 * Agent mode walks the same primitives as scripts/daemon-throughput-worker.ts
 * (shared queue claim, run authority, repo lease -> createSandboxAsync,
 * admission, fake engine, proposal filing, sandbox removal, terminal run
 * record) and then, optionally, verifies the filed proposal in an inbox temp
 * worktree (inbox/merge.ts verifyProposal: `vwt-*` under ~/.ashlr/tmp). It then
 * approves and applies the proposal (inbox/apply.ts: a `wt-*` worktree and a
 * `patch-*.diff` file under ~/.ashlr/tmp, output branch `ashlr/proposal/<id>`)
 * and opens a fleet scratch repository over the repo's objects
 * (fleet/host-merge.ts openGitScratch: `fleet-git-*`). It prints `PHASE <name>` on stdout as it enters each phase so the harness can
 * SIGKILL it at a chosen point. No model, no network, no credentials.
 *
 * Restart mode runs the crash-recovery work runDaemon does at start, in the
 * same order and with the same arguments (src/core/daemon/loop.ts, after the
 * activation checks): the orphan sandbox sweep with ORPHAN_STALE_MS, the
 * leaked temp-worktree sweep, the tmp scratch sweep and the read-only stale git
 * lock report. The harness cannot start the real resident
 * daemon (it needs trusted activation roots), so it calls exactly what that
 * start calls.
 *
 * Usage:
 *   node --import tsx scripts/daemon-chaos-worker.ts --setup <repo>
 *   node --import tsx scripts/daemon-chaos-worker.ts --restart
 *   node --import tsx scripts/daemon-chaos-worker.ts --probe <queueDir> <local|shared> [aged]
 *   node --import tsx scripts/daemon-chaos-worker.ts <repo> <queueDir> <idx> <itemCount> <thinkMs> <verify:0|1> <local|shared>
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SharedStore } from '../src/core/fleet/shared-store.js';
import { LocalWorkQueueCoordinator, SharedWorkQueueCoordinator } from '../src/core/seams/work-queue-coordinator.js';
import {
  acquireExecutionAuthority,
  beginExecutionAuthority,
  finishExecutionAuthority,
  abandonExecutionAuthority,
} from '../src/core/util/execution-lease.js';
import { saveRun } from '../src/core/run/orchestrator.js';
import { newUsage } from '../src/core/run/budget.js';
import * as wt from '../src/core/sandbox/worktree.js';
import {
  acquireOutwardMutationFenceAsync,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
  type OutwardMutationFence,
} from '../src/core/sandbox/mutation-fence.js';
import { acquireRepoLease, registerExecutionLease, type ExecutionLease, type RepoLease } from '../src/core/sandbox/execution-leases.js';
import { assertMayMutate, canonicalEnrollmentPath, enroll } from '../src/core/sandbox/policy.js';
import { createProposal, setStatus } from '../src/core/inbox/store.js';
import type { RunState, Sandbox } from '../src/core/types.js';

const ADMIT_FENCE_WAIT_MS = 60_000;
const FENCE_REACQUIRE_WAIT_MS = 120_000;

function phase(name: string): void {
  process.stdout.write(`PHASE ${name}\n`);
}

function emit(result: Record<string, unknown>): void {
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
}

async function agent(argv: string[]): Promise<void> {
  const [repo, queueDir, idxRaw, itemCountRaw, thinkRaw, verifyRaw, queueMode] = argv;
  const idx = Number(idxRaw);
  const itemCount = Number(itemCountRaw);
  const thinkMs = Number(thinkRaw ?? '0');
  const verify = verifyRaw === '1';
  const machineId = `chaos-${process.pid}`;

  phase('queueClaim');
  // `local` is the single-machine default (selectWorkQueueCoordinator without
  // fleet.sharedQueue); `shared` is the multi-machine filesystem queue.
  const coord = queueMode === 'shared'
    ? new SharedWorkQueueCoordinator(new SharedStore(queueDir!, 5 * 60_000), machineId, 5 * 60_000, true)
    : new LocalWorkQueueCoordinator();
  const candidates = Array.from({ length: itemCount }, (_, i) => {
    const id = `chaos-item-${process.pid}-${(i + idx) % itemCount}`;
    return { id, repo, title: id, source: 'chaos', score: 1 } as never;
  });
  const claimed = await coord.claimItems(candidates, 1, machineId) as Array<{ id: string }>;
  if (claimed.length === 0) return emit({ idx, ok: false, failure: 'queue-claim-empty' });
  const itemId = claimed[0]!.id;
  if (!(await coord.beginExecution(itemId, machineId))) return emit({ idx, ok: false, failure: 'queue-begin-refused' });

  phase('runAuthority');
  const runId = `run-chaos-${Date.now().toString(36)}-${process.pid}-${idx}`;
  const acquired = acquireExecutionAuthority('run', runId);
  if (!acquired.ok) return emit({ idx, ok: false, failure: `run-authority-${acquired.reason}` });
  if (!beginExecutionAuthority(acquired.authority)) {
    abandonExecutionAuthority(acquired.authority);
    return emit({ idx, ok: false, failure: 'run-authority-begin' });
  }
  const now = new Date().toISOString();
  const state: RunState = {
    id: runId, goal: `chaos ${idx}`, engine: 'codex', provider: 'external', createdAt: now, updatedAt: now,
    budget: { maxTokens: 0, maxSteps: 0, allowCloud: false }, usage: newUsage(), tasks: [], steps: [], status: 'running',
  } as RunState;
  saveRun(state);

  const repoKey = canonicalEnrollmentPath(repo!) ?? repo!;
  let sb: Sandbox | null = null;
  let fence: OutwardMutationFence | null = null;
  let lease: ExecutionLease | null = null;
  let captureLease: RepoLease | null = null;
  let failure: string | null = null;
  let proposal: Awaited<ReturnType<typeof createProposal>> | null = null;
  try {
    phase('sandboxCreate');
    const creation = await acquireRepoLease(repoKey);
    if (!creation.ok) throw new Error(`repo-lease-create: ${creation.reason}`);
    try {
      sb = await wt.createSandboxAsync(repo!, { repoLease: creation.lease });
    } finally { creation.lease.release(); }

    phase('admit');
    fence = await acquireOutwardMutationFenceAsync(ADMIT_FENCE_WAIT_MS);
    if (!ownsOutwardMutationFence(fence)) { fence = null; throw new Error('fence-admit-unavailable'); }
    assertMayMutate(repo!);
    if (!wt.borrowSandboxCleanupAuthority(fence)) throw new Error('cleanup-authority-admit');
    const reg = registerExecutionLease(fence, { runId, repoKey, engine: 'codex' });
    if (!reg.ok) throw new Error(`execution-lease: ${reg.reason}`);
    lease = reg.lease;
    releaseOutwardMutationFence(fence); fence = null;

    phase('engine');
    writeFileSync(join(sb.worktreePath, `agent-${process.pid}-${idx}.txt`), `agent ${idx} was here\n`);
    if (thinkMs > 0) await new Promise((r) => setTimeout(r, thinkMs));
    const diff = wt.sandboxDiff(sb);

    phase('settle');
    const leased = await acquireRepoLease(repoKey, { waitMs: FENCE_REACQUIRE_WAIT_MS });
    if (!leased.ok) throw new Error(`repo-lease-file: ${leased.reason}`);
    captureLease = leased.lease;
    fence = await acquireOutwardMutationFenceAsync(FENCE_REACQUIRE_WAIT_MS);
    if (!ownsOutwardMutationFence(fence)) { fence = null; throw new Error('fence-file-unavailable'); }
    assertMayMutate(repo!);
    const cleanup = wt.borrowSandboxCleanupAuthority(fence);
    if (!cleanup) throw new Error('cleanup-authority-file');
    proposal = createProposal({
      repo, origin: 'agent', kind: 'patch', title: `chaos agent ${idx}`, summary: 'chaos harness',
      diff: diff.patch, sandboxId: sb.id, workItemId: itemId, workSource: 'chaos', runId,
    } as never);
    if (proposal.status !== 'pending') throw new Error(`proposal-${proposal.status}`);
    phase('sandboxRemove');
    const removed = wt.removeSandboxWithBorrowedAuthority(sb, cleanup);
    if (removed.status !== 'complete') failure = `sandbox-remove-${removed.status}: ${removed.failureClasses.join(',')}`;
  } catch (e) {
    failure = (e as Error).message;
    if (sb) {
      if (fence) { releaseOutwardMutationFence(fence); fence = null; }
      try { await wt.removeSandboxAsync(sb, {}); } catch { /* the orphan sweep owns it now */ }
    }
  } finally {
    if (fence) releaseOutwardMutationFence(fence);
    captureLease?.release();
    lease?.release();
  }

  phase('runTerminal');
  state.status = failure ? 'failed' : 'done';
  state.updatedAt = new Date().toISOString();
  saveRun(state);
  finishExecutionAuthority(acquired.authority);
  await coord.recordOutcome(itemId, failure ? 'empty' : 'diff', machineId);

  if (verify && proposal && !failure) {
    phase('verify');
    const { verifyProposal } = await import('../src/core/inbox/merge.js');
    const verdict = await verifyProposal(proposal, { version: 1 } as never);
    if (!verdict.ok) failure = `verify: ${verdict.detail}`;
  }

  if (proposal && !failure) {
    phase('apply');
    if (!setStatus(proposal.id, 'approved')) failure = 'apply: approve refused';
    else {
      const { applyProposal } = await import('../src/core/inbox/apply.js');
      const applied = await applyProposal(proposal.id, { confirmed: true });
      if (!applied.ok) failure = `apply: ${applied.detail}`;
    }
  }

  if (!failure) {
    phase('fleetScratch');
    const { openGitScratch, closeGitScratch } = await import('../src/core/fleet/host-merge.js');
    const scratch = openGitScratch(repo!);
    if (typeof scratch === 'string') failure = `fleet-scratch: ${scratch}`;
    else {
      try {
        // Read the borrowed objects the way a host merge does, then linger so
        // a kill can land while the scratch repository exists.
        execFileSync('git', ['count-objects', '-v'], { env: scratch.env, stdio: 'pipe' });
        if (thinkMs > 0) await new Promise((r) => setTimeout(r, thinkMs));
      } catch (e) {
        failure = `fleet-scratch: ${(e as Error).message}`;
      } finally {
        closeGitScratch(scratch);
      }
    }
  }
  phase('done');
  emit({ idx, ok: failure === null, failure });
}

async function restart(): Promise<void> {
  // Same calls, same order, same arguments as runDaemon's non-dry start.
  const started = Date.now();
  const sweep = wt.sweepOrphanSandboxesDetailed({ staleMs: wt.ORPHAN_STALE_MS });
  const reaper = await import('../src/core/inbox/temp-worktree-reaper.js');
  const temp = await reaper.sweepLeakedTempWorktreesAtStart();
  const scratch = reaper.sweepLeakedTmpScratch();
  const { readGitLockHealth } = await import('../src/core/readiness.js');
  const { locks } = readGitLockHealth();
  emit({
    restartMs: Date.now() - started,
    orphanSweep: {
      completed: sweep.completed.length, residual: sweep.residual.length, refused: sweep.refused.length,
      unavailable: sweep.unavailable.length, unexpectedErrors: sweep.unexpectedErrors.length,
      malformedHomes: sweep.inventory.malformedHomes, unsafeEntries: sweep.inventory.unsafeEntries,
    },
    tempSweep: temp,
    scratchSweep: { reaped: scratch.reaped.length, kept: scratch.kept.length, failed: scratch.failed.length },
    staleGitLocks: locks.length,
  });
}

function probe(queueDir: string, queueMode: string, aged: boolean): void {
  // The next tick's first queue operations: a fresh claim and an outcome record.
  // `aged` runs them as if the restart came after every stale-lock window
  // (2x the lease): what still fails then never recovers on its own.
  if (aged) {
    const realNow = Date.now.bind(Date);
    Date.now = () => realNow() + 2 * 5 * 60_000 + 60_000;
  }
  const machineId = `chaos-probe-${process.pid}`;
  const id = `chaos-probe-${process.pid}-${Date.now()}`;
  const coord = queueMode === 'shared'
    ? new SharedWorkQueueCoordinator(new SharedStore(queueDir, 5 * 60_000), machineId, 5 * 60_000, true)
    : new LocalWorkQueueCoordinator();
  const claimed = coord.claimItems([{ id, title: id, source: 'chaos', score: 1 } as never], 1, machineId);
  const recorded = claimed.length === 1 && coord.recordOutcome(id, 'empty', machineId);
  emit({ claimed: claimed.length === 1 && recorded === true });
}

const argv = process.argv.slice(2);
if (argv[0] === '--setup') {
  const r = enroll(argv[1]!);
  emit(r as never);
  process.exit(r.ok ? 0 : 1);
} else if (argv[0] === '--probe') {
  probe(argv[1]!, argv[2] ?? 'local', argv[3] === 'aged');
} else if (argv[0] === '--restart') {
  restart().catch((e) => { emit({ crash: (e as Error).message }); process.exitCode = 1; });
} else {
  agent(argv).catch((e) => emit({ ok: false, failure: `crash: ${(e as Error).message}` }));
}
