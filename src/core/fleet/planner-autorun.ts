/**
 * planner-autorun.ts — WHEN the fleet is due a planner pass (RQ-PHX-PLANNERAUTORUN01).
 *
 * planner-run.ts can fire one pass on the live login and planner-failover.ts
 * reads its health, but nothing in src/ decided WHEN: every pass was fired
 * by a shell timer outside the repo. The Nov 1 "fully autonomous and
 * self-improving" order and the Oct 31 "orchestrate ALL resources together
 * ... detect available usage itself" order need that decision inside
 * Phantom: decidePlannerAutorun is the pure function, readPlannerAutorunInput
 * is the bounded read that feeds it, and `ashlr fleet planner-tick`
 * (src/cli/fleet-planner-tick.ts) is the one-shot verb an agent, a timer or
 * a later route can call.
 *
 * The trigger is the leader's hand rule: the queue of Phantom jobs (ids
 * starting RQ-PHX-) in queue/ready.tsv has fallen under 24 across lanes
 * while some lane still has free slots, and the last pass is at least 25
 * minutes old. The queued supply comes from ready-supply.ts — the canonical
 * summary that already knows every parked-row form ready.tsv carries
 * (headered status, `status=` cell, dotted pool, and the dispatcher's native
 * five-column `id repo PARKED-lane work /path` via normalizeLegacyRows). The
 * checks run in a fixed order and each yields one reason:
 *   orch-off → planner-failing → no-free-slots → enough-supply → too-soon
 *   → low-supply (run).
 *
 * Biases: a missing or unreadable ready.tsv counts as 0 queued Phantom jobs —
 * a tick that cannot see the queue runs a pass rather than starving the
 * lanes. A last pass that cannot be proven recent (no LEADER rows, an
 * unparseable stamp) is never "too soon". Non-finite or negative numbers
 * count as 0 everywhere.
 */
import { readPlannerHealth, type PlannerHealth } from './planner-failover.js';
import { readReadySupply } from './ready-supply.js';
import { readFleetRunsDirState } from './runs-dir-state.js';
import { readRunsSwitches } from './runs-switches.js';

export interface PlannerAutorunInput {
  /** Queued Phantom jobs (ids starting RQ-PHX-) in queue/ready.tsv. */
  phxReady: number;
  /** Lane slot picture: running vs target, and whether the lane is held. */
  lanes: { lane: string; running: number; target: number; held: boolean }[];
  /** Newest planner health read (planner-failover.ts). */
  health: PlannerHealth;
  /** The ORCH_OFF kill switch — the same rule planner-run.ts checks. */
  orchOff: boolean;
  nowMs: number;
  /** Minimum age of the last pass before another may run. Default 25. */
  minGapMinutes?: number;
  /** Queued Phantom supply below which a pass is due. Default 24. */
  lowSupply?: number;
  /** Set by readPlannerAutorunInput when ready.tsv was missing or unreadable. */
  queueUnreadable?: boolean;
}

export type PlannerAutorunReason =
  'low-supply' | 'enough-supply' | 'too-soon' | 'planner-failing' | 'orch-off' | 'no-free-slots';

export interface PlannerAutorunDecision {
  v: 1;
  run: boolean;
  reason: PlannerAutorunReason;
  phxReady: number;
  freeSlots: number;
  lastPassAt: string | null;
  minutesSinceLastPass: number | null;
  /** One sentence a person can read — no paths. */
  detail: string;
}

const DEFAULT_MIN_GAP_MINUTES = 25;
const DEFAULT_LOW_SUPPLY = 24;

/** "Non-finite or negative numbers count as 0." */
const nonneg = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/**
 * The pure decision. The check order is fixed — see the file header — so two
 * ticks over the same reads always report the same reason.
 */
export function decidePlannerAutorun(input: PlannerAutorunInput): PlannerAutorunDecision {
  const health: PlannerHealth = input.health
    ?? { status: 'unknown', failingSince: null, lastGoodPassAt: null, resetAt: null, reason: null };
  const phxReady = nonneg(input.phxReady);
  const lowSupply = input.lowSupply === undefined ? DEFAULT_LOW_SUPPLY : nonneg(input.lowSupply);
  const minGap = input.minGapMinutes === undefined ? DEFAULT_MIN_GAP_MINUTES : nonneg(input.minGapMinutes);
  const freeSlots = (input.lanes ?? [])
    .filter((lane) => !lane.held)
    .reduce((sum, lane) => sum + Math.max(0, nonneg(lane.target) - nonneg(lane.running)), 0);
  const lastPassAt = health.lastGoodPassAt ?? health.failingSince;
  const passMs = lastPassAt === null ? Number.NaN : Date.parse(lastPassAt);
  const minutesSince = Number.isFinite(passMs)
    ? Math.floor((nonneg(input.nowMs) - passMs) / 60_000)
    : null;
  const unreadable = input.queueUnreadable === true || !Number.isFinite(input.phxReady);
  const done = (run: boolean, reason: PlannerAutorunReason, detail: string): PlannerAutorunDecision =>
    ({ v: 1, run, reason, phxReady, freeSlots, lastPassAt, minutesSinceLastPass: minutesSince, detail });

  if (input.orchOff) {
    return done(false, 'orch-off', 'Orchestration is off (ORCH_OFF), so no planner pass is due.');
  }
  if (health.status === 'failing') {
    return done(false, 'planner-failing',
      `The planner is already failing (${health.reason ?? 'no reason recorded'}), so another pass would pile onto a dead login.`);
  }
  if (freeSlots === 0) {
    return done(false, 'no-free-slots',
      'No lane has a free slot — every lane is at target or held — so a new slate could not dispatch.');
  }
  if (phxReady >= lowSupply) {
    return done(false, 'enough-supply', unreadable
      ? `The ready queue was unreadable and the supply floor is ${lowSupply}, so no pass is due.`
      : `${phxReady} Phantom jobs are still queued (at least the ${lowSupply} floor), so no pass is due.`);
  }
  if (minutesSince !== null && minutesSince < minGap) {
    return done(false, 'too-soon',
      `The last pass is only ${minutesSince} minute(s) old, inside the ${minGap}-minute gap, so this tick skips.`);
  }
  return done(true, 'low-supply', unreadable
    ? 'The ready queue was unreadable, so a pass runs rather than starving the lanes.'
    : `Only ${phxReady} Phantom jobs are queued against ${freeSlots} free lane slot(s), so a pass is due.`);
}

/**
 * The reads behind decidePlannerAutorun. Never throws: the queued Phantom
 * supply is readReadySupply's canonical count (every parked-row form,
 * including the dispatcher's five-column lane marker), and a missing or
 * unreadable ready.tsv counts as phxReady 0 with queueUnreadable set, so a
 * tick still runs a pass rather than starving; the lane and health readers
 * fail soft to empty lanes / unknown health. ORCH_OFF is the same
 * file-exists check planner-run.ts makes through readRunsSwitches.
 */
export async function readPlannerAutorunInput(runsDir: string, now: number): Promise<PlannerAutorunInput> {
  const [supply, state, health, switches] = await Promise.all([
    readReadySupply({ runsDir, now: () => new Date(now) }).catch(() => null),
    readFleetRunsDirState({ runsDir, now: () => now }).catch(() => null),
    readPlannerHealth(runsDir, now).catch(() => null),
    readRunsSwitches({ runsDir }).catch(() => null),
  ]);
  const queueUnreadable = supply === null || supply.sourceState !== 'healthy';
  return {
    phxReady: supply !== null && !queueUnreadable ? supply.totals.phxReady : 0,
    lanes: (state?.lanes ?? [])
      .map((lane) => ({ lane: lane.lane, running: lane.running, target: lane.target, held: lane.held })),
    health: health ?? { status: 'unknown', failingSince: null, lastGoodPassAt: null, resetAt: null, reason: null },
    orchOff: switches?.switches.some((row) => row.id === 'ORCH_OFF' && row.on) ?? false,
    nowMs: now,
    queueUnreadable,
  };
}
