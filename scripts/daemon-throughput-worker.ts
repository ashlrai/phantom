/**
 * One simulated autonomous agent for scripts/daemon-throughput.mjs.
 *
 * Runs in its own OS process with HOME pointed at the harness's temp HOME and
 * walks the same shared-state primitives a daemon-dispatched sandboxed
 * producer touches (src/core/daemon/loop.ts -> runGoal -> runEngineSandboxed),
 * in the same lock order, with a FAKE engine: no model, no network, no
 * credentials. Prints one JSON line to stdout and exits 0 either way.
 *
 * Usage: node --import tsx scripts/daemon-throughput-worker.ts <repo> <queueDir> <agentIndex> <itemCount> <thinkMs>
 *        node --import tsx scripts/daemon-throughput-worker.ts --setup <repo>   (enroll the temp repo)
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SharedStore } from '../src/core/fleet/shared-store.js';
import { SharedWorkQueueCoordinator } from '../src/core/seams/work-queue-coordinator.js';
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
import { assertMayMutate, canonicalEnrollmentPath } from '../src/core/sandbox/policy.js';
import { createProposal } from '../src/core/inbox/store.js';
import { enroll } from '../src/core/sandbox/policy.js';
import type { RunState, Sandbox } from '../src/core/types.js';

// Same waits as src/core/run/sandboxed-engine.ts (ADMIT_FENCE_WAIT_MS, FENCE_REACQUIRE_WAIT_MS).
const ADMIT_FENCE_WAIT_MS = 60_000;
const FENCE_REACQUIRE_WAIT_MS = 120_000;

const [repo, queueDir, idxRaw, itemCountRaw, thinkRaw] = process.argv.slice(2);
const idx = Number(idxRaw);
const itemCount = Number(itemCountRaw);
const thinkMs = Number(thinkRaw ?? '0');
const machineId = `bench-${process.pid}`;
const phases: Record<string, number> = {};
const t0 = performance.now();

async function timed<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const s = performance.now();
  try { return await fn(); } finally { phases[name] = (phases[name] ?? 0) + (performance.now() - s); }
}

function emit(ok: boolean, failure: string | null, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({
    idx, ok, failure, totalMs: performance.now() - t0, phases,
    maxRssKb: process.resourceUsage().maxRSS, ...extra,
  })}\n`);
}

async function main(): Promise<void> {
  // 1. Shared fleet queue claim (fleet/shared-store.ts). Each agent offers the
  //    whole backlog, rotated so agents prefer different items, and takes one.
  const store = new SharedStore(queueDir, 5 * 60_000);
  const coord = new SharedWorkQueueCoordinator(store, machineId, 5 * 60_000, true);
  const candidates = Array.from({ length: itemCount }, (_, i) => {
    const id = `bench-item-${(i + idx) % itemCount}`;
    return { id, repo, title: id, source: 'bench', score: 1 } as never;
  });
  const claimed = await timed('queueClaim', () => coord.claimItems(candidates, 1, machineId)) as Array<{ id: string }>;
  if (claimed.length === 0) return emit(false, 'queue-claim-empty');
  const itemId = claimed[0]!.id;
  if (!(await timed('queueBegin', () => coord.beginExecution(itemId, machineId)))) {
    return emit(false, 'queue-begin-execution-refused');
  }

  // 2. Run execution authority + initial run record (run/orchestrator.ts runGoal).
  const runId = `run-bench-${Date.now().toString(36)}-${idx}`;
  const acquired = await timed('runAuthority', () => acquireExecutionAuthority('run', runId));
  if (!acquired.ok) return emit(false, `run-authority-${acquired.reason}`);
  if (!beginExecutionAuthority(acquired.authority)) {
    abandonExecutionAuthority(acquired.authority);
    return emit(false, 'run-authority-begin');
  }
  const now = new Date().toISOString();
  const state: RunState = {
    id: runId, goal: `bench ${idx}`, engine: 'codex', provider: 'external', createdAt: now, updatedAt: now,
    budget: { maxTokens: 0, maxSteps: 0, allowCloud: false }, usage: newUsage(), tasks: [], steps: [], status: 'running',
  } as RunState;
  try {
    await timed('runSave', () => saveRun(state));
  } catch (e) {
    abandonExecutionAuthority(acquired.authority);
    return emit(false, `run-save: ${(e as Error).message}`);
  }

  const repoKey = canonicalEnrollmentPath(repo) ?? repo;
  let sb: Sandbox | null = null;
  let fence: OutwardMutationFence | null = null;
  let lease: ExecutionLease | null = null;
  let captureLease: RepoLease | null = null;
  let failure: string | null = null;
  let proposalId: string | null = null;
  try {
    // 3. Worktree creation under the repo lease (runEngineSandboxed).
    const creation = await timed('repoLeaseWaitCreate', () => acquireRepoLease(repoKey));
    if (!creation.ok) throw new Error(`repo-lease-create: ${creation.reason}`);
    try {
      sb = await timed('sandboxCreate', () => wt.createSandboxAsync(repo));
    } finally { creation.lease.release(); }

    // 4. Admission: fence -> policy gate -> cleanup authority -> execution lease; drop fence.
    fence = await timed('fenceWaitAdmit', () => acquireOutwardMutationFenceAsync(ADMIT_FENCE_WAIT_MS));
    if (!ownsOutwardMutationFence(fence)) { fence = null; throw new Error('fence-admit-unavailable'); }
    assertMayMutate(repo);
    if (!wt.borrowSandboxCleanupAuthority(fence)) throw new Error('cleanup-authority-admit');
    const reg = registerExecutionLease(fence, { runId, repoKey, engine: 'codex' });
    if (!reg.ok) throw new Error(`execution-lease: ${reg.reason}`);
    lease = reg.lease;
    releaseOutwardMutationFence(fence); fence = null;

    // 5. Fake engine: edit one file in the sandbox and finish.
    await timed('engine', async () => {
      writeFileSync(join(sb!.worktreePath, `agent-${idx}.txt`), `agent ${idx} was here\n`);
      if (thinkMs > 0) await new Promise((r) => setTimeout(r, thinkMs));
    });
    const diff = await timed('sandboxDiff', () => wt.sandboxDiff(sb!));

    // 6. Reacquire for filing: repo lease -> fence -> gate (ProducerAuthority.reacquire).
    const leased = await timed('repoLeaseWaitFile', () => acquireRepoLease(repoKey, { waitMs: FENCE_REACQUIRE_WAIT_MS }));
    if (!leased.ok) throw new Error(`repo-lease-file: ${leased.reason}`);
    captureLease = leased.lease;
    fence = await timed('fenceWaitFile', () => acquireOutwardMutationFenceAsync(FENCE_REACQUIRE_WAIT_MS));
    if (!ownsOutwardMutationFence(fence)) { fence = null; throw new Error('fence-file-unavailable'); }
    assertMayMutate(repo);
    const cleanup = wt.borrowSandboxCleanupAuthority(fence);
    if (!cleanup) throw new Error('cleanup-authority-file');

    // 7. File the proposal (inbox/store.ts createProposal) and remove the worktree.
    const proposal = await timed('proposalCreate', () => createProposal({
      repo, origin: 'agent', kind: 'patch', title: `bench agent ${idx}`, summary: 'throughput harness',
      diff: diff.patch, sandboxId: sb!.id, workItemId: itemId, workSource: 'bench', runId,
    } as never));
    if (proposal.status !== 'pending') throw new Error(`proposal-${proposal.status}: ${proposal.decisionReason ?? ''}`);
    proposalId = proposal.id;
    const removed = await timed('sandboxRemove', () => wt.removeSandboxWithBorrowedAuthority(sb!, cleanup));
    if (removed.status !== 'complete') failure = `sandbox-remove-${removed.status}: ${removed.failureClasses.join(',')}`;
  } catch (e) {
    failure = (e as Error).message;
    if (sb) {
      if (fence) { releaseOutwardMutationFence(fence); fence = null; }
      try { await wt.removeSandboxAsync(sb, {}); } catch { /* orphan sweep */ }
    }
  } finally {
    if (fence) releaseOutwardMutationFence(fence);
    captureLease?.release();
    lease?.release();
  }

  // 8. Terminal run record + queue outcome.
  try {
    state.status = failure ? 'failed' : 'done';
    state.updatedAt = new Date().toISOString();
    await timed('runSave', () => saveRun(state));
    finishExecutionAuthority(acquired.authority);
  } catch (e) {
    abandonExecutionAuthority(acquired.authority);
    failure ??= `run-save-terminal: ${(e as Error).message}`;
  }
  const recorded = await timed('queueComplete', () => coord.recordOutcome(itemId, failure ? 'empty' : 'diff', machineId));
  if (!recorded) failure ??= 'queue-complete-refused';
  emit(failure === null, failure, { proposalId });
}

if (process.argv[2] === '--setup') {
  const r = enroll(process.argv[3]!);
  process.stdout.write(`${JSON.stringify(r)}\n`);
  process.exit(r.ok ? 0 : 1);
} else {
  main().catch((e) => emit(false, `crash: ${(e as Error).message}`));
}
