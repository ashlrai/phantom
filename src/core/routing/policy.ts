/**
 * Budget policy — mode defaults, effective per-seat policy, and strict update
 * parsing (V3.10 unit A9).
 *
 * THE MODEL (what a stored policy means)
 *
 *   `policy.mode` picks a column of MODE_DEFAULTS below. `policy.seats` holds
 *   the per-seat policies IN FORCE for that mode, but only for seats the
 *   operator has touched; every other seat gets the mode's default for its
 *   engine. So what the Budget panel shows is exactly what the router uses —
 *   there is no hidden transform layered on top of a slider.
 *
 *   Switching mode (`applyModeSwitch`) re-bases every stored seat on the new
 *   mode's defaults and keeps only the two choices that are not "how much" but
 *   "whether at all": `enabled` and a hard `dailyUsdCap`. A reserve tuned for
 *   `balanced` would be meaningless in `all-in` (which by definition keeps
 *   nothing back), so it is not carried across.
 *
 * DEFAULTS (Mason's decisions, recorded 2026-09-24 — binding):
 *   balanced (default) — Claude keeps 40% of its weekly window for Mason and
 *                        is never touched while its 5-hour window is above 70%
 *                        (protects his live session). Grok 0% reserve. Local
 *                        unlimited. Codex OFF (no usage) until switched on.
 *   all-in             — autonomy may use all available usage (no reserve, no
 *                        session ceiling). Codex stays OFF by default.
 *   reserve            — free local models plus only a small paid cap: every
 *                        paid seat keeps 85% of its binding window back and a
 *                        5-hour ceiling of 50%, and the router ranks local
 *                        first (router.ts).
 *
 * BROWSER-SAFE and PURE: no node: imports, no I/O. The Budget UI imports the
 * defaults from here so the "reset to default" hint can never drift from the
 * server.
 */
import {
  ARM_EFFORTS,
  BUDGET_MODES,
  ROUTING_TASKS,
  type BudgetMode,
  type BudgetPolicy,
  type BudgetResponse,
  type BudgetUpdateRequest,
  type RoutingTask,
  type SeatBudgetPolicy,
  type TaskArm,
  type TaskArmPace,
  type TaskArmsPolicy,
} from './types.js';

/**
 * The engines a seat can belong to (mirrors `VerseEngine`, kept local so this
 * file has no verse import).
 *
 * 3.15: `devin` is its OWN engine. It used to fall through `engineOfSeatId`
 * to `claude`, so a Devin producer seat in a grant also authorized the
 * claude-cli producer lane (dispatch-router `grantHasProducerFor`). Devin is a
 * hosted session agent: it has no capacity windows, no dispatch lane and is
 * never a judge; its spend is metered in ACUs by devin/budget.ts.
 */
export type BudgetEngine = 'claude' | 'claude-api' | 'codex' | 'grok' | 'local' | 'devin';

export const BUDGET_ENGINES: readonly BudgetEngine[] = ['claude', 'claude-api', 'codex', 'grok', 'local', 'devin'];

/** API credits are a separate metered identity, never the native subscription. */
export const CLAUDE_API_SEAT_ID = 'claude-api';

/**
 * Engines that can have a CAPACITY seat (usage windows, the seat router, the
 * Budget panel's rows): every engine but Devin. The capacity snapshot refuses
 * a `devin` row (budget-store.ts), so no seat reading ever carries it.
 */
export type CapacityEngine = Exclude<BudgetEngine, 'devin'>;

/** The seat id the Devin lane is granted under (`spend.seats.devin`). */
export const DEVIN_SEAT_ID = 'devin';

/** Same spelling rule the seat catalog and preferences use for seat ids. */
export const BUDGET_SEAT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;

/** @deprecated Compatibility export only; policy storage is bounded by bytes, not seat count. */
export const BUDGET_MAX_SEATS = 64;

/** Upper bound on a daily USD cap; anything larger is a typo, not a budget. */
export const BUDGET_MAX_DAILY_USD = 10_000;

export const DEFAULT_BUDGET_MODE: BudgetMode = 'balanced';

/** Who a seat is, for the Budget panel (headroom rows carry only the id). */
export interface BudgetSeatInfo {
  seatId: string;
  label: string;
  engine: CapacityEngine;
  /** True for local seats: $0, no provider window. */
  free: boolean;
}

/**
 * The body `GET/POST /api/verse/budget` actually serves: the frozen
 * `BudgetResponse` plus two ADDITIVE fields the panel needs to render a seat
 * it has never stored a policy for. `seats` stays the stored policy (only the
 * seats the operator touched); `effective` is what the router applies to
 * every seat it currently knows.
 */
export interface BudgetView extends BudgetResponse {
  seatInfo: BudgetSeatInfo[];
  effective: Record<string, SeatBudgetPolicy>;
  /** How old a reading may be before autonomy stops spending against it. */
  readingMaxAgeMs: number;
  /** When the seat readings behind `headroom` were sampled. */
  sampledAt: string;
  resetSpendingStatus?: import('./reset-spending-types.js').ResetSpendingStatus;
}

/** Per-engine default in one mode; `seatId` is filled in by `defaultSeatPolicy`. */
type EngineDefault = Omit<SeatBudgetPolicy, 'seatId'>;

/**
 * Mode × engine defaults. Frozen so a caller can never mutate the table the
 * whole process reads.
 *
 * Devin's column only answers "may the fleet launch Devin sessions in this
 * mode at all": it has no windows, so `reservePercent` means nothing to it —
 * the operator's reserve for Devin is kept in ACUs (DevinBudgetV1.reserveAcu).
 *
 * Balanced mode treats included Codex allowance like other native resources.
 * Stored per-account Off preferences still override the default, and current
 * quota and subscription-only execution evidence remain separate requirements.
 * Historical all-in/reserve defaults are retained by this compatibility change.
 */
export const MODE_DEFAULTS: Readonly<Record<BudgetMode, Readonly<Record<BudgetEngine, Readonly<EngineDefault>>>>> =
  Object.freeze({
    'all-in': Object.freeze({
      claude: Object.freeze({ enabled: true, reservePercent: 0 }),
      'claude-api': Object.freeze({ enabled: false, reservePercent: 0 }),
      codex: Object.freeze({ enabled: false, reservePercent: 0 }),
      grok: Object.freeze({ enabled: true, reservePercent: 0 }),
      local: Object.freeze({ enabled: true, reservePercent: 0 }),
      devin: Object.freeze({ enabled: true, reservePercent: 0 }),
    }),
    balanced: Object.freeze({
      claude: Object.freeze({ enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 }),
      'claude-api': Object.freeze({ enabled: false, reservePercent: 0 }),
      codex: Object.freeze({ enabled: true, reservePercent: 40, maxSessionWindowPercent: 70 }),
      grok: Object.freeze({ enabled: true, reservePercent: 0 }),
      local: Object.freeze({ enabled: true, reservePercent: 0 }),
      devin: Object.freeze({ enabled: true, reservePercent: 0 }),
    }),
    reserve: Object.freeze({
      claude: Object.freeze({ enabled: true, reservePercent: 85, maxSessionWindowPercent: 50 }),
      'claude-api': Object.freeze({ enabled: false, reservePercent: 0 }),
      codex: Object.freeze({ enabled: false, reservePercent: 85, maxSessionWindowPercent: 50 }),
      grok: Object.freeze({ enabled: true, reservePercent: 85 }),
      local: Object.freeze({ enabled: true, reservePercent: 0 }),
      // Reserve mode is "free local models plus a small paid slice": a Devin
      // session is paid and all-or-nothing (one session = its whole ACU cap),
      // so the fleet launches none in this mode.
      devin: Object.freeze({ enabled: false, reservePercent: 100 }),
    }),
  });

/** Plain-language one-liners for the mode control (UI + API `why` text share them). */
export const MODE_DESCRIPTIONS: Readonly<Record<BudgetMode, string>> = Object.freeze({
  'all-in': 'Autonomy may use all available usage on every enabled seat.',
  balanced: 'Autonomy stops at each seat’s reserve, so you keep headroom for your own sessions.',
  reserve: 'Autonomy runs on free local models, plus only a small slice of paid seats.',
});

export function isBudgetMode(value: unknown): value is BudgetMode {
  return typeof value === 'string' && (BUDGET_MODES as readonly string[]).includes(value);
}

/**
 * Which engine a seat id belongs to, when the caller has no seat record.
 *
 * Seat ids are account ids from connections.json (`claude`, `codex-personal`,
 * `grok`) or `local:<tag>` for Ollama. An id that names no known engine is
 * treated as `claude`-class — the most protected default — rather than as
 * free local capacity: guessing "free" for an unknown seat would be the
 * fail-open this module exists to close.
 */
export function engineOfSeatId(seatId: string): BudgetEngine {
  const id = seatId.toLowerCase();
  if (id === CLAUDE_API_SEAT_ID) return 'claude-api';
  if (id === 'local' || id.startsWith('local:')) return 'local';
  if (id.startsWith('codex')) return 'codex';
  if (id.startsWith('grok')) return 'grok';
  // 3.15: Devin is its own engine — never the `claude` fallthrough below, or
  // a Devin producer seat would open the claude-cli producer lane.
  if (id.startsWith('devin')) return 'devin';
  return 'claude';
}

export function defaultSeatPolicy(mode: BudgetMode, seatId: string, engine: BudgetEngine = engineOfSeatId(seatId)): SeatBudgetPolicy {
  const base = MODE_DEFAULTS[mode][engine];
  const out: SeatBudgetPolicy = { seatId, enabled: base.enabled, reservePercent: base.reservePercent };
  if (base.maxSessionWindowPercent !== undefined) out.maxSessionWindowPercent = base.maxSessionWindowPercent;
  if (base.dailyUsdCap !== undefined) out.dailyUsdCap = base.dailyUsdCap;
  return out;
}

/** The policy the router applies to one seat: the stored one, or the mode default. */
export function effectiveSeatPolicy(policy: BudgetPolicy, seatId: string, engine?: BudgetEngine): SeatBudgetPolicy {
  const stored = Object.hasOwn(policy.seats, seatId) ? policy.seats[seatId] : undefined;
  if (stored) return { ...stored, seatId };
  return defaultSeatPolicy(policy.mode, seatId, engine ?? engineOfSeatId(seatId));
}

// ---------------------------------------------------------------------------
// Task-aware arms (flagged; sanitize + shared validators)
// ---------------------------------------------------------------------------

/** Bounds an arm's pacing window may span (1 ms .. 30 days). */
export const TASK_ARM_PACE_MAX_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** Bound on an arm's per-window token budget. */
export const TASK_ARM_PACE_MAX_TOKENS = 1e15;

/** The key arm outcome evidence (`RouteOptions.armStats`) is joined on. */
export function taskArmKey(arm: Pick<TaskArm, 'id' | 'engine' | 'model' | 'effort'>): string {
  return arm.id ?? `${arm.engine}|${arm.model ?? ''}|${arm.effort}`;
}

/** The ids arm keys and models may use: the seat-id alphabet, so `|` can never collide with a derived key. */
const TASK_ARM_NAME_RE = BUDGET_SEAT_ID_RE;

/** Validity of an arm's optional pacing spec. A malformed pace drops the whole arm, never just the spec. */
export function isTaskArmPace(raw: unknown): raw is TaskArmPace {
  if (!isObject(raw)) return false;
  if (!Number.isSafeInteger(raw['windowMs']) || (raw['windowMs'] as number) < 1
      || (raw['windowMs'] as number) > TASK_ARM_PACE_MAX_WINDOW_MS) return false;
  if (!Number.isSafeInteger(raw['budgetTokens']) || (raw['budgetTokens'] as number) < 1
      || (raw['budgetTokens'] as number) > TASK_ARM_PACE_MAX_TOKENS) return false;
  const lead = raw['leadFraction'];
  return lead === undefined || (typeof lead === 'number' && Number.isFinite(lead) && lead >= 0 && lead <= 1);
}

/**
 * Runtime validity of one arm: known engine (an unknown engine can never be
 * selected), a model spelling the join grammar can carry, a known effort and
 * a sound pacing spec. Shared by the sanitizer (drops the arm) and the router
 * (skips it), so a hand-built policy and a stored file behave identically.
 */
export function isTaskArm(raw: unknown): raw is TaskArm {
  if (!isObject(raw)) return false;
  if (typeof raw['engine'] !== 'string' || !(BUDGET_ENGINES as readonly string[]).includes(raw['engine'])) return false;
  const model = raw['model'];
  if (model !== null && model !== undefined && (typeof model !== 'string' || !TASK_ARM_NAME_RE.test(model))) return false;
  if (typeof raw['effort'] !== 'string' || !(ARM_EFFORTS as readonly string[]).includes(raw['effort'])) return false;
  const id = raw['id'];
  if (id !== undefined && (typeof id !== 'string' || !TASK_ARM_NAME_RE.test(id) || id.includes('|'))) return false;
  if (raw['pace'] !== undefined && !isTaskArmPace(raw['pace'])) return false;
  return true;
}

/** The valid arms for one class, normalized and deduplicated by key (first spelling wins). */
export function taskArmsFor(taskArms: TaskArmsPolicy | undefined, task: RoutingTask): TaskArm[] {
  const list = taskArms?.classes?.[task];
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const arms: TaskArm[] = [];
  for (const raw of list) {
    if (!isTaskArm(raw)) continue;
    const arm: TaskArm = { engine: raw.engine, model: raw.model ?? null, effort: raw.effort };
    if (raw.id !== undefined) arm.id = raw.id;
    if (raw.pace !== undefined) {
      const pace: TaskArmPace = { windowMs: raw.pace.windowMs, budgetTokens: raw.pace.budgetTokens };
      if (raw.pace.leadFraction !== undefined) pace.leadFraction = raw.pace.leadFraction;
      arm.pace = pace;
    }
    const key = taskArmKey(arm);
    if (seen.has(key)) continue;
    seen.add(key);
    arms.push(arm);
  }
  return arms;
}

/** A structural copy of the flag, so no caller mutates another's policy view. */
export function cloneTaskArmsPolicy(taskArms: TaskArmsPolicy): TaskArmsPolicy {
  const classes: TaskArmsPolicy['classes'] = {};
  for (const task of Object.keys(taskArms.classes) as RoutingTask[]) {
    classes[task] = (taskArms.classes[task] ?? []).map((arm) => ({
      ...arm,
      ...(arm.pace ? { pace: { ...arm.pace } } : {}),
    }));
  }
  return { enabled: taskArms.enabled, classes };
}

/**
 * Salvage the stored `taskArms` flag. `enabled` must be present and boolean;
 * unknown class keys, malformed arms and duplicate arm keys are dropped, so
 * what survives is exactly what the router can act on.
 */
export function sanitizeTaskArmsPolicy(raw: unknown): TaskArmsPolicy | null {
  if (!isObject(raw) || typeof raw['enabled'] !== 'boolean') return null;
  const classes: TaskArmsPolicy['classes'] = {};
  const rawClasses = raw['classes'];
  if (isObject(rawClasses)) {
    for (const task of ROUTING_TASKS) {
      const arms = taskArmsFor({ enabled: true, classes: { [task]: rawClasses[task] } }, task);
      if (arms.length > 0) classes[task] = arms;
    }
  }
  return { enabled: raw['enabled'], classes };
}

/** The policy a fresh install starts with: balanced, no per-seat deviations. */
export function defaultBudgetPolicy(): BudgetPolicy {
  // Epoch, not "now": nothing was ever decided here, and a timestamp that
  // moves on every read would claim a change that never happened.
  return { mode: DEFAULT_BUDGET_MODE, seats: {}, updatedAt: new Date(0).toISOString() };
}

// ---------------------------------------------------------------------------
// Validation (shared by the store's lenient load and the API's strict update)
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPercent(value: unknown, low = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= 100;
}

function isUsd(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= BUDGET_MAX_DAILY_USD;
}

/** Whole percents only: a 40.000001% reserve is noise, and integers diff cleanly. */
function wholePercent(value: number): number {
  return Math.round(value);
}

/** Cents are the finest a USD cap means anything at. */
function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Salvage one stored seat entry, or null when it is unusable. Lenient on
 * purpose (the file is ours but may be hand-edited): an invalid optional field
 * is dropped, an invalid required field drops the entry — which then falls
 * back to the mode default, the conservative outcome.
 */
export function sanitizeSeatPolicy(seatId: string, raw: unknown): SeatBudgetPolicy | null {
  if (!BUDGET_SEAT_ID_RE.test(seatId) || !isObject(raw)) return null;
  if (typeof raw['enabled'] !== 'boolean' || !isPercent(raw['reservePercent'])) return null;
  const out: SeatBudgetPolicy = {
    seatId,
    enabled: raw['enabled'],
    reservePercent: wholePercent(raw['reservePercent']),
  };
  if (isPercent(raw['maxSessionWindowPercent'], 1)) {
    out.maxSessionWindowPercent = wholePercent(raw['maxSessionWindowPercent']);
  }
  if (typeof raw['resetSpending'] === 'boolean') out.resetSpending = raw['resetSpending'];
  if (isUsd(raw['dailyUsdCap'])) out.dailyUsdCap = cents(raw['dailyUsdCap']);
  return out;
}

/** Field-by-field salvage of a whole stored policy. Never throws. */
export function sanitizeBudgetPolicy(raw: unknown): BudgetPolicy {
  const out = defaultBudgetPolicy();
  if (!isObject(raw)) return out;
  if (isBudgetMode(raw['mode'])) out.mode = raw['mode'];
  if (isObject(raw['resetSpending']) && sameKeys(raw['resetSpending'], ['enabled']) && typeof raw['resetSpending']['enabled'] === 'boolean') {
    out.resetSpending = { enabled: raw['resetSpending']['enabled'] };
  }
  const updatedAt = raw['updatedAt'];
  if (typeof updatedAt === 'string' && Number.isFinite(Date.parse(updatedAt))) {
    out.updatedAt = new Date(Date.parse(updatedAt)).toISOString();
  }
  if ('taskArms' in raw) {
    const taskArms = sanitizeTaskArmsPolicy(raw['taskArms']);
    if (taskArms) out.taskArms = taskArms;
  }
  const seats = raw['seats'];
  if (isObject(seats)) {
    for (const seatId of Object.keys(seats).sort()) {
      const entry = sanitizeSeatPolicy(seatId, seats[seatId]);
      if (!entry) continue;
      out.seats[seatId] = entry;
    }
  }
  return out;
}

/** The error the budget module throws for a bad request (duck-typed by `code`, like VerseServiceError). */
export class BudgetPolicyError extends Error {
  readonly code: 'VERSE_INVALID' | 'VERSE_TOO_LARGE';
  readonly status: 400 | 413;

  constructor(code: 'VERSE_INVALID' | 'VERSE_TOO_LARGE', message: string) {
    super(message);
    this.name = 'BudgetPolicyError';
    this.code = code;
    this.status = code === 'VERSE_TOO_LARGE' ? 413 : 400;
  }
}

/**
 * A validated per-seat patch. `null` on an optional field means "clear it"
 * (JSON has no `undefined`): `maxSessionWindowPercent: null` removes the
 * session ceiling, `dailyUsdCap: null` removes the cap.
 */
export interface SeatPolicyPatch {
  enabled?: boolean;
  resetSpending?: boolean | null;
  reservePercent?: number;
  maxSessionWindowPercent?: number | null;
  dailyUsdCap?: number | null;
}

export type ParsedBudgetUpdate =
  | { kind: 'mode'; mode: BudgetMode }
  | { kind: 'reset-spending'; enabled: boolean }
  | { kind: 'seat'; seatId: string; patch: SeatPolicyPatch };

const SEAT_PATCH_KEYS: ReadonlySet<string> = new Set([
  'enabled',
  'resetSpending',
  'reservePercent',
  'maxSessionWindowPercent',
  'dailyUsdCap',
]);

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/**
 * Validate a POST body against EXACTLY one `BudgetUpdateRequest` form, so a
 * body can never change more than the operator clicked. Unknown keys are
 * refused (a misspelt `reservepercent` silently dropped would "succeed" and
 * change nothing).
 */
export function parseBudgetUpdate(value: unknown): ParsedBudgetUpdate {
  if (!isObject(value)) throw new BudgetPolicyError('VERSE_INVALID', 'budget update must be a JSON object');

  if (sameKeys(value, ['resetSpending'])) {
    const preference = value['resetSpending'];
    if (!isObject(preference) || !sameKeys(preference, ['enabled']) || typeof preference['enabled'] !== 'boolean') {
      throw new BudgetPolicyError('VERSE_INVALID', 'resetSpending must contain exactly one boolean enabled field');
    }
    return { kind: 'reset-spending', enabled: preference['enabled'] };
  }

  if (sameKeys(value, ['mode'])) {
    if (!isBudgetMode(value['mode'])) {
      throw new BudgetPolicyError('VERSE_INVALID', `mode must be one of: ${BUDGET_MODES.join(', ')}`);
    }
    return { kind: 'mode', mode: value['mode'] };
  }

  if (sameKeys(value, ['seatId', 'policy'])) {
    const seatId = value['seatId'];
    if (typeof seatId !== 'string' || !BUDGET_SEAT_ID_RE.test(seatId)) {
      throw new BudgetPolicyError('VERSE_INVALID', 'seatId must be a seat id');
    }
    const policy = value['policy'];
    if (!isObject(policy)) throw new BudgetPolicyError('VERSE_INVALID', 'policy must be an object');
    const keys = Object.keys(policy);
    if (keys.length === 0) throw new BudgetPolicyError('VERSE_INVALID', 'policy must change at least one field');
    for (const key of keys) {
      if (!SEAT_PATCH_KEYS.has(key)) throw new BudgetPolicyError('VERSE_INVALID', `unknown policy key: ${key}`);
    }
    const patch: SeatPolicyPatch = {};
    if ('resetSpending' in policy) {
      if (policy['resetSpending'] !== null && typeof policy['resetSpending'] !== 'boolean') throw new BudgetPolicyError('VERSE_INVALID', 'resetSpending must be a boolean or null to inherit');
      patch.resetSpending = policy['resetSpending'] as boolean | null;
    }
    if ('enabled' in policy) {
      if (typeof policy['enabled'] !== 'boolean') throw new BudgetPolicyError('VERSE_INVALID', 'enabled must be a boolean');
      patch.enabled = policy['enabled'];
    }
    if ('reservePercent' in policy) {
      if (!isPercent(policy['reservePercent'])) {
        throw new BudgetPolicyError('VERSE_INVALID', 'reservePercent must be a number from 0 to 100');
      }
      patch.reservePercent = wholePercent(policy['reservePercent']);
    }
    if ('maxSessionWindowPercent' in policy) {
      const v = policy['maxSessionWindowPercent'];
      if (v !== null && !isPercent(v, 1)) {
        throw new BudgetPolicyError('VERSE_INVALID', 'maxSessionWindowPercent must be a number from 1 to 100, or null');
      }
      patch.maxSessionWindowPercent = v === null ? null : wholePercent(v);
    }
    if ('dailyUsdCap' in policy) {
      const v = policy['dailyUsdCap'];
      if (v !== null && !isUsd(v)) {
        throw new BudgetPolicyError('VERSE_INVALID', `dailyUsdCap must be a number from 0 to ${BUDGET_MAX_DAILY_USD}, or null`);
      }
      patch.dailyUsdCap = v === null ? null : cents(v);
    }
    return { kind: 'seat', seatId, patch };
  }

  throw new BudgetPolicyError('VERSE_INVALID', 'budget update must be exactly one of {mode}, {resetSpending}, or {seatId, policy}');
}

/**
 * Re-base every stored seat on `mode`'s defaults, keeping `enabled` and a hard
 * `dailyUsdCap` (see the file header for why reserves are not carried).
 */
export function applyModeSwitch(
  policy: BudgetPolicy,
  mode: BudgetMode,
  nowIso: string,
  engineOf?: (seatId: string) => BudgetEngine | undefined,
): BudgetPolicy {
  const seats: Record<string, SeatBudgetPolicy> = {};
  for (const seatId of Object.keys(policy.seats).sort()) {
    const stored = policy.seats[seatId]!;
    const next = defaultSeatPolicy(mode, seatId, engineOf?.(seatId) ?? engineOfSeatId(seatId));
    next.enabled = stored.enabled;
    if (stored.resetSpending !== undefined) next.resetSpending = stored.resetSpending;
    if (stored.dailyUsdCap !== undefined) next.dailyUsdCap = stored.dailyUsdCap;
    seats[seatId] = next;
  }
  // Task arms are mode-independent: like `enabled` they are "whether", not
  // "how much", so a mode switch carries them verbatim.
  const taskArms = policy.taskArms === undefined ? {} : { taskArms: cloneTaskArmsPolicy(policy.taskArms) };
  return {
    mode,
    seats,
    updatedAt: nowIso,
    ...(policy.resetSpending ? { resetSpending: { ...policy.resetSpending } } : {}),
    ...taskArms,
  };
}

/** Apply one validated per-seat patch on top of the seat's effective policy. */
export function applySeatPatch(
  policy: BudgetPolicy,
  seatId: string,
  patch: SeatPolicyPatch,
  nowIso: string,
  engine?: BudgetEngine,
): BudgetPolicy {
  const next = effectiveSeatPolicy(policy, seatId, engine);
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.resetSpending !== undefined) {
    if (patch.resetSpending === null) delete next.resetSpending;
    else next.resetSpending = patch.resetSpending;
  }
  if (patch.reservePercent !== undefined) next.reservePercent = patch.reservePercent;
  if (patch.maxSessionWindowPercent !== undefined) {
    if (patch.maxSessionWindowPercent === null) delete next.maxSessionWindowPercent;
    else next.maxSessionWindowPercent = patch.maxSessionWindowPercent;
  }
  if (patch.dailyUsdCap !== undefined) {
    if (patch.dailyUsdCap === null) delete next.dailyUsdCap;
    else next.dailyUsdCap = patch.dailyUsdCap;
  }
  const seats: Record<string, SeatBudgetPolicy> = { ...policy.seats, [seatId]: next };
  const sorted: Record<string, SeatBudgetPolicy> = {};
  for (const id of Object.keys(seats).sort()) sorted[id] = seats[id]!;
  return { mode: policy.mode, seats: sorted, updatedAt: nowIso, ...(policy.resetSpending ? { resetSpending: { ...policy.resetSpending } } : {}) };
}

/** Apply exactly one update form. Pure — the caller persists. */
export function applyBudgetUpdate(
  policy: BudgetPolicy,
  update: BudgetUpdateRequest | ParsedBudgetUpdate,
  nowIso: string,
  engineOf?: (seatId: string) => BudgetEngine | undefined,
): BudgetPolicy {
  const parsed: ParsedBudgetUpdate = 'kind' in update ? update : parseBudgetUpdate(update);
  if (parsed.kind === 'reset-spending') return { ...policy, resetSpending: { enabled: parsed.enabled }, updatedAt: nowIso };
  if (parsed.kind === 'mode') return applyModeSwitch(policy, parsed.mode, nowIso, engineOf);
  return applySeatPatch(policy, parsed.seatId, parsed.patch, nowIso, engineOf?.(parsed.seatId));
}
