import type { PoolResourceView, ResourcePool, ResourceStatus, ResourceView } from './resource-view.js';

/** Provider capacity pools: which accounts belong to which vendor. Usage numbers only, never credentials. */
export const PROVIDER_CARD_SCHEMA = 'provider-cards.v1' as const;
export const PROVIDERS = ['openai', 'anthropic', 'cognition', 'xai'] as const;
export type ProviderId = typeof PROVIDERS[number];

export const PROVIDER_POOLS: Readonly<Record<ProviderId, readonly ResourcePool[]>> = {
  openai: ['codex-cmp', 'codex-personal', 'terra'],
  anthropic: ['claude-max'],
  cognition: ['devin'],
  xai: ['grok-ultra'],
};
export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = {
  openai: 'OpenAI', anthropic: 'Anthropic', cognition: 'Cognition / Devin', xai: 'xAI',
};

export interface ProviderCard {
  provider: ProviderId;
  label: string;
  /** Worst known pool status; `unknown` only when no pool has a reading. */
  status: ResourceStatus;
  /** Highest known share used across the provider's pools, or null. Never averaged or invented. */
  maxPctUsed: number | null;
  /** Earliest upcoming reset across pools with a reading, or null. */
  nextResetAt: string | null;
  pools: PoolResourceView[];
}
export interface ProviderCardsView {
  schema: typeof PROVIDER_CARD_SCHEMA;
  generatedAt: string;
  providers: ProviderCard[];
  localModels: ResourceView['localModels'];
}

/** Best-effort vendor of a worker's free-form provider name; null (not guessed) when unrecognised. */
export function providerOfName(name: string): ProviderId | null {
  const n = name.toLowerCase();
  if (/openai|codex|gpt/.test(n)) return 'openai';
  if (/anthropic|claude/.test(n)) return 'anthropic';
  if (/devin|cognition/.test(n)) return 'cognition';
  if (/xai|grok/.test(n)) return 'xai';
  return null;
}

const SEVERITY: Record<ResourceStatus, number> = { unknown: 0, green: 1, amber: 2, red: 3 };

export function buildProviderCards(view: ResourceView): ProviderCardsView {
  const providers = PROVIDERS.map((provider): ProviderCard => {
    const pools = PROVIDER_POOLS[provider].flatMap(id => view.pools.filter(pool => pool.pool === id));
    const known = pools.filter(pool => pool.status !== 'unknown');
    const used = pools.flatMap(pool => pool.pctUsed === null ? [] : [pool.pctUsed]);
    const resets = known.flatMap(pool => pool.resetAt === null ? [] : [pool.resetAt]).sort();
    return { provider, label: PROVIDER_LABELS[provider],
      status: known.reduce<ResourceStatus>((worst, pool) => SEVERITY[pool.status] > SEVERITY[worst] ? pool.status : worst, 'unknown'),
      maxPctUsed: used.length ? Math.max(...used) : null, nextResetAt: resets[0] ?? null, pools };
  });
  return { schema: PROVIDER_CARD_SCHEMA, generatedAt: view.generatedAt, providers, localModels: view.localModels };
}

const pct = (value: number | null) => value === null ? 'unknown' : `${value.toFixed(1)}%`;

/** Plain-text rendering for `phm resource --cards`. */
export function formatProviderCards(cards: ProviderCardsView): string {
  const lines: string[] = [];
  for (const card of cards.providers) {
    lines.push(`${card.label}: ${card.status}, highest used ${pct(card.maxPctUsed)}, next reset ${card.nextResetAt ?? 'unknown'}`);
    for (const pool of card.pools) {
      lines.push(`  ${pool.pool}: ${pool.status}, used ${pct(pool.pctUsed)}, reset ${pool.resetAt ?? 'unknown'}, `
        + `exhaustion ${pool.projectedExhaustionAt ?? (pool.status === 'green' && pool.burnRatePerHour === 0 ? 'none at observed burn' : 'unknown')}`);
    }
  }
  lines.push(`Local models: ${cards.localModels.count ?? 'unknown'}`);
  return lines.join('\n') + '\n';
}
