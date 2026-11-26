import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { ashlrHome } from '../../cloud/store.js';
import { readPrivateJson, readResourceEvidenceFile } from './store.js';
import type { ResourceLiveSource } from './source-types.js';
import { RESOURCE_LIVE_STALE_MS, type ResourceLiveAllowance, type ResourceLiveClass, type ResourceLiveCustom } from './types.js';

const amount = z.number().finite().nonnegative();
const instant = z.string().datetime();
const unit = z.enum(['percent', 'acu', 'usd', 'points', 'models']);
const source = z.enum(['official-endpoint', 'cli-status', 'agent-check']);
const normalize = (value: string | null) => value === null ? null : new Date(value).toISOString();
const name = z.string().trim().min(1).max(80).regex(/^[\p{L}\p{N} ._+&()/·-]+$/u);
const entrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  name,
  provider: name,
  kind: z.enum(['subscription', 'promo-credit', 'metered', 'local', 'bot']),
  source,
  unit,
  limit: amount.positive().nullable().default(null),
  window_hours: amount.positive().nullable().default(null),
  reset_at: instant.nullable().default(null),
  expires_at: instant.nullable().default(null),
  metered_opt_in: z.boolean().default(false),
}).strict().refine(row => !row.metered_opt_in || row.kind === 'metered');

const classes: Record<ResourceLiveCustom['kind'], ResourceLiveClass> = {
  subscription: 'included', 'promo-credit': 'metered-included', metered: 'reserve', local: 'free', bot: 'included',
};

export interface CustomResource extends ResourceLiveAllowance {
  id: `custom:${string}`;
  custom: ResourceLiveCustom & { revision: string };
  unit: z.infer<typeof unit>;
  limit: number | null;
  resetAt: string | null;
}

export async function readCustomResources(): Promise<CustomResource[]> {
  const raw = await readPrivateJson(join(ashlrHome(), 'custom-resources.json'), 32 * 1024) as Record<string, unknown> | null;
  if (raw?.schema !== 'custom-resources.v1' || !Array.isArray(raw.resources) || raw.resources.length > 32) return [];
  const resources = new Map<string, CustomResource>();
  const duplicates = new Set<string>();
  for (const row of raw.resources) {
    const parsed = entrySchema.safeParse(row);
    if (!parsed.success) continue;
    const e = parsed.data;
    if (resources.has(e.id)) duplicates.add(e.id);
    resources.set(e.id, { id: `custom:${e.id}`, label: e.name, lane: null, sensor_lane: null, class: classes[e.kind],
      expires_at: normalize(e.expires_at), resetAt: normalize(e.reset_at), unit: e.unit, limit: e.limit,
      custom: { provider: e.provider, kind: e.kind, source: e.source, metered_opt_in: e.metered_opt_in,
        window_hours: e.window_hours, revision: createHash('sha256').update(JSON.stringify(e)).digest('hex') } });
  }
  return [...resources.entries()].filter(([id]) => !duplicates.has(id)).map(([, row]) => row);
}

const evidenceSchema = z.object({
  source,
  observed_at: instant,
  used: amount.nullable(),
  limit: amount.positive().nullable().optional(),
  reset_at: instant.nullable().optional(),
  expires_at: instant.optional(),
}).strict();

export function customResourceSources(runsDir: string) {
  let evidence: Promise<unknown> | undefined;
  return (resource: CustomResource): readonly ResourceLiveSource[] => [{
    tier: resource.custom.source === 'agent-check' ? 'operator-entry' : 'official',
    read: async nowMs => {
      const raw = await (evidence ??= readResourceEvidenceFile(runsDir)) as Record<string, unknown> | null;
      if (raw?.schema !== 'resource-evidence.v1' || !raw.readings || typeof raw.readings !== 'object') return null;
      const parsed = evidenceSchema.safeParse((raw.readings as Record<string, unknown>)[resource.id]);
      if (!parsed.success || parsed.data.source !== resource.custom.source) return null;
      const row = parsed.data;
      const observed = Date.parse(row.observed_at);
      const limit = row.limit ?? resource.limit;
      const reset = row.reset_at ?? resource.resetAt;
      const expiry = resource.expires_at ?? row.expires_at;
      if (observed > nowMs || nowMs - observed >= RESOURCE_LIVE_STALE_MS
        || (row.used !== null && limit !== null && row.used > limit)
        || (reset && Date.parse(reset) <= nowMs) || (expiry && Date.parse(expiry) <= nowMs)
        || (resource.custom.kind === 'promo-credit' && !expiry)) return null;
      return { used: row.used, limit, reset_at: reset, ...(expiry ? { expires_at: expiry } : {}), observed_at: row.observed_at,
        unit: resource.unit, source: row.source };
    },
  }];
}
