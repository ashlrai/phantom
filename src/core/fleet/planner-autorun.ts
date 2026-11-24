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
 * minutes old (five for a confirmed empty queue) — or, under the stricter
 * critical floor (default 6), even with
 * every lane full: real Phantom supply nearly gone must not wait on a slot.
 * The queued supply comes from ready-supply.ts — the canonical summary that
 * already knows every parked-row form ready.tsv carries (headered status,
 * `status=` cell, dotted pool, and the dispatcher's native five-column
 * `id repo PARKED-lane work /path`, recognized by parseReadyTsv itself). The
 * checks run in a fixed order and each yields one reason:
 *   orch-off → planner-failing → no-free-slots → enough-supply → too-soon
 *   → low-supply | supply-floor (run).
 *
 * planner-failing is only a skip when no login is left to try. A usage-limit
 * (or rejected-login) failure belongs to ONE login: the executor on the
 * failed LEADER row, else the slate's lastProvider. If a later slate login's
 * pool still has usage (the same pool readings `phm pools` shows), the pass
 * runs there and the decision names `lane` and `fallbackFrom`. Once the dead
 * login's reset time passes, or any pass succeeds, it is no longer failing.
 * With every pool out the skip names the pools and the first reset.
 *
 * no-free-slots yields to the floor: when every lane is full but the queue
 * was readable and its Phantom count is under the critical floor, the check
 * falls through instead of skipping — enough-supply and too-soon still
 * apply, and a run lands on 'supply-floor'.
 *
 * Biases: a missing or unreadable ready.tsv counts as 0 queued Phantom jobs —
 * a tick that cannot see the queue runs a pass rather than starving the
 * lanes, but with no free slot the floor never rescues an unreadable queue:
 * a pass with no real count and no slot would be a guess. A last pass that
 * cannot be proven recent (no LEADER rows, an unparseable stamp) is never
 * "too soon". Non-finite or negative numbers count as 0 everywhere.
 */
import { readPlannerCandidates } from './planner-candidates.js';
import { isProviderLimited, readPlannerHealth, type PlannerHealth } from './planner-failover.js';
import { executorToken } from './planner-run.js';
import { buildPoolsView, type PoolRow } from './pools-view.js';
import { readResourceLedger } from './runs-resource-ledger.js';
import { readUsageSamples } from './usage-history.js';
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
  /** Minimum age of the last pass/request. Default 25; confirmed empty queues cap it at five. */
  minGapMinutes?: number;
  /** Queued Phantom supply below which a pass is due. Default 24. */
  lowSupply?: number;
  /** Critical floor: full lanes may not silence a readable queue under it. Default 6. */
  supplyFloor?: number;
  /** Set by readPlannerAutorunInput when ready.tsv was missing or unreadable. */
  queueUnreadable?: boolean;
  /** The slate's logins in priority order, each with its pool state. Absent: no slate declared. */
  slate?: PlannerSlateLane[];
  /** The slate login the failed pass ran on, when known. */
  failedLane?: string | null;
  /** Whether the declared fallback list (queue/planner-candidates.json) is missing, unreadable or fine. Absent: not read. */
  slateState?: PlannerSlateState;
}

export type PlannerSlateState = 'missing' | 'invalid' | 'ok';

/** One planner login and whether its pool is used up (reading at 100%, reset still ahead). */
export interface PlannerSlateLane { provider: string; out: boolean; resetAt: string | null }
export interface PlannerPoolOut { lane: string; resetAt: string | null }

export type PlannerAutorunReason =
  'low-supply' | 'supply-floor' | 'enough-supply' | 'too-soon' | 'planner-failing' | 'orch-off' | 'no-free-slots';

export interface PlannerAutorunDecision {
  v: 1;
  run: boolean;
  reason: PlannerAutorunReason;
  phxReady: number;
  freeSlots: number;
  /** Latest completed pass or accepted restock request (including failed starts). */
  lastPassAt: string | null;
  minutesSinceLastPass: number | null;
  /** One sentence a person can read — no paths. */
  detail: string;
  /** Run only: the login the pass should use when the usual one is out of usage. */
  lane?: string;
  /** With `lane`: the login that hit its limit. */
  fallbackFrom?: string;
  /** planner-failing skip: logins with no usage left. */
  poolsOut?: PlannerPoolOut[];
  /** planner-failing skip: the earliest reset among poolsOut, ISO; null when none is known. */
  nextResetAt?: string | null;
  /** The fallback list's state when the tick read it. */
  slate?: PlannerSlateState;
}

const DEFAULT_MIN_GAP_MINUTES = 25;
const EMPTY_QUEUE_RETRY_MINUTES = 5;
const DEFAULT_LOW_SUPPLY = 24;
const DEFAULT_SUPPLY_FLOOR = 6;

/** Plain words for a slate the planner cannot fall back on; one spelling for every surface. */
export const SLATE_MISSING_WORDS = 'No planner fallback list declared at queue/planner-candidates.json; only the usual login can run. `phm fleet planner-slate --propose` prints one for Security to declare.';
export const SLATE_INVALID_WORDS = 'The planner fallback list at queue/planner-candidates.json cannot be read, so no fallback can run; only the usual login can. `phm fleet planner-slate --propose` prints a replacement for Security to declare.';

/** "Non-finite or negative numbers count as 0." */
const nonneg = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);

/** Logins with no usage left: the failed one first, then slate lanes whose pool reads used up. */
function poolsOut(health: PlannerHealth, from: string | null, slate: readonly PlannerSlateLane[]): PlannerPoolOut[] {
  const out: PlannerPoolOut[] = [];
  if (from === null) {
    if (health.resetAt !== null) out.push({ lane: 'the planner login', resetAt: health.resetAt });
  } else {
    out.push({ lane: from, resetAt: health.resetAt ?? slate.find((l) => l.provider === from)?.resetAt ?? null });
  }
  for (const lane of slate) {
    if (lane.out && !out.some((p) => p.lane === lane.provider)) out.push({ lane: lane.provider, resetAt: lane.resetAt });
  }
  return out;
}

/** Earliest known reset still ahead of `now`, ISO; null when none is known. */
function firstReset(out: readonly PlannerPoolOut[], now: number): string | null {
  const times = out.map((p) => Date.parse(p.resetAt ?? '')).filter((ms) => Number.isFinite(ms) && ms > now);
  return times.length === 0 ? null : new Date(Math.min(...times)).toISOString();
}

/** "Sat Nov 21, 3:30 PM" in the reader's own time zone. */
const resetWords = (iso: string): string =>
  new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * The pure decision. The check order is fixed — see the file header — so two
 * ticks over the same reads always report the same reason.
 */
export function decidePlannerAutorun(input: PlannerAutorunInput): PlannerAutorunDecision {
  const health: PlannerHealth = input.health
    ?? { status: 'unknown', failingSince: null, lastGoodPassAt: null, resetAt: null, reason: null };
  const phxReady = nonneg(input.phxReady);
  const lowSupply = input.lowSupply === undefined ? DEFAULT_LOW_SUPPLY : nonneg(input.lowSupply);
  const supplyFloor = input.supplyFloor === undefined ? DEFAULT_SUPPLY_FLOOR : nonneg(input.supplyFloor);
  const unreadable = input.queueUnreadable === true || !Number.isFinite(input.phxReady);
  const normalGap = input.minGapMinutes === undefined ? DEFAULT_MIN_GAP_MINUTES : nonneg(input.minGapMinutes);
  const minGap = !unreadable && input.phxReady === 0 ? Math.min(normalGap, EMPTY_QUEUE_RETRY_MINUTES) : normalGap;
  const freeSlots = (input.lanes ?? [])
    .filter((lane) => !lane.held)
    .reduce((sum, lane) => sum + Math.max(0, nonneg(lane.target) - nonneg(lane.running)), 0);
  const completedAt = health.lastGoodPassAt ?? health.failingSince;
  const completedMs = Date.parse(completedAt ?? '');
  const requestMs = Date.parse(health.lastRequestedAt ?? '');
  const lastPassAt = requestMs > (Number.isFinite(completedMs) ? completedMs : -Infinity)
    ? health.lastRequestedAt! : completedAt;
  const passMs = lastPassAt === null ? Number.NaN : Date.parse(lastPassAt);
  const minutesSince = Number.isFinite(passMs)
    ? Math.floor((nonneg(input.nowMs) - passMs) / 60_000)
    : null;
  let fallback: { lane: string; from: string } | null = null;
  const done = (run: boolean, reason: PlannerAutorunReason, detail: string): PlannerAutorunDecision =>
    ({
      v: 1, run, reason, phxReady, freeSlots, lastPassAt, minutesSinceLastPass: minutesSince, detail,
      ...(run && fallback ? { lane: fallback.lane, fallbackFrom: fallback.from } : {}),
      ...(input.slateState === undefined ? {} : { slate: input.slateState }),
    });

  if (input.orchOff) {
    return done(false, 'orch-off', 'Orchestration is off (ORCH_OFF), so no planner pass is due.');
  }
  if (health.status === 'failing') {
    const slate = input.slate ?? [];
    const limited = (health.reason === 'usage-limit' || health.reason === 'auth-rejected')
      && isProviderLimited(health, nonneg(input.nowMs));
    const settled = (health.reason === 'usage-limit' || health.reason === 'auth-rejected') && !limited;
    if (!settled) {
      // The dead login: the one that ran the failed pass, else the slate's first.
      const from = input.failedLane ?? null;
      const next = limited ? slate.find((lane) => lane.provider !== from && !lane.out) : undefined;
      if (next === undefined || from === null) {
        const out = poolsOut(health, from, slate);
        const first = firstReset(out, nonneg(input.nowMs));
        const why = (health.reason === 'usage-limit' || health.reason === 'auth-rejected') && out.length > 0
          ? `${out.map((p) => `${p.lane}${p.resetAt ? ` (back ${resetWords(p.resetAt)})` : ''}`).join(', ')} out of usage (${health.reason})${first ? `; the first resets ${resetWords(first)}` : ''}.`
          : `The planner is already failing (${health.reason ?? 'no reason recorded'}).`;
        const gap = input.slateState === 'missing' ? ` ${SLATE_MISSING_WORDS}`
          : input.slateState === 'invalid' ? ` ${SLATE_INVALID_WORDS}` : '';
        return { ...done(false, 'planner-failing', `${why}${gap} Another pass would pile onto a dead login.`), poolsOut: out, nextResetAt: first };
      }
      fallback = { lane: next.provider, from };
    }
  }
  // The leader's hand rule: full lanes must not starve a readable queue
  // already under the critical floor — fall through to the supply and gap
  // checks so a run lands on 'supply-floor'.
  const floorEscape = freeSlots === 0 && !unreadable && phxReady < supplyFloor;
  if (freeSlots === 0 && !floorEscape) {
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
      `The last pass or restock request is only ${minutesSince} minute(s) old, inside the ${minGap}-minute gap, so this tick skips.`);
  }
  if (floorEscape) {
    return done(true, 'supply-floor',
      `Only ${phxReady} Phantom jobs are queued — under the ${supplyFloor}-job critical floor — so a pass runs even with every lane full.`);
  }
  return done(true, 'low-supply', unreadable
    ? 'The ready queue was unreadable, so a pass runs rather than starving the lanes.'
    : `Only ${phxReady} Phantom jobs are queued against ${freeSlots} free lane slot(s), so a pass is due.`);
}

/**
 * The reads behind decidePlannerAutorun. Never throws: the queued Phantom
 * supply is readReadySupply's canonical count (every parked-row form,
 * including the dispatcher's five-column lane marker, plus lane-open rows
 * whose Phantom ids count as supply the market can place anywhere), and a
 * missing or
 * unreadable ready.tsv counts as phxReady 0 with queueUnreadable set, so a
 * tick still runs a pass rather than starving; the lane and health readers
 * fail soft to empty lanes / unknown health. ORCH_OFF is the same
 * file-exists check planner-run.ts makes through readRunsSwitches.
 */
export async function readPlannerAutorunInput(runsDir: string, now: number): Promise<PlannerAutorunInput> {
  const [supply, state, health, switches, slate] = await Promise.all([
    readReadySupply({ runsDir, now: () => new Date(now) }).catch(() => null),
    readFleetRunsDirState({ runsDir, now: () => now }).catch(() => null),
    readPlannerHealth(runsDir, now).catch(() => null),
    readRunsSwitches({ runsDir }).catch(() => null),
    readSlateLanes(runsDir, now).catch(() => null),
  ]);
  const queueUnreadable = supply === null || supply.sourceState !== 'healthy';
  return {
    phxReady: supply !== null && !queueUnreadable ? supply.totals.phxReady + (supply.unhinted?.phantom ?? 0) : 0,
    lanes: (state?.lanes ?? [])
      .map((lane) => ({ lane: lane.lane, running: lane.running, target: lane.target, held: lane.held })),
    health: health ?? { status: 'unknown', failingSince: null, lastGoodPassAt: null, resetAt: null, reason: null },
    orchOff: switches?.switches.some((row) => row.id === 'ORCH_OFF' && row.on) ?? false,
    nowMs: now,
    queueUnreadable,
    ...(slate === null ? {} : { slate: slate.lanes, failedLane: failedLaneOf(health, slate), slateState: slate.state }),
  };
}

/** Slate logins in order, each with its pool state from the same readings `phm pools` shows. */
async function readSlateLanes(runsDir: string, now: number): Promise<{ lanes: PlannerSlateLane[]; lastProvider: string | null; state: PlannerSlateState }> {
  const slate = await readPlannerCandidates(runsDir);
  if (slate.source !== 'ok') return { lanes: [], lastProvider: null, state: slate.source };
  const view = await readResourceLedger({ runsDir, now: () => now })
    .then(async (ledger) => buildPoolsView(ledger, now, await readUsageSamples({ runsDir, nowMs: now })))
    .catch(() => null);
  const lanes = slate.candidates.map(({ provider }): PlannerSlateLane => {
    const row: PoolRow | undefined = view?.pools.find((pool) => pool.id === provider);
    const resetMs = Date.parse(row?.resetAt ?? '');
    const out = row !== undefined && row.state === 'measured' && row.usedPct !== null && row.usedPct >= 100
      && Number.isFinite(resetMs) && resetMs > now;
    return { provider, out, resetAt: row?.resetAt ?? null };
  });
  return { lanes, lastProvider: slate.lastProvider, state: 'ok' };
}

/** The login that ran the failed pass: the LEADER row's executor, else the slate's lastProvider. */
function failedLaneOf(health: PlannerHealth | null, slate: { lanes: PlannerSlateLane[]; lastProvider: string | null }): string | null {
  const byRow = health?.executor === undefined ? undefined
    : slate.lanes.find((lane) => executorToken(lane.provider) === health.executor);
  return byRow?.provider ?? slate.lastProvider;
}
