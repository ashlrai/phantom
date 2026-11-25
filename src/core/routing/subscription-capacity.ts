/**
 * Included (non-metered) subscription capacity per provider seat, for
 * subscription arbitrage: which plan on which account kind gives which models
 * under which refresh window and caps. Pure data plus lookups; no I/O.
 *
 * Unknown caps and model lists stay null, never 0. `metered` rows are opt-in
 * and never added to a default route. Google facts verified 2026-11-25 from
 * antigravity.google/docs/workspace, antigravity.google/pricing, the
 * geminicli.com quota page and the Gemini 4 Neon API model page.
 */
export const SUBSCRIPTION_CAPACITY_SCHEMA = 'route.subscription-capacity.v1' as const;

export type SeatAccountKind = 'personal' | 'workspace' | 'cloud-project' | 'api-key';
export type SeatCostClass = 'free' | 'included' | 'metered';
export type SeatRefreshWindow = '5h' | 'daily' | 'weekly';
export type SeatLabel = 'starter-quota';

export interface SubscriptionSeatCapacity {
  provider: 'google' | 'anthropic' | 'openai';
  /** Fleet lane that spends this seat; null when no job lane uses it yet. */
  lane: 'agy' | 'gemini' | 'claude' | 'codex' | null;
  product: string;
  account_kind: SeatAccountKind;
  plan: string;
  cost_class: SeatCostClass;
  /** Metered rows need an explicit owner opt-in; included and free rows do not. */
  opt_in: boolean;
  /** Model families the plan includes; null when the provider does not list them. */
  models: readonly string[] | null;
  /** Windows that refresh the allowance, shortest first; empty when unknown. */
  refresh: readonly SeatRefreshWindow[];
  daily_requests: number | null;
  weekly_cap: number | null;
  /** True or false only where the provider states it; null when unstated. */
  neon: boolean | null;
  label: SeatLabel | null;
  source: string;
}

const AGY_FREE = ['gemini-4-hydrogen', 'gemini-3.8-flash', 'claude-sonnet-4-6', 'claude-opus-4-6', 'gpt-oss-120b'] as const;
const AGY_PAID = [...AGY_FREE, 'gemini-4-neon', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-4-orchestrator', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const;
const AGY_PRICING = 'https://antigravity.google/pricing';
const AGY_WORKSPACE = 'https://antigravity.google/docs/workspace';
const CLI_QUOTA = 'https://geminicli.com/docs/';
const API_PRICING = 'https://aistudio.google.com/docs/models/gemini-4-neon';

const row = (r: Omit<SubscriptionSeatCapacity, 'opt_in' | 'label' | 'daily_requests' | 'weekly_cap'> &
  Partial<Pick<SubscriptionSeatCapacity, 'label' | 'daily_requests' | 'weekly_cap'>>): SubscriptionSeatCapacity =>
  Object.freeze({ daily_requests: null, weekly_cap: null, label: null, ...r, opt_in: r.cost_class === 'metered' });

export const SUBSCRIPTION_CAPACITY: readonly SubscriptionSeatCapacity[] = Object.freeze([
  row({ provider: 'google', lane: 'agy', product: 'antigravity', account_kind: 'personal', plan: 'free', cost_class: 'free',
    models: AGY_FREE, refresh: ['weekly'], neon: false, source: AGY_PRICING }),
  row({ provider: 'google', lane: 'agy', product: 'antigravity', account_kind: 'personal', plan: 'google-ai-pro', cost_class: 'included',
    models: AGY_PAID, refresh: ['5h', 'weekly'], neon: true, source: AGY_PRICING }),
  row({ provider: 'google', lane: 'agy', product: 'antigravity', account_kind: 'personal', plan: 'google-ai-ultra', cost_class: 'included',
    models: AGY_PAID, refresh: ['5h', 'weekly'], neon: true, source: AGY_PRICING }),
  // Workspace plans include no Antigravity plan, higher rate limits or AI credits: only a limited starter quota.
  row({ provider: 'google', lane: 'agy', product: 'antigravity', account_kind: 'workspace', plan: 'workspace', cost_class: 'included',
    models: null, refresh: [], neon: false, label: 'starter-quota', source: AGY_WORKSPACE }),
  row({ provider: 'google', lane: 'agy', product: 'antigravity', account_kind: 'workspace', plan: 'gemini-enterprise', cost_class: 'included',
    models: null, refresh: [], neon: null, source: AGY_WORKSPACE }),
  row({ provider: 'google', lane: 'agy', product: 'antigravity', account_kind: 'cloud-project', plan: 'google-cloud', cost_class: 'metered',
    models: null, refresh: [], neon: null, source: AGY_WORKSPACE }),
  // Gemini CLI does not support gemini-4-neon yet (google-gemini/gemini-cli#30385).
  ...([['personal', 'code-assist-individuals', 'free', 1000], ['personal', 'google-ai-pro', 'included', 1500],
    ['personal', 'google-ai-ultra', 'included', 2000], ['workspace', 'code-assist-standard', 'included', 1500],
    ['workspace', 'code-assist-enterprise', 'included', 2000], ['api-key', 'unpaid', 'free', 250]] as const)
    .map(([account_kind, plan, cost_class, daily]) => row({ provider: 'google', lane: 'gemini', product: 'gemini-cli', account_kind, plan,
      cost_class, models: null, refresh: ['daily'], daily_requests: daily, neon: false, source: CLI_QUOTA })),
  row({ provider: 'google', lane: null, product: 'gemini-api', account_kind: 'api-key', plan: 'free-tier', cost_class: 'free',
    models: null, refresh: [], neon: false, source: API_PRICING }),
  row({ provider: 'google', lane: null, product: 'gemini-api', account_kind: 'api-key', plan: 'paid-tier', cost_class: 'metered',
    models: ['gemini-4-neon', 'gemini-4-carbon', 'gemini-4-hydrogen'], refresh: [], neon: true, source: API_PRICING }),
  // Claude and Codex windows mirror the seat readers (usage/provider-windows.ts, fleet/subscription-usage.ts); caps are unpublished.
  ...(['pro', 'max', 'team', 'enterprise'] as const).map(plan => row({ provider: 'anthropic', lane: 'claude', product: 'claude-code',
    account_kind: plan === 'pro' || plan === 'max' ? 'personal' : 'workspace', plan, cost_class: 'included', models: null, refresh: ['weekly'],
    neon: false, source: 'https://code.claude.com/docs/en/overview' })),
  ...(['plus', 'pro', 'business', 'enterprise'] as const).map(plan => row({ provider: 'openai', lane: 'codex', product: 'codex',
    account_kind: plan === 'plus' || plan === 'pro' ? 'personal' : 'workspace', plan, cost_class: 'included', models: null,
    refresh: ['5h', 'weekly'], neon: false, source: 'https://developers.openai.com/codex/' })),
]);

/** Operator-declared seat sign-in for one lane, from `<runs>/queue/subscription-seats.json`. */
export interface DeclaredSeat { account_kind: SeatAccountKind; plan: string }

const KINDS: readonly SeatAccountKind[] = ['personal', 'workspace', 'cloud-project', 'api-key'];
const PLAN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Strict parse; malformed lanes are dropped, never guessed. */
export function parseDeclaredSeats(raw: unknown): Record<string, DeclaredSeat> {
  const out: Record<string, DeclaredSeat> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [lane, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(lane) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const kind = v.account_kind, plan = v.plan ?? (kind === 'workspace' ? 'workspace' : null);
    if (Object.keys(v).some(k => k !== 'account_kind' && k !== 'plan')) continue;
    if (typeof kind !== 'string' || !KINDS.includes(kind as SeatAccountKind) || typeof plan !== 'string' || !PLAN.test(plan)) continue;
    out[lane] = { account_kind: kind as SeatAccountKind, plan };
  }
  return out;
}

/** The capacity row for a declared seat, or null when the plan is not catalogued. */
export function seatCapacity(lane: string, seat: DeclaredSeat | undefined): SubscriptionSeatCapacity | null {
  if (!seat) return null;
  const rows = SUBSCRIPTION_CAPACITY.filter(r => r.lane === lane && r.account_kind === seat.account_kind);
  return rows.find(r => r.plan === seat.plan) ?? null;
}

/** An Antigravity lane signed into a Workspace account runs on the starter quota unless it holds Gemini Enterprise seats. */
export function seatLabel(lane: string, seat: DeclaredSeat | undefined): SeatLabel | null {
  if (lane !== 'agy' || seat?.account_kind !== 'workspace') return null;
  return seatCapacity(lane, seat)?.label ?? (seat.plan === 'gemini-enterprise' ? null : 'starter-quota');
}

export interface GoogleSeatRow {
  lane: 'agy' | 'gemini';
  active: boolean;
  account_kind: SeatAccountKind | null;
  plan: string | null;
  cost_class: SeatCostClass | null;
  label: SeatLabel | null;
  neon: boolean | null;
  refresh: readonly SeatRefreshWindow[];
  daily_requests: number | null;
  weekly_cap: number | null;
  source: string | null;
}
export interface GoogleSeatReadout {
  schema: typeof SUBSCRIPTION_CAPACITY_SCHEMA;
  advisory: true;
  /** Lane the router prefers for Google work: a non-starter included seat first. */
  active: 'agy' | 'gemini' | null;
  /** Whether the active seat reaches Gemini 4 Neon on included capacity; null when unknown. */
  neon: boolean | null;
  seats: GoogleSeatRow[];
  metered_opt_in: false;
}

export function googleSeatReadout(raw: unknown): GoogleSeatReadout {
  const declared = parseDeclaredSeats(raw);
  const seats = (['agy', 'gemini'] as const).map((lane): GoogleSeatRow => {
    const seat = declared[lane], cap = seatCapacity(lane, seat);
    return { lane, active: false, account_kind: seat?.account_kind ?? null, plan: seat?.plan ?? null,
      cost_class: cap?.cost_class ?? null, label: seatLabel(lane, seat), neon: cap?.neon ?? null, refresh: cap?.refresh ?? [],
      daily_requests: cap?.daily_requests ?? null, weekly_cap: cap?.weekly_cap ?? null, source: cap?.source ?? null };
  });
  const usable = seats.filter(s => s.account_kind !== null && s.cost_class !== 'metered');
  const pick = usable.find(s => s.label === null) ?? usable[0] ?? null;
  if (pick) pick.active = true;
  return { schema: SUBSCRIPTION_CAPACITY_SCHEMA, advisory: true, active: pick?.lane ?? null, neon: pick ? pick.neon : null,
    seats, metered_opt_in: false };
}
