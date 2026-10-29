/**
 * Drive ops tick — the routine Mac-pool operations that used to be scheduled
 * as Grok-turn work, run instead as deterministic steps inside the dispatchd
 * (drive supervisor) tick. No step launches a worker, holds a session or
 * spends a turn; every port is plain host code.
 *
 * Steps, in tick order: restock, reap, metrics-export, fixfwd-triage,
 * dashboard-rollup. Each logs exactly one VALUE-FREE line
 * (`drive-ops <step> <outcome>` — fixed tokens, closed enums, never a count,
 * id, path or reason) through the injected sink, matching the pool-ledger
 * value-free observation convention.
 *
 * Failure contract: `reap` is load-bearing — the tick already reconciles
 * completion evidence through it — so its failure propagates and fails the
 * tick closed, exactly like the direct bridge call it replaces. The other
 * four steps are advisory: a throw is logged `failed` and the tick carries
 * on, since an ops observation must never hold production. A missing port
 * logs `skipped`; an aborted signal logs `held` for steps not yet run.
 *
 * The weekly budget governor pauses non-P0 Grok-turn work once the weekly
 * pool reaches the pause watermark (default 85 percent, at-or-above — the
 * same fail-closed convention as subscription `maxPercent`). P0 work and
 * non-Grok pools are never held by it, and an unreadable percentage fails
 * closed: unknown usage is not headroom.
 */
import { metricsFromRollup } from './state/rollup.js';
import type { DriveJob, DriveSnapshot } from './supervisor.js';
import type { DriveQueueV1 } from './queue-v1.js';
import { projectDriveQueueV1 } from './queue-v1.js';

// ---------------------------------------------------------------------------
// Step registry
// ---------------------------------------------------------------------------

export const OPS_STEPS = ['restock', 'reap', 'metrics-export', 'fixfwd-triage', 'dashboard-rollup'] as const;
export type OpsStepId = (typeof OPS_STEPS)[number];
export type OpsStepOutcome = 'ok' | 'skipped' | 'failed' | 'held';

/** What a step receives: the shared lease it runs under, the tick's abort
 * signal, the governor verdict when one is wired, and the outcomes of the
 * steps already run this tick (the last step sees the others). */
export interface OpsStepContext {
  lease: string;
  signal?: AbortSignal;
  governor?: WeeklyGovernorState;
  steps: Readonly<Partial<Record<OpsStepId, OpsStepOutcome>>>;
}
export type OpsStepPort = (ctx: OpsStepContext) => Promise<unknown>;

/**
 * Host adapters for the five steps. `reap` is always supplied by the
 * supervisor itself (it is the existing bridge reap); the remaining ports
 * come from the host integration and may be absent, which logs `skipped`.
 */
export interface OpsPorts {
  restock?: OpsStepPort;
  reap?: OpsStepPort;
  metricsExport?: OpsStepPort;
  fixfwdTriage?: OpsStepPort;
  dashboardRollup?: OpsStepPort;
}

const STEP_PORT: Record<OpsStepId, keyof OpsPorts> = {
  restock: 'restock',
  reap: 'reap',
  'metrics-export': 'metricsExport',
  'fixfwd-triage': 'fixfwdTriage',
  'dashboard-rollup': 'dashboardRollup',
};

/** Steps whose failure must fail the tick rather than degrade to a log line. */
const CRITICAL_STEPS: ReadonlySet<OpsStepId> = new Set(['reap']);

export type OpsTickResult = Record<OpsStepId, OpsStepOutcome>;

/**
 * Run every ops step once, in registry order, inside the shared-lease window.
 * Exactly one value-free line per step is emitted via `opts.log`.
 */
export async function runOpsTick(
  ports: OpsPorts,
  opts: { lease: string; log: (line: string) => void; signal?: AbortSignal; governor?: WeeklyGovernorState },
): Promise<OpsTickResult> {
  const results = {} as OpsTickResult;
  for (const step of OPS_STEPS) {
    const port = ports[STEP_PORT[step]];
    let outcome: OpsStepOutcome;
    if (opts.signal?.aborted) {
      outcome = 'held';
    } else if (!port) {
      outcome = 'skipped';
    } else {
      try {
        await port({ lease: opts.lease, signal: opts.signal, governor: opts.governor, steps: results });
        outcome = 'ok';
      } catch (error) {
        opts.log(`drive-ops ${step} failed`);
        results[step] = 'failed';
        if (CRITICAL_STEPS.has(step)) throw error;
        continue;
      }
    }
    opts.log(`drive-ops ${step} ${outcome}`);
    results[step] = outcome;
  }
  return results;
}

// ---------------------------------------------------------------------------
// restock — promote newly-eligible queue rows into the READY projection
// ---------------------------------------------------------------------------

export interface RestockPlan {
  /** Jobs launchable under the DRIVER-1 projection (deps DONE, routed, ranked). */
  readyIds: string[];
  /** Jobs present but not launchable this tick. */
  heldIds: string[];
}

/** Deterministic restock view over the host queue.v1 document; malformed documents throw through `projectDriveQueueV1`. */
export function restockPlan(queue: DriveQueueV1): RestockPlan {
  const projected = projectDriveQueueV1(queue);
  const readyIds = projected.filter(job => job.state === 'READY').map(job => job.id);
  const heldIds = projected.filter(job => job.state !== 'READY').map(job => job.id);
  return { readyIds, heldIds };
}

// ---------------------------------------------------------------------------
// reap — classify which active jobs have verifiable completion evidence
// ---------------------------------------------------------------------------

/** What the host knows about a job's worker. `missing` is not completion evidence. */
export type ReapEvidence = 'running' | 'exited-ok' | 'exited-failed' | 'missing';
export interface ReapTransition {
  id: string;
  to: 'FINISHED' | 'FAILED';
}

/**
 * Which active (STARTING/RUNNING) jobs reconcile to a terminal state.
 * Only exit evidence reaps: `exited-ok` → FINISHED(0), `exited-failed` →
 * FAILED. `running` and `missing` leave the job in place — a missing PID
 * alone is not completion evidence (docs/DRIVE.md bridge contract).
 */
export function reapPlan(
  jobs: readonly DriveJob[],
  evidence: (id: string) => ReapEvidence,
): ReapTransition[] {
  const transitions: ReapTransition[] = [];
  for (const job of jobs) {
    if (job.state !== 'STARTING' && job.state !== 'RUNNING') continue;
    const seen = evidence(job.id);
    if (seen === 'exited-ok') transitions.push({ id: job.id, to: 'FINISHED' });
    else if (seen === 'exited-failed') transitions.push({ id: job.id, to: 'FAILED' });
  }
  return transitions;
}

// ---------------------------------------------------------------------------
// metrics-export — narrow a rollup to the value-free metrics.v1 record
// ---------------------------------------------------------------------------

export { metricsFromRollup as opsMetricsRecord };

// ---------------------------------------------------------------------------
// fixfwd-triage — does a PR head need a fix-forward?
// ---------------------------------------------------------------------------

export interface FixfwdRequiredContext {
  context: string;
  /** GitHub App id the check must come from; null/absent = any source. */
  appId?: string | null;
}
export interface FixfwdCheckRun {
  id?: number;
  name: string;
  appId?: string | null;
  status: string;
  conclusion: string | null;
}
export interface FixfwdStatus {
  context: string;
  state: string;
}
export interface FixfwdInput {
  /** Required contexts from branch protection/rulesets; null = unreadable. */
  required: readonly FixfwdRequiredContext[] | null;
  /** Check runs observed on the PR head. */
  runs: readonly FixfwdCheckRun[];
  /** Commit statuses observed on the PR head; count only for appId-free requirements. */
  statuses?: readonly FixfwdStatus[];
}
export type FixfwdVerdict = 'green' | 'pending' | 'fix-forward' | 'unknown';
export interface FixfwdTriage {
  verdict: FixfwdVerdict;
  /** Required context names currently red. */
  failed: string[];
  /** Required context names with no verdict yet. */
  waiting: string[];
}

const FIXFWD_OK = new Set(['success', 'neutral', 'skipped']);
const FIXFWD_RED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);

/**
 * Triage a PR head for fix-forward work using REQUIRED CONTEXTS ONLY.
 * Advisory checks — the non-required SonarCloud, CodeQL and Vercel contexts
 * the Mac pools report — are ignored no matter their conclusion: a red
 * advisory run never opens fix-forward work, and a green one never counts
 * toward green.
 *
 * `required: null` (protection unreadable) → `unknown`: the tick neither
 * claims green nor guesses a repair. An empty required list → `green`:
 * nothing is required, so nothing can need fixing.
 */
export function triageFixForward(input: FixfwdInput): FixfwdTriage {
  if (input.required === null) return { verdict: 'unknown', failed: [], waiting: [] };
  const statuses = input.statuses ?? [];
  // Latest run per (name, appId) — higher id wins; runs without ids keep order.
  const latest = new Map<string, FixfwdCheckRun>();
  for (const run of input.runs) {
    const key = `${run.name}${run.appId ?? ''}`;
    const prior = latest.get(key);
    if (!prior || (run.id ?? 0) >= (prior.id ?? 0)) latest.set(key, run);
  }
  const failed: string[] = [];
  const waiting: string[] = [];
  for (const req of input.required) {
    const appId = req.appId ?? null;
    const observed: ('green' | 'red' | 'pending')[] = [];
    for (const run of latest.values()) {
      if (run.name !== req.context || (appId !== null && run.appId !== appId)) continue;
      if (run.status !== 'completed') observed.push('pending');
      else if (run.conclusion !== null && FIXFWD_OK.has(run.conclusion)) observed.push('green');
      else if (run.conclusion !== null && FIXFWD_RED.has(run.conclusion)) observed.push('red');
      else observed.push('pending'); // cancelled/stale: superseded, not proof.
    }
    if (appId === null) {
      for (const status of statuses) {
        if (status.context !== req.context) continue;
        observed.push(status.state === 'success' ? 'green' : status.state === 'failure' || status.state === 'error' ? 'red' : 'pending');
      }
    }
    if (observed.includes('red')) failed.push(req.context);
    else if (observed.length === 0 || observed.includes('pending')) waiting.push(req.context);
  }
  if (failed.length > 0) return { verdict: 'fix-forward', failed, waiting };
  if (waiting.length > 0) return { verdict: 'pending', failed, waiting };
  return { verdict: 'green', failed, waiting };
}

// ---------------------------------------------------------------------------
// dashboard-rollup — value-free fleet summary for the status surface
// ---------------------------------------------------------------------------

export interface DashboardRollupV1 {
  schema: 'drive-ops-rollup.v1';
  at: string;
  admission: DriveSnapshot['admission'];
  paused: boolean;
  governor: WeeklyGovernorState | 'off';
  /** Job counts keyed by the closed DriveJobState enum — counts, never ids. */
  states: Record<DriveJob['state'], number>;
  /** Per-pool active counts; pool ids are host configuration, not secrets. */
  pools: { id: string; active: number; ceiling: number }[];
  ops: Partial<Record<OpsStepId, OpsStepOutcome>>;
}

/** Build the value-free dashboard row for one tick. Counts and closed enums only. */
export function dashboardRollup(input: {
  snapshot: DriveSnapshot;
  governor?: WeeklyGovernorState | 'off';
  ops?: Partial<Record<OpsStepId, OpsStepOutcome>>;
  now?: () => Date;
}): DashboardRollupV1 {
  const states = {} as Record<DriveJob['state'], number>;
  for (const state of ['READY', 'HELD', 'STARTING', 'RUNNING', 'FINISHED', 'FAILED', 'PUBLISHING', 'PUBLISHED', 'PUBLISH_UNKNOWN'] as const) {
    states[state] = 0;
  }
  for (const job of input.snapshot.jobs) states[job.state] += 1;
  return {
    schema: 'drive-ops-rollup.v1',
    at: (input.now?.() ?? new Date()).toISOString(),
    admission: input.snapshot.admission,
    paused: input.snapshot.paused,
    governor: input.governor ?? 'off',
    states,
    pools: input.snapshot.pools.map(pool => ({
      id: pool.id,
      active: input.snapshot.jobs.filter(job => job.pool === pool.id && (job.state === 'STARTING' || job.state === 'RUNNING')).length,
      ceiling: pool.ceiling,
    })),
    ops: input.ops ?? {},
  };
}

// ---------------------------------------------------------------------------
// Weekly budget governor — pause non-P0 Grok-turn work at the watermark
// ---------------------------------------------------------------------------

/** The weekly-pool used percent at or above which non-P0 Grok-turn work pauses. */
export const WEEKLY_GROK_PAUSE_PERCENT = 85;
/** queue-v1 maps P0 → numeric 9, the highest band; anything at/above it is P0 work. */
export const P0_PRIORITY = 9;
/** Budget pools whose jobs burn Grok turns (the grok-* rows of BUDGET_POOLS). */
export const GROK_TURN_POOLS = ['grok-build', 'grok-ultra'] as const;

export type WeeklyGovernorState = 'open' | 'paused' | 'unknown';
export interface WeeklyGovernorDecision {
  state: WeeklyGovernorState;
  /** True ⇒ non-P0 Grok-turn jobs may not start while this decision stands. */
  nonP0Paused: boolean;
}

/**
 * Judge one weekly-pool used-percent reading.
 *  - `used >= threshold` (default 85) ⇒ paused: the remainder of the pool is
 *    P0 headroom. At-or-above, matching the `maxPercent` block convention.
 *  - `used < threshold` ⇒ open.
 *  - Missing or invalid reading ⇒ `unknown` and paused: unknown usage is not
 *    headroom, so non-P0 Grok-turn work fails closed rather than spending it.
 */
export function evaluateWeeklyGovernor(
  usedPercent: number | null | undefined,
  threshold: number = WEEKLY_GROK_PAUSE_PERCENT,
): WeeklyGovernorDecision {
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100 ||
      !Number.isFinite(threshold) || threshold <= 0 || threshold > 100) {
    return { state: 'unknown', nonP0Paused: true };
  }
  return usedPercent >= threshold
    ? { state: 'paused', nonP0Paused: true }
    : { state: 'open', nonP0Paused: false };
}

/** True when the job's pool is a Grok-turn lane. */
export function isGrokTurnJob(job: DriveJob, grokPools: readonly string[] = GROK_TURN_POOLS): boolean {
  return grokPools.includes(job.pool);
}

/**
 * May this job start under the governor decision? P0 is never held — the
 * pause exists to protect P0 headroom, not to stop it — and jobs outside the
 * Grok-turn pools are unaffected.
 */
export function governorAllows(
  job: DriveJob,
  decision: WeeklyGovernorDecision,
  grokPools: readonly string[] = GROK_TURN_POOLS,
): boolean {
  if (!decision.nonP0Paused) return true;
  if (job.priority >= P0_PRIORITY) return true;
  return !isGrokTurnJob(job, grokPools);
}
