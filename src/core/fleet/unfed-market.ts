/**
 * Market eligibility inputs for the derived `phm fleet unfed` report.
 *
 * When the dispatcher does not publish `unfed_capacity`, the report can still
 * explain `blocked` by replaying the shared work market's eligibility rules —
 * the same lane_view + choose checks in contrib/mac/work_market.py — over the
 * files the dispatcher itself reads: queue/slots.json executor advertisements,
 * models.json tier coverage, queue/budget-overrides.json quota readings,
 * queue/adaptive.json backoff signals, queue/router-queue.md requirement
 * envelopes and the HOLD list. Needs come only from each row's declared
 * requirements; prompt-inferred needs (needs_gh) are not reconstructed, so a
 * row whose prompt secretly needs gh is not flagged here. Rows are validated
 * exactly like work_market.requirements: an invalid job id, tier or spec
 * rejects the row before the market sees it, so it is counted as invalid and
 * never scored. Launch preconditions outside the market (the repo clone under
 * ~/Projects/ashlrai and the prompt file under queue/prompts) are not
 * modelled: a row missing them still counts as waiting here.
 * Pure: text in, codes out. No job ids, task text or credentials.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const MARKET_TIERS: Readonly<Record<string, number>> = { fast: 0, mid: 1, work: 2, frontier: 3 };
const MARKET_COSTS: Readonly<Record<string, number>> = { local: 0, included: 1, metered: 2 };
const MARKET_DATA: Readonly<Record<string, number>> = { public: 0, internal: 1, confidential: 2, restricted: 3 };
const MARKET_BUILTIN = new Set(['codex-cmp', 'codex-personal', 'claude', 'devin', 'claude-api', 'codex-local', 'omlx']);
const MARKET_LOCAL = new Set(['codex-local', 'omlx']);
const MARKET_CAP = /^(?:[a-z][a-z0-9-]*|secrets:[A-Za-z0-9_.-]+)$/;
const MARKET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MARKET_PREF = /^[a-z][a-z0-9-]*$/;
const MAX_REQUIREMENTS = 8192;

const rank = (table: Readonly<Record<string, number>>, key: string): number | undefined => table[key];
const known = (table: Readonly<Record<string, number>>, key: unknown): key is string =>
  typeof key === 'string' && rank(table, key) !== undefined;

/** Raw text of the dispatcher's market inputs; absent files stay null. */
export interface UnfedMarketInputs {
  /** queue/slots.json: host executor advertisements. */
  slots?: string | null;
  /** models.json at the runs root: configured model keys filter lane tiers. */
  models?: string | null;
  /** queue/budget-overrides.json: per-lane quota readings. */
  budget?: string | null;
  /** queue/adaptive.json: optional host signals; needs nowMs to prove freshness. */
  adaptive?: string | null;
  /** HOLD at the runs root: operator-held lane names. */
  hold?: string | null;
  /** queue/router-queue.md: `(attrs)` envelopes resolve spec-less ready rows' requirements. */
  routerQueue?: string | null;
  /** Evaluation instant (epoch ms); adaptive signals older than 300 s are ignored, and status.json's last_tick freshness is judged against it. */
  nowMs?: number;
}

/** One runnable ready.tsv row with its resolved market requirements. */
export interface ReadyMarketRow {
  /** Resolved preferred lane (requirements preferred_lane, else the column hint); null is open. */
  hint: string | null;
  /** Column tier; always a market tier — other rows are rejected before parsing finishes. */
  tier: string;
  /** Repo name when the row or its requirements name a valid one. */
  repo: string | null;
  needs: string[];
  minTier: string | null;
  maxTier: string | null;
  maxCostClass: string | null;
  dataClass: string | null;
}

const parseJson = (text: string | null | undefined): unknown => {
  if (text === null || text === undefined) return null;
  try { return JSON.parse(text); } catch { return null; }
};

const JOB_ID = /^[A-Za-z0-9._-]+$/;
const SPEC_KEYS = new Set(['preferred_lane', 'needs', 'min_tier', 'max_tier', 'max_cost_class',
  'data_class', 'work_class', 'repo', 'exclusive', 'priority', 'impact']);
const WORK_CLASSES = new Set(['bulk', 'standard', 'judgment']);
const MARKET_PRIORITY = /^P[0-9]{1,6}$/;
const MARKET_FLOAT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** work_market.from_envelope's attr reader: first `name=value` after start/space/punct. */
function envelopeField(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|[,;\\s])${name}=([^,;\\s]+)`).exec(attrs);
  return match === null ? null : match[1]!;
}

/**
 * Port of work_market.from_envelope: build the spec dict a five-column ready row
 * inherits from its `- STATUS ... (attrs):` line in queue/router-queue.md.
 * Returns null where from_envelope raises before requirements() runs
 * (a malformed exclusive or impact). needs_gh is skipped: the dispatcher calls
 * from_envelope without a prompt, so no gh need is ever inferred here.
 */
function envelopeSpec(attrs: string): Record<string, unknown> | null {
  const spec: Record<string, unknown> = {
    preferred_lane: envelopeField(attrs, 'preferred_lane')
      ?? envelopeField(attrs, 'lane') ?? envelopeField(attrs, 'pool') ?? null,
  };
  const needs = envelopeField(attrs, 'needs');
  if (needs !== null) spec.needs = needs.replace(/^[[\]]+|[[\]]+$/g, '').split('|');
  for (const key of ['min_tier', 'max_tier', 'max_cost_class', 'data_class', 'work_class'] as const) {
    const value = envelopeField(attrs, key);
    if (value !== null) spec[key] = value;
  }
  const exclusive = envelopeField(attrs, 'exclusive');
  if (exclusive !== null) {
    if (exclusive !== 'true' && exclusive !== 'false') return null;
    spec.exclusive = exclusive === 'true';
  }
  const priority = /\bP[0-9]+\b/.exec(attrs);
  if (priority !== null) spec.priority = priority[0];
  const impact = envelopeField(attrs, 'impact');
  if (impact !== null) {
    // Python float() also accepts digit underscores; strip them before Number().
    const text = impact.trim().replace(/(?<=\d)_(?=\d)/g, '');
    if (!MARKET_FLOAT.test(text)) return null;
    const value = Number(text);
    if (!Number.isFinite(value)) return null;
    spec.impact = value;
  }
  return spec;
}

/**
 * The `(attrs)` of this job's first matching line in router-queue.md, or null.
 * Same shape as dispatchd's per-row re.search over PRIORITY_QUEUE.
 */
function envelopeAttrs(routerQueue: string | null | undefined, job: string): string | null {
  if (routerQueue === null || routerQueue === undefined || !routerQueue.includes(job)) return null;
  const match = new RegExp(
    `^- [A-Z][A-Z-]* (?:[A-Za-z0-9._:@/-]+ )*?${escapeRe(job)}(?: r\\d+)? \\(([^)\\n]*)\\):`,
    'm',
  ).exec(routerQueue);
  return match === null ? null : match[1]!;
}

/**
 * Strict port of work_market.requirements: returns the row's resolved fields,
 * or null where the Python raises (unknown key, malformed field, tier order,
 * repo disagreement). The dispatcher drops such rows before the market sees
 * them, so they are invalid rather than open.
 */
function resolveRow(cols: string[], spec: Record<string, unknown>):
  Omit<ReadyMarketRow, 'tier'> | null {
  if (Object.keys(spec).some(key => !SPEC_KEYS.has(key))) return null;
  const has = (key: string): boolean => Object.hasOwn(spec, key);
  let hint: string | null;
  if (has('preferred_lane')) {
    const value = spec.preferred_lane;
    if (value === null) hint = null;
    else if (typeof value === 'string' && MARKET_PREF.test(value)) hint = value;
    else return null;
  } else {
    const lane = cols[2] ?? '';
    if (lane === '') hint = null;
    else if (MARKET_PREF.test(lane)) hint = lane;
    else return null;
  }
  let needs: string[] = [];
  if (has('needs')) {
    const value = spec.needs;
    if (!Array.isArray(value) || value.length > 64
      || !value.every(n => typeof n === 'string' && n.length <= 128 && MARKET_CAP.test(n))) return null;
    needs = [...value as string[]];
  }
  const tierField = (key: 'min_tier' | 'max_tier'): string | null | false => {
    if (!has(key)) return null;
    const value = spec[key];
    return known(MARKET_TIERS, value) ? value : false;
  };
  const minTier = tierField('min_tier');
  const maxTier = tierField('max_tier');
  if (minTier === false || maxTier === false) return null;
  if (minTier !== null && maxTier !== null
    && (rank(MARKET_TIERS, minTier) ?? 0) > (rank(MARKET_TIERS, maxTier) ?? 0)) return null;
  if ((has('data_class') && !known(MARKET_DATA, spec.data_class))
    || (has('work_class') && !(typeof spec.work_class === 'string' && WORK_CLASSES.has(spec.work_class)))
    || (has('max_cost_class') && !known(MARKET_COSTS, spec.max_cost_class))
    || (has('exclusive') && typeof spec.exclusive !== 'boolean')
    || (has('priority') && !(typeof spec.priority === 'string' && MARKET_PRIORITY.test(spec.priority)))
    || (has('impact') && !(typeof spec.impact === 'number' && Number.isFinite(spec.impact)))) return null;
  const rowRepo = (cols[1] ?? '') === '' ? null : cols[1]!;
  let repo: string | null = null;
  if (has('repo') && spec.repo !== null && spec.repo !== undefined) {
    if (typeof spec.repo !== 'string' || !MARKET_NAME.test(spec.repo)) return null;
    if (rowRepo !== null && spec.repo !== rowRepo) return null;
    repo = spec.repo;
  }
  if (rowRepo !== null && MARKET_NAME.test(rowRepo)) repo = rowRepo;
  return {
    hint, needs, repo, minTier, maxTier,
    maxCostClass: has('max_cost_class') && known(MARKET_COSTS, spec.max_cost_class) ? spec.max_cost_class : null,
    dataClass: has('data_class') && known(MARKET_DATA, spec.data_class) ? spec.data_class : null,
  };
}

/**
 * Parse dispatcher ready.tsv rows (job, repo, lane hint, tier, prompt[, requirements]).
 * Parked rows, comments and short rows are skipped exactly like readyHints; rows
 * the dispatcher's ok-check or work_market.requirements would reject are counted
 * in `invalid` and never reach the market. Five-column rows resolve their spec
 * from the matching router-queue.md envelope; dispatchd then re-validates that
 * spec against the row's own fields (market_specs), so the repo column still
 * feeds spec.repo — repo_unserved is scored by the real repo, not dropped.
 */
export function parseReadyMarketRows(readyTsv: string, routerQueue?: string | null): { rows: ReadyMarketRow[]; invalid: number } {
  const rows: ReadyMarketRow[] = [];
  let invalid = 0;
  for (const line of readyTsv.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 5 || !cols[0] || cols[0].startsWith('PARKED-') || (cols[2] ?? '').startsWith('PARKED-')) continue;
    const job = cols[0]!;
    if (!JOB_ID.test(job) || cols[1]!.includes('/')) { invalid++; continue; }
    const tier = cols[3]!;
    if (!known(MARKET_TIERS, tier)) { invalid++; continue; }
    let spec: Record<string, unknown> = {};
    if (cols.length > 5) {
      const raw = cols[5]!;
      if ([...raw].length > MAX_REQUIREMENTS) { invalid++; continue; }
      try {
        const value: unknown = JSON.parse(raw);
        if (!isRecord(value)) { invalid++; continue; }
        spec = value;
      } catch { invalid++; continue; }
    } else {
      // Spec-less rows are validated like work_market.requirements first: the
      // lane column defaults to preferred_lane, so a non-empty cell that is
      // not a lane id rejects the row before its router-queue envelope is read.
      const laneCell = cols[2] ?? '';
      if (laneCell !== '' && !MARKET_PREF.test(laneCell)) { invalid++; continue; }
      const attrs = envelopeAttrs(routerQueue, job);
      if (attrs !== null) {
        const env = envelopeSpec(attrs);
        if (env === null) { invalid++; continue; }
        spec = env;
      }
    }
    const row = resolveRow(cols, spec);
    if (row === null) { invalid++; continue; }
    rows.push({ ...row, tier });
  }
  return { rows, invalid };
}

/**
 * The dispatcher's admission-stopped waiting set (dispatchd's `_waiting` else
 * branch): when the launch gate kept the market from running, every non-parked
 * row with a valid job id and tier counts, hinted by its raw lane column —
 * requirements are never parsed, so spec-invalid rows still wait. No per-row
 * market fields are produced.
 */
export function stoppedReadyHints(readyTsv: string): { waiting: number; byLane: Map<string, number> } {
  const byLane = new Map<string, number>();
  let waiting = 0;
  for (const line of readyTsv.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 5 || cols[0]!.startsWith('PARKED-') || (cols[2] ?? '').startsWith('PARKED-')) continue;
    if (!JOB_ID.test(cols[0]!) || !known(MARKET_TIERS, cols[3]!)) continue;
    waiting++;
    const lane = cols[2] || '';
    byLane.set(lane, (byLane.get(lane) ?? 0) + 1);
  }
  return { waiting, byLane };
}

/** Shared market inputs parsed once per report. */
interface MarketContext {
  slots: Record<string, unknown>;
  modelKeys: ReadonlySet<string>;
  /** lane -> quota readings, the fleet_controller.lane_quota projection. */
  quota: ReadonlyMap<string, { remainingPct: number | null; creditsRemaining: number | null }>;
  /** lane -> adaptive signal record; empty unless adaptive.json is fresh. */
  signals: Record<string, unknown>;
  holds: ReadonlySet<string>;
}

/** Parse the optional market inputs. Null when slots.json is absent or unreadable. */
export function marketContext(market: UnfedMarketInputs | undefined): MarketContext | null {
  if (market === undefined) return null;
  const slots = parseJson(market.slots);
  if (!isRecord(slots)) return null;
  const models = parseJson(market.models);
  const modelKeys = isRecord(models) ? new Set(Object.keys(models)) : new Set<string>();
  const budget = parseJson(market.budget);
  const quota = new Map<string, { remainingPct: number | null; creditsRemaining: number | null }>();
  if (isRecord(budget)) {
    for (const [lane, value] of Object.entries(budget)) {
      const o = isRecord(value) ? value : {};
      const used = finite(o.weekly_used_pct);
      quota.set(lane, {
        remainingPct: used === null ? null : Math.round(Math.max(0, 100 - used) * 10) / 10,
        creditsRemaining: finite(o.credits_remaining),
      });
    }
  }
  let signals: Record<string, unknown> = {};
  const adaptive = parseJson(market.adaptive);
  if (isRecord(adaptive)) {
    const ts = finite(adaptive.ts);
    const nowS = market.nowMs === undefined ? null : market.nowMs / 1000;
    if (ts !== null && nowS !== null && nowS - ts >= 0 && nowS - ts <= 300 && isRecord(adaptive.lanes)) {
      signals = adaptive.lanes;
    }
  }
  const holds = new Set((market.hold ?? '').split(/\s+/).filter(Boolean));
  return { slots, modelKeys, quota, signals, holds };
}

/** The eligibility-relevant slice of work_market.lane_view for one lane. */
interface MarketLaneView {
  capabilities: ReadonlySet<string> | null;
  tiers: string[];
  costClass: string | null;
  held: boolean;
  authFailed: boolean;
  quota: number | null;
  backoff: boolean;
  local: boolean;
  repos: ReadonlySet<string> | null;
  dataClass: string;
  running: number;
  target: number;
}

function executorCapabilities(lane: string, slot: Record<string, unknown>): ReadonlySet<string> | null {
  const defaults = ['git', 'node',
    ...(lane === 'claude' ? [] : ['gh']),
    ...(lane.startsWith('codex') ? ['codex-cli'] : lane === 'claude' ? ['claude-cli'] : [])];
  const advertised = slot.capabilities;
  if (advertised === undefined) return new Set(defaults);
  return Array.isArray(advertised) && advertised.every(c => typeof c === 'string' && MARKET_CAP.test(c))
    ? new Set(advertised as string[]) : null;
}

/** Port of work_market.hard_down for the derived view; operator_hold comes from HOLD. */
function hardDown(slot: Record<string, unknown>, operatorHold: boolean): boolean {
  if (slot.auth_failed === true || finite(slot.quota) === 0) return true;
  if (!slot.held) return false;
  if (slot.held_reason === 'auth_failure') return true;
  return !operatorHold && (slot.held_by === 'autobackoff'
    || String(slot.held_reason ?? '').startsWith('credits exhausted'));
}

/** Build the lane_view slice for one status.json lane. */
export function marketLaneView(
  lane: string, running: number, target: number, statusHeld: boolean, ctx: MarketContext,
): MarketLaneView {
  const slot = isRecord(ctx.slots[lane]) ? ctx.slots[lane] as Record<string, unknown> : {};
  const family = lane.startsWith('codex') && lane !== 'codex-local' ? 'codex' : lane;
  const local = MARKET_LOCAL.has(lane);
  const capabilities = executorCapabilities(lane, slot);
  let tiers: string[];
  const slotTiers = slot.tiers;
  if (slotTiers === undefined) {
    tiers = local ? ['fast', 'mid'] : MARKET_BUILTIN.has(lane) ? Object.keys(MARKET_TIERS) : [];
  } else {
    tiers = Array.isArray(slotTiers) && slotTiers.every(t => typeof t === 'string' && known(MARKET_TIERS, t))
      ? [...slotTiers as string[]] : [];
  }
  if (ctx.modelKeys.size > 0 && (ctx.modelKeys.has(family) || [...ctx.modelKeys].some(k => k.startsWith(family + '.')))) {
    tiers = tiers.filter(t => ctx.modelKeys.has(family) || ctx.modelKeys.has(family + '.' + t));
  }
  const costRaw = slot.cost_class;
  const costClass = typeof costRaw === 'string' ? costRaw
    : costRaw === undefined
      ? (local ? 'local' : lane === 'claude-api' || lane === 'devin' ? 'metered' : MARKET_BUILTIN.has(lane) ? 'included' : null)
      : null;
  const knownQuota = [finite(slot.quota), ctx.quota.get(lane)?.remainingPct ?? null, ctx.quota.get(lane)?.creditsRemaining ?? null]
    .filter((n): n is number => n !== null);
  let repos: ReadonlySet<string> | null = null;
  if (slot.repos !== undefined) {
    repos = Array.isArray(slot.repos) && slot.repos.every(r => typeof r === 'string' && MARKET_NAME.test(r))
      ? new Set(slot.repos as string[]) : new Set<string>();
  }
  const clearance = slot.data_class;
  const dataClass = typeof clearance === 'string' && known(MARKET_DATA, clearance) ? clearance
    : clearance === undefined ? (local ? 'restricted' : MARKET_BUILTIN.has(lane) ? 'internal' : 'public') : 'public';
  const signal = isRecord(ctx.signals[lane]) ? ctx.signals[lane] as Record<string, unknown> : {};
  return {
    capabilities, tiers, costClass,
    held: Boolean(slot.held) || ctx.holds.has(lane) || statusHeld,
    authFailed: hardDown(slot, ctx.holds.has(lane)),
    quota: knownQuota.length ? Math.min(...knownQuota) : null,
    backoff: Boolean(slot.backoff) || signal.backoff === true,
    local, repos, dataClass,
    running, target,
  };
}

/**
 * The reason codes work_market.choose would record for this row on this lane:
 * the eligibility rejections in dispatcher order, or deferred_after_selection
 * when the row fits on paper but still waits (deferral, batch limit, tick end,
 * or a pre-choose gate like RETIRED/diskguard this view cannot see — the
 * dispatcher's own not_evaluated for those).
 */
export function derivedRowCodes(row: ReadyMarketRow, lane: string, v: MarketLaneView): string[] {
  const reasons: string[] = [];
  if (!row.needs.every(n => v.capabilities !== null && v.capabilities.has(n))) reasons.push('missing_capability');
  const tierRank = rank(MARKET_TIERS, row.tier) ?? -1;
  const minRank = row.minTier === null ? 0 : rank(MARKET_TIERS, row.minTier) ?? 0;
  const laneTop = v.tiers.reduce((m, t) => Math.max(m, rank(MARKET_TIERS, t) ?? -1), -1);
  if (!v.tiers.includes(row.tier) || laneTop < Math.max(tierRank, minRank) || tierRank < minRank) {
    reasons.push('tier_unavailable');
  }
  if (row.maxTier !== null && tierRank > (rank(MARKET_TIERS, row.maxTier) ?? -1)) reasons.push('tier_ceiling_exceeded');
  if (v.repos !== null && (row.repo === null || !v.repos.has(row.repo))) reasons.push('repo_unserved');
  if (row.dataClass !== null && (rank(MARKET_DATA, row.dataClass) ?? 0) > (rank(MARKET_DATA, v.dataClass) ?? 0)) {
    reasons.push('data_class_exceeded');
  }
  if (v.local && row.hint !== lane) reasons.push('local_opt_in_required');
  if ((row.hint === 'codex-local' || row.hint === 'omlx') && lane !== row.hint) reasons.push('local_execution_required');
  const cost = v.costClass === null ? undefined : rank(MARKET_COSTS, v.costClass);
  if (cost === undefined) reasons.push('cost_class_unknown');
  else if (cost > (row.maxCostClass === null ? 2 : rank(MARKET_COSTS, row.maxCostClass) ?? 2)) {
    reasons.push('cost_class_exceeded');
  }
  if (v.held) reasons.push('held');
  if (v.authFailed) reasons.push('auth_failed_or_zero_quota');
  if (v.quota !== null && v.quota <= 0) reasons.push('quota_exhausted');
  if (v.backoff) reasons.push('provider_backoff');
  if (v.running >= v.target) reasons.push('saturated');
  if (v.capabilities === null) reasons.push('invalid_capability_advertisement');
  return reasons.length ? reasons : ['deferred_after_selection'];
}
