/**
 * simple-conductor.ts — M280: SIMPLE-CONDUCTOR (Path A).
 *
 * Reads the flat ~/.ashlr/tasks.json queue, claims one exact task generation
 * durably before dispatch, reconciles signed pending proposal authority, and
 * runs runAutoMergePass after bounded work completes.
 *
 * SAFETY CONTRACT (non-negotiable):
 *  - killSwitchOn() checked first — if on, returns zeros immediately.
 *  - assertMayMutate(task.repo) called before EVERY dispatch — unenrolled/kill
 *    skips + logs (never-throws per task).
 *  - One durable generation-bound lease prevents concurrent duplicate dispatch.
 *  - Candidate proposal ids are retained and reconciled before any redispatch.
 *  - done:true requires signed pending authority or a provenance-valid owned lifecycle record.
 *  - Malformed or unreadable task state fails closed and is reported.
 *  - done:true tasks are always skipped.
 *  - dryRun: records intent, dispatches NOTHING, writes nothing.
 *  - maxTasksPerCycle (default 3) bounds dispatches per tick.
 *  - All merge safety (judge/gate/completeness/verification) is UNCHANGED —
 *    runAutoMergePass handles it; nothing is bypassed here.
 *  - Every claimed engine call consumes an attempt and cycle slot, including throws.
 *  - Resource-aware dispatch (M300) picks the engine BEFORE the claim; when
 *    every candidate is exhausted/unreachable the task is deferred unclaimed
 *    (no attempt, no sandbox) and reported in result.deferred.
 *  - never-throws per task (catch -> durable failure settlement -> continue).
 *  - Flag off (cfg.foundry.simpleConductor !== true) ⇒ this module is never
 *    imported; loop.ts uses the old runConductor (byte-identical).
 *
 * CI session isolation (opt-in via LOCUS_CI_BINDING / LOCUS_BINDING):
 *   When configured, each task dispatch mints an ephemeral Locus pin and
 *   captures LOCUS_* in a private job environment so sandboxed engines inherit the sealed
 *   session. LOCUS_ENFORCE=enforce without a binding refuses as result.errors
 *   (never throws). Default (unset binding + enforce off) is a no-op.
 *   Does not add a second pre-mutate gate — that lives on spawnEngine /
 *   runApiModelSandboxed only.
 */

import type { AshlrConfig, EngineId, Proposal } from './types.js';
import type {
  BackendAvailability,
  BackendResourceState,
  ResourceSnapshot,
} from './fabric/resource-monitor.js';
import type { SandboxedEngineResult } from './run/sandboxed-engine.js';
import type { AuthoritativePendingProposalExpectation } from './inbox/pending-authority.js';
import { isSafeExecutionIdentity } from './fleet/attempt-identity.js';
import { buildTaskBrief } from './teams/context.js';
import {
  LocusMintError,
  LocusSessionConfigError,
  runWithLocusSessionIfConfigured,
} from './integrations/locus.js';
import {
  claimSimpleConductorTask,
  readSimpleConductorTasks,
  reconcileSimpleConductorTask,
  settleSimpleConductorTask,
  simpleConductorTaskGenerationId,
  type TaskSpec,
} from './simple-conductor-task-store.js';

export type { TaskSpec } from './simple-conductor-task-store.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result returned by runSimpleConductor. */
export interface SimpleConductorResult {
  tasksAttempted: number;
  proposalsFiled: number;
  proposalsRecovered: number;
  merged: number;
  errors: Array<{ taskId: string; error: string }>;
  killSwitchTripped: boolean;
  activationRefused?: boolean;
  taskStoreUnavailable?: boolean;
  /**
   * M300: tasks left queued this tick because no candidate engine (the task's
   * engine plus engineFallbackOrder) had usable capacity. A deferred task is
   * not claimed: attempts, lease and retryAfter are unchanged, and it is not
   * counted in tasksAttempted or errors. Absent when nothing was deferred.
   */
  deferred?: SimpleConductorDeferral[];
}

/** M300: one task the resource-aware dispatcher declined to run this tick. */
export interface SimpleConductorDeferral {
  taskId: string;
  /** The engine the task asked for (before any fallback). */
  engine: EngineId;
  /** Human-readable reason naming each candidate engine and its availability. */
  reason: string;
  /**
   * ISO time of the earliest known reset among the candidate engines, when the
   * resource snapshot carries one. A candidate with no known reset may reopen
   * sooner, so this is a hint for scheduling the next tick, not a promise.
   */
  earliestResetAt?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MAX_TASKS_PER_CYCLE = 3;
const CAPTURE_RECONCILIATION_DELAY_MS = 15 * 60_000;
const FAILURE_COOLDOWN_AFTER_ATTEMPTS = 3;

type PendingAuthorityVerifier = (
  proposal: Proposal | null | undefined,
  expected: AuthoritativePendingProposalExpectation,
  cfg?: Pick<AshlrConfig, 'foundry'>,
) => boolean;

function authorityExpectation(
  task: TaskSpec,
  generationId: string,
  proposalId: string,
  runId?: string,
): AuthoritativePendingProposalExpectation {
  return {
    id: proposalId,
    repo: task.repo,
    origin: 'agent',
    kind: 'patch',
    workItemId: task.id,
    workItemGenerationId: generationId,
    isPartial: false,
    ...(runId ? { runId, trajectoryId: `run:${runId}` } : {}),
  };
}

function isAuthoritativePending(
  task: TaskSpec,
  generationId: string,
  proposalId: string,
  proposal: Proposal | null | undefined,
  cfg: AshlrConfig,
  verify: PendingAuthorityVerifier,
  runId?: string,
): boolean {
  return verify(
    proposal,
    authorityExpectation(task, generationId, proposalId, runId),
    cfg,
  );
}

function belongsToTaskGeneration(
  proposal: Proposal,
  task: TaskSpec,
  generationId: string,
): boolean {
  return proposal.workItemId === task.id &&
    proposal.workItemGenerationId === generationId &&
    proposal.repo === task.repo;
}

function resultCandidateId(result: SandboxedEngineResult): string | undefined {
  if (isSafeExecutionIdentity(result.proposalId)) return result.proposalId;
  return isSafeExecutionIdentity(result.candidateProposalId)
    ? result.candidateProposalId
    : undefined;
}

function retryAfterForFailure(attempts: number, alwaysCool = false): string | undefined {
  if (!alwaysCool && attempts < FAILURE_COOLDOWN_AFTER_ATTEMPTS) return undefined;
  const exponent = Math.max(0, Math.min(8, attempts - FAILURE_COOLDOWN_AFTER_ATTEMPTS));
  return new Date(Date.now() + CAPTURE_RECONCILIATION_DELAY_MS * 2 ** exponent).toISOString();
}

// ---------------------------------------------------------------------------
// M300: resource-aware engine planning
// ---------------------------------------------------------------------------

/** M300: outcome of planEngineDispatch. */
export type EnginePlan =
  | { kind: 'dispatch'; engine: EngineId; note?: string }
  | { kind: 'defer'; reason: string; earliestResetAt?: string };

/**
 * Hard-unavailable states: a dispatch would fail (rate limit or dead local
 * runtime), burning an attempt and a sandbox. Per BackendAvailability,
 * 'exhausted' is >= 100% of cap or a recent 429, and 'unreachable' is a failed
 * health check.
 */
const HARD_UNAVAILABLE = new Set<BackendAvailability>(['exhausted', 'unreachable']);
/**
 * Soft-unavailable: 'throttled' means the backend still accepts work but is
 * deliberately held back at protectPct to keep headroom. Any open backend is
 * preferred; when none exists a throttled one is still used, because the call
 * succeeds and stalling the whole queue at protectPct would be worse.
 */
const SOFT_UNAVAILABLE = new Set<BackendAvailability>(['throttled']);

/**
 * M300: choose the engine for one task from a resource snapshot. Pure; never
 * throws.
 *  1. The requested engine when it is not exhausted, throttled or unreachable
 *     (open, near, unknown, or absent from the snapshot: fail open).
 *  2. The first fallback in that same usable state.
 *  3. The requested engine, then the first fallback, that is only throttled.
 *  4. Otherwise defer: every candidate is exhausted or unreachable. The plan
 *     carries the earliest known future reset among the candidates.
 */
export function planEngineDispatch(
  requestedEngine: EngineId,
  fallbackOrder: readonly string[],
  snapshot: Pick<ResourceSnapshot, 'backends'>,
  nowMs = Date.now(),
): EnginePlan {
  const stateOf = (engine: string): BackendResourceState | undefined =>
    snapshot.backends.find((b) => b.backend === engine);
  const availabilityOf = (engine: string): BackendAvailability =>
    stateOf(engine)?.availability ?? 'unknown';
  const usable = (engine: string): boolean => {
    const avail = availabilityOf(engine);
    return !HARD_UNAVAILABLE.has(avail) && !SOFT_UNAVAILABLE.has(avail);
  };

  if (usable(requestedEngine)) return { kind: 'dispatch', engine: requestedEngine };

  const candidates: string[] = [requestedEngine];
  for (const candidate of fallbackOrder) {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  const requestedAvail = availabilityOf(requestedEngine);

  for (const candidate of candidates.slice(1)) {
    if (usable(candidate)) {
      return {
        kind: 'dispatch',
        engine: candidate as EngineId,
        note: `${requestedEngine} ${requestedAvail}; ${candidate} ${availabilityOf(candidate)}`,
      };
    }
  }

  for (const candidate of candidates) {
    if (SOFT_UNAVAILABLE.has(availabilityOf(candidate))) {
      return {
        kind: 'dispatch',
        engine: candidate as EngineId,
        note: candidate === requestedEngine
          ? `${requestedEngine} throttled; no open fallback`
          : `${requestedEngine} ${requestedAvail}; no open fallback; ${candidate} throttled`,
      };
    }
  }

  let earliestMs: number | null = null;
  for (const candidate of candidates) {
    const state = stateOf(candidate);
    if (!state) continue;
    const known = [
      state.backoffUntilMs,
      typeof state.resetsAt === 'number' ? state.resetsAt * 1000 : null,
    ].filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (known.length === 0) continue;
    const reopensMs = Math.max(...known);
    if (reopensMs <= nowMs) continue;
    if (earliestMs === null || reopensMs < earliestMs) earliestMs = reopensMs;
  }

  return {
    kind: 'defer',
    reason: 'resource-pause: no candidate engine has capacity (' +
      candidates.map((c) => `${c} ${availabilityOf(c)}`).join(', ') + ')',
    ...(earliestMs !== null ? { earliestResetAt: new Date(earliestMs).toISOString() } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run one tick of the simple-conductor:
 *  1. Kill-switch check.
 *  2. Load + sort the fail-closed transactional task store.
 *  3. Reconcile known proposal candidates or claim and dispatch ready tasks.
 *  4. runAutoMergePass so filed proposals get judged + merged this tick.
 */
export async function runSimpleConductor(
  cfg: AshlrConfig,
  opts: { once: boolean; dryRun: boolean; allowCloud: boolean },
): Promise<SimpleConductorResult> {
  const result: SimpleConductorResult = {
    tasksAttempted: 0,
    proposalsFiled: 0,
    proposalsRecovered: 0,
    merged: 0,
    errors: [],
    killSwitchTripped: false,
  };

  if (!opts.dryRun) {
    const { liveConductorActivationAuthorized } = await import('./daemon/activation-permit.js');
    if (!liveConductorActivationAuthorized()) {
      result.activationRefused = true;
      return result;
    }
  }

  // 1. Kill-switch check.
  const { killSwitchOn } = await import('./sandbox/policy.js');
  if (killSwitchOn()) {
    result.killSwitchTripped = true;
    return result;
  }

  // 2. Load tasks.
  const taskRead = readSimpleConductorTasks();
  if (!taskRead.ok) {
    result.taskStoreUnavailable = true;
    result.errors.push({ taskId: 'task-store', error: taskRead.reason });
    return result;
  }
  let tasks = taskRead.tasks;
  if (tasks.length === 0) return result;

  // Sort: higher priority first; stable-sort preserves file order for ties.
  tasks = [...tasks].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  // 3. Dispatch ready tasks (bounded by maxTasksPerCycle).
  const { assertMayMutate } = await import('./sandbox/policy.js');
  const { runEngineSandboxed, runApiModelSandboxed } = await import('./run/sandboxed-engine.js');
  const { ensureProposalInbox, listProposalsDetailed } = await import('./inbox/store.js');
  const { isAuthoritativeDurablePendingProposal } = await import('./inbox/pending-authority.js');
  const { verifyProvenance } = await import('./foundry/provenance.js');
  const { runAutoMergePass } = await import('./fleet/automerge-pass.js');
  const { resolveEngineSpec } = await import('./run/engine-registry.js');
  const { getResourceSnapshot } = await import('./fabric/resource-monitor.js');

  if (!ensureProposalInbox()) {
    result.errors.push({ taskId: 'proposal-store', error: 'proposal inbox authority is unavailable' });
    return result;
  }

  // M300: pre-fetch resource snapshot once per tick (cached 30s, never throws).
  let resourceSnap: Awaited<ReturnType<typeof getResourceSnapshot>> | null = null;
  try {
    resourceSnap = await getResourceSnapshot(cfg);
  } catch {
    // never throws per contract, but guard anyway — null = treat all as available
  }

  /**
   * M300: Resolve effective engine, rerouting away from unavailable backends.
   * Flag-gated: cfg.foundry.resourceAwareDispatch !== false (default ON).
   * Never throws. See planEngineDispatch for the tiering rules.
   */
  function resolveEffectiveEngine(requestedEngine: EngineId): EnginePlan {
    try {
      const resourceAware = (cfg.foundry as Record<string, unknown> | undefined)?.['resourceAwareDispatch'] !== false;
      if (!resourceAware || !resourceSnap) return { kind: 'dispatch', engine: requestedEngine };
      const fallbackOrder = ((cfg.foundry as Record<string, unknown> | undefined)?.['engineFallbackOrder'] as string[] | undefined)
        ?? ['codex', 'kimi', 'nim', 'local-coder'];
      const plan = planEngineDispatch(requestedEngine, fallbackOrder, resourceSnap);
      if (plan.kind === 'dispatch' && plan.note) {
        console.log(`[simple-conductor] reroute: ${requestedEngine} → ${plan.engine} (${plan.note})`);
      }
      return plan;
    } catch {
      return { kind: 'dispatch', engine: requestedEngine };
    }
  }

  let dispatched = 0;

  for (const task of tasks) {
    if (dispatched >= MAX_TASKS_PER_CYCLE) break;

    // Skip done tasks.
    if (task.done) continue;

    const generationId = simpleConductorTaskGenerationId(task);
    const proposalSnapshot = listProposalsDetailed({ requireComplete: true });
    if (!proposalSnapshot.complete || !proposalSnapshot.sourcePresent ||
      proposalSnapshot.sourceState !== 'healthy') {
      result.errors.push({
        taskId: task.id,
        error: 'proposal source is degraded; dispatch authority unavailable',
      });
      continue;
    }
    const knownProposalId = task.candidateProposalId ?? task.proposalId;
    if (knownProposalId) {
      const known = proposalSnapshot.proposals.find((proposal) => proposal.id === knownProposalId);
      if (known) {
        if (isAuthoritativePending(
          task,
          generationId,
          knownProposalId,
          known,
          cfg,
          isAuthoritativeDurablePendingProposal,
        )) {
          const reconciled = reconcileSimpleConductorTask(task.id, generationId, {
            done: true,
            proposalId: knownProposalId,
          });
          if (reconciled.ok) result.proposalsRecovered++;
          else result.errors.push({ taskId: task.id, error: reconciled.detail });
          continue;
        }
        if (belongsToTaskGeneration(known, task, generationId) &&
          ['approved', 'applied', 'merged'].includes(known.status) &&
          verifyProvenance(known).ok) {
          const reconciled = reconcileSimpleConductorTask(task.id, generationId, {
            done: true,
            proposalId: knownProposalId,
          });
          if (reconciled.ok) result.proposalsRecovered++;
          else result.errors.push({ taskId: task.id, error: reconciled.detail });
          continue;
        }
        if (known.status === 'pending' || known.status === 'approved') {
          if (known.workItemId === task.id &&
            isSafeExecutionIdentity(known.workItemGenerationId) &&
            known.workItemGenerationId !== generationId) {
            // This candidate belongs to an explicitly superseded objective.
            // It cannot settle or block the current generation.
          } else {
            result.errors.push({
              taskId: task.id,
              error: 'known pending proposal lacks exact task authority; reconciliation required',
            });
            continue;
          }
        }
      }
    } else {
      const recovered = proposalSnapshot.proposals.find((proposal) =>
        belongsToTaskGeneration(proposal, task, generationId) &&
        isAuthoritativePending(
          task,
          generationId,
          proposal.id,
          proposal,
          cfg,
          isAuthoritativeDurablePendingProposal,
        ));
      if (recovered) {
        const reconciled = reconcileSimpleConductorTask(task.id, generationId, {
          done: true,
          proposalId: recovered.id,
        });
        if (reconciled.ok) result.proposalsRecovered++;
        else result.errors.push({ taskId: task.id, error: reconciled.detail });
        continue;
      }
    }

    // M300: decide the engine before any claim. When every candidate engine is
    // hard-unavailable (exhausted/unreachable), defer: the task stays queued
    // with its attempts, lease and retry window untouched, and no sandbox runs.
    const requestedEngine = (task.engine ?? 'claude') as EngineId;
    const enginePlan = resolveEffectiveEngine(requestedEngine);
    if (enginePlan.kind === 'defer') {
      (result.deferred ??= []).push({
        taskId: task.id,
        engine: requestedEngine,
        reason: enginePlan.reason,
        ...(enginePlan.earliestResetAt ? { earliestResetAt: enginePlan.earliestResetAt } : {}),
      });
      console.log(
        `[simple-conductor] ${opts.dryRun ? 'dry-run: would defer' : 'defer'} task ${task.id}: ${enginePlan.reason}` +
        (enginePlan.earliestResetAt ? ` (earliest known reset ${enginePlan.earliestResetAt})` : ''),
      );
      continue;
    }

    if (opts.dryRun) {
      // Dry-run: record intent only — no dispatch, no write.
      result.tasksAttempted++;
      console.log(`[simple-conductor] dry-run: would dispatch task ${task.id} → ${task.repo}`);
      dispatched++;
      continue;
    }

    result.tasksAttempted++;

    // assertMayMutate — skip + log if unenrolled or kill switch.
    try {
      assertMayMutate(task.repo);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[simple-conductor] skip task ${task.id}: ${msg}`);
      result.errors.push({ taskId: task.id, error: msg });
      continue;
    }

    const claimed = claimSimpleConductorTask(task.id, generationId);
    if (!claimed.ok) {
      if (claimed.reason === 'unavailable') {
        result.taskStoreUnavailable = true;
        result.errors.push({ taskId: task.id, error: claimed.detail });
      } else if (claimed.reason === 'reconciliation-required') {
        result.errors.push({ taskId: task.id, error: claimed.detail });
      }
      continue;
    }
    const claim = claimed.claim;
    dispatched++;

    // Dispatch via the proven sandboxed-engine primitive.
    // CI isolation: when LOCUS_CI_BINDING/LOCUS_BINDING is set, mint an
    // ephemeral sealed session in a private job context for the sandboxed engine.
    // Default (unset binding + LOCUS_ENFORCE off) is a no-op pass-through.
    // LocusSessionConfigError / LocusMintError → result.errors (never throw).
    try {
      // M300: engine resolved before the claim (reroutes away from exhausted backends).
      const engineId: EngineId = enginePlan.engine;
      // M298: append a standing full-suite directive so the agent cannot finish
      // without running the complete test suite + typecheck and confirming zero
      // NEW failures. This closed a regression window where the agent ran only
      // related tests and missed failures in adjacent modules (doctor regression).
      const fullSuiteDirective =
        '\n\n---\nBEFORE FINISHING: run the FULL test suite (`npm test` or `npx vitest run`) ' +
        'AND typecheck (`npx tsc --noEmit`). Confirm there are ZERO new failures ' +
        '(pre-existing failures that were already failing before your change are exempt). ' +
        'Do NOT mark the task complete or file a proposal until both commands pass cleanly.';
      const instruction = task.instruction + buildTaskBrief({ repo: task.repo, title: task.instruction, cfg }) + fullSuiteDirective;

      // M300: route to the correct runner — cli-agents (claude/codex) via runEngineSandboxed,
      // api-models (nim/kimi/local-coder) via runApiModelSandboxed.
      const engineSpec = resolveEngineSpec(engineId, cfg);
      const isApiModel = engineSpec?.kind === 'api-model';

      const sandboxOpts = {
        sourceRepo: task.repo,
        budget: {
          // M287: raised from 50k/40 — substantial high-value work (new file +
          // wiring + test + iterate-to-green) exhausted the old budget on
          // attempt 1 ("budget exceeded after attempt 1"), leaving no room to
          // finish. Bigger budget lets the agent complete + verify substantial tasks.
          maxTokens: 150_000,
          maxSteps: 100,
          allowCloud: opts.allowCloud,
        },
        propose: true,
        workItemId: task.id,
        workItemGenerationId: generationId,
      };

      const sandboxResult = await runWithLocusSessionIfConfigured(async () => {
        return isApiModel
          ? await runApiModelSandboxed(engineId, instruction, cfg, sandboxOpts)
          : await runEngineSandboxed(engineId, instruction, cfg, sandboxOpts);
      });

      const candidateId = resultCandidateId(sandboxResult);
      const runId = isSafeExecutionIdentity(sandboxResult.state?.id)
        ? sandboxResult.state.id
        : undefined;
      let authoritative = false;
      if (candidateId) {
        const afterDispatch = listProposalsDetailed({ requireComplete: true });
        if (afterDispatch.complete && afterDispatch.sourcePresent &&
          afterDispatch.sourceState === 'healthy') {
          const candidate = afterDispatch.proposals.find((proposal) => proposal.id === candidateId);
          authoritative = isAuthoritativePending(
            task,
            generationId,
            candidateId,
            candidate,
            cfg,
            isAuthoritativeDurablePendingProposal,
            runId,
          );
        }
      }

      if (candidateId && authoritative) {
        const settled = settleSimpleConductorTask(claim, {
          done: true,
          proposalId: candidateId,
        });
        if (!settled.ok) {
          result.errors.push({ taskId: task.id, error: settled.detail });
        } else if (sandboxResult.proposalId === candidateId) {
          result.proposalsFiled++;
        } else {
          result.proposalsRecovered++;
        }
      } else {
        const message = candidateId
          ? 'proposal candidate lacks exact durable pending authority; reconciliation required'
          : 'no authoritative proposal filed (empty, incomplete, or gate-blocked diff)';
        const settled = settleSimpleConductorTask(claim, {
          done: false,
          ...(candidateId ? { candidateProposalId: candidateId } : {}),
          lastError: message,
          retryAfter: retryAfterForFailure(claim.task.attempts ?? 1, candidateId !== undefined),
        });
        if (!settled.ok) result.errors.push({ taskId: task.id, error: settled.detail });
      }
    } catch (err: unknown) {
      // Map Locus session refuse/mint failures (and any other dispatch error)
      // to result.errors — never throw out of the per-task loop.
      const msg =
        err instanceof LocusSessionConfigError || err instanceof LocusMintError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      console.warn(`[simple-conductor] task ${task.id} dispatch error: ${msg}`);
      result.errors.push({ taskId: task.id, error: msg });
      const settled = settleSimpleConductorTask(claim, {
        done: false,
        lastError: msg,
        retryAfter: retryAfterForFailure(claim.task.attempts ?? 1),
      });
      if (!settled.ok) result.errors.push({ taskId: task.id, error: settled.detail });
      // never-throws — continue to next task
    }
  }

  // 5. Run the auto-merge pass so filed proposals get judged + merged this tick.
  // The full gate (judge/completeness/verification/kill-switch) is unchanged.
  if (!opts.dryRun) {
    try {
      const passResult = await runAutoMergePass(cfg);
      result.merged = passResult.merged;
    } catch {
      // best-effort — merge pass failure is non-fatal
    }
  }

  return result;
}
