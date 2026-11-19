/**
 * Market eligibility inputs for the derived `phm fleet unfed` report.
 *
 * When the dispatcher does not publish `unfed_capacity`, the report can still
 * explain `blocked` by replaying the shared work market's eligibility rules —
 * the same lane_view + choose checks in contrib/mac/work_market.py — over the
 * files the dispatcher itself reads: queue/slots.json executor advertisements,
 * models.json tier coverage, queue/budget-overrides.json quota readings,
 * queue/adaptive.json backoff signals and the HOLD list. Needs come only from
 * each row's declared requirements; prompt-inferred needs (needs_gh) are not
 * reconstructed, so a row whose prompt secretly needs gh is not flagged here.
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
  /** Evaluation instant (epoch ms); adaptive signals older than 300 s are ignored. */
  nowMs?: number;
}

/** One runnable ready.tsv row with its resolved market requirements. */
export interface ReadyMarketRow {
  /** Resolved preferred lane (requirements preferred_lane, else the column hint); null is open. */
  hint: string | null;
  /** Column tier when it is a market tier; null means the row cannot be evaluated. */
  tier: string | null;
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

/** Lenient port of work_market.requirements: invalid fields fall back to open defaults. */
function requirements(cols: string[]): Pick<ReadyMarketRow, 'hint' | 'needs' | 'minTier' | 'maxTier' | 'maxCostClass' | 'dataClass'> {
  const hint = (cols[2] ?? '').trim() || null;
  let spec: Record<string, unknown> | null = null;
  const raw = cols[5];
  if (raw !== undefined && raw.length <= MAX_REQUIREMENTS) {
    try {
      const value: unknown = JSON.parse(raw);
      if (isRecord(value)) spec = value;
    } catch { /* invalid requirements JSON: the row stays open like a legacy row */ }
  }
  let preferred: string | null;
  if (spec !== null && Object.hasOwn(spec, 'preferred_lane')) {
    const value = spec.preferred_lane;
    preferred = typeof value === 'string' && MARKET_PREF.test(value) ? value : value === null ? null : hint;
  } else preferred = hint;
  const needsRaw = spec !== null && Object.hasOwn(spec, 'needs') ? spec.needs : [];
  const needs = Array.isArray(needsRaw) && needsRaw.length <= 64
    && needsRaw.every(n => typeof n === 'string' && n.length <= 128 && MARKET_CAP.test(n))
    ? [...needsRaw as string[]] : [];
  const tierField = (key: 'min_tier' | 'max_tier'): string | null => {
    const value = spec?.[key];
    return known(MARKET_TIERS, value) ? value : null;
  };
  const costRaw = spec?.max_cost_class;
  const dataRaw = spec?.data_class;
  return {
    hint: preferred, needs,
    minTier: tierField('min_tier'), maxTier: tierField('max_tier'),
    maxCostClass: known(MARKET_COSTS, costRaw) ? costRaw : null,
    dataClass: known(MARKET_DATA, dataRaw) ? dataRaw : null,
  };
}

/**
 * Parse dispatcher ready.tsv rows (job, repo, lane hint, tier, prompt[, requirements]).
 * Parked rows, comments and short rows are skipped exactly like readyHints.
 */
export function parseReadyMarketRows(readyTsv: string): ReadyMarketRow[] {
  const rows: ReadyMarketRow[] = [];
  for (const line of readyTsv.split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 5 || !cols[0] || cols[0].startsWith('PARKED-') || (cols[2] ?? '').startsWith('PARKED-')) continue;
    const tier = (cols[3] ?? '').trim();
    const rowRepo = (cols[1] ?? '').trim();
    const specRepo = cols.length > 5 ? cols[5] : undefined;
    let repo: string | null = rowRepo && MARKET_NAME.test(rowRepo) ? rowRepo : null;
    if (repo === null && specRepo !== undefined && specRepo.length <= MAX_REQUIREMENTS) {
      try {
        const value: unknown = JSON.parse(specRepo);
        if (isRecord(value) && typeof value.repo === 'string' && MARKET_NAME.test(value.repo)) repo = value.repo;
      } catch { /* handled by requirements() defaults */ }
    }
    rows.push({
      ...requirements(cols),
      tier: known(MARKET_TIERS, tier) ? tier : null,
      repo,
    });
  }
  return rows;
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
 * when the row fits on paper but still waits (deferral, batch limit, tick end).
 * Rows without a market tier were never evaluated: not_evaluated.
 */
export function derivedRowCodes(row: ReadyMarketRow, lane: string, v: MarketLaneView): string[] {
  if (row.tier === null) return ['not_evaluated'];
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
