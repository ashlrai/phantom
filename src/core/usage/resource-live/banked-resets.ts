import { join } from 'node:path';
import { z } from 'zod';
import { readPrivateJson, readResourceEvidenceFile } from './store.js';
import { RESOURCE_LIVE_STALE_MS, type BankedResetGrant, type BurnDownPlan, type BurnDownRow } from './types.js';

const time = z.iso.datetime().refine(value => Number.isFinite(Date.parse(value)));
const grantSchema = z.object({
  count: z.number().int().min(1).max(100),
  kind: z.enum(['full', '5h', 'weekly']),
  expires_at: time,
  source: z.literal('chatgpt-settings-usage'),
}).strict();
const bankSchema = z.object({ observed_at: time, count: z.number().int().min(0).max(100), grants: z.array(grantSchema).max(100) })
  .strict().refine(row => row.grants.reduce((n, grant) => n + grant.count, 0) === row.count);

interface ResetInputs { observed_at: string | null; grants: BankedResetGrant[] | null; queued: number | null }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

export async function readBankedResets(runsDir: string, now: number): Promise<ResetInputs> {
  const [evidence, status] = await Promise.all([
    readResourceEvidenceFile(runsDir), readPrivateJson(join(runsDir, 'queue', 'status.json'), 1024 * 1024),
  ]).then(rows => rows.map(object));
  const entry = evidence?.['schema'] === 'resource-evidence.v1' ? object(evidence['readings'])['codex-personal-resets'] : null;
  const parsed = bankSchema.safeParse(entry);
  const age = parsed.success ? now - Date.parse(parsed.data.observed_at) : Infinity;
  const tick = now - Date.parse(String(status?.['last_tick'] ?? ''));
  const queued = object(object(status?.['lanes'])['codex-personal'])['queued'];
  const grants = parsed.success && age >= 0 && age < RESOURCE_LIVE_STALE_MS ? parsed.data.grants
    .filter(grant => Date.parse(grant.expires_at) > now)
    .sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at)) : null;
  return {
    observed_at: grants && parsed.success ? parsed.data.observed_at : null,
    grants, queued: status?.['schema'] === 'dispatchd.status.v1' && tick >= 0 && tick <= 5 * 60_000 &&
      typeof queued === 'number' && Number.isSafeInteger(queued) && queued >= 0 ? queued : null,
  };
}

export function planBankedReset(
  input: ResetInputs, allowances: BurnDownRow[], sources: ReadonlyMap<string, string | null>, now: number,
): NonNullable<BurnDownPlan['banked_resets']> {
  const { grants, observed_at, queued } = input;
  const output: NonNullable<BurnDownPlan['banked_resets']> = {
    observed_at, grants, count: grants?.reduce((sum, grant) => sum + grant.count, 0) ?? null, proposal: null,
  };
  if (!grants?.length || queued === null || queued === 0) return output;
  const windows = allowances.flatMap(row => {
    const kind: '5h' | 'weekly' | null = row.id === 'codex-personal-5h' ? '5h' : row.id === 'codex-personal' ? 'weekly' : null;
    const source = sources.get(row.id);
    const used = row.remaining === null ? null : 100 - row.remaining;
    if (!kind || (source !== `codex-app-server-${kind}` && !(kind === 'weekly' && source === 'codex-budget-overrides-weekly')) ||
      row.unit !== 'percent' || used === null || used < 90 || used >= 100 ||
      !row.deadline_at || !row.observed_rate_per_hour || row.observed_rate_per_hour <= 0) return [];
    const exhaustion = now + (100 - used) / row.observed_rate_per_hour * 3_600_000;
    return exhaustion < Date.parse(row.deadline_at) ? [{ row, kind, source, used, exhaustion }] : [];
  }).sort((a, b) => a.exhaustion - b.exhaustion);
  for (const grant of grants) {
    const window = windows.find(window => (grant.kind === 'full' || window.kind === grant.kind) &&
      Date.parse(grant.expires_at) < window.exhaustion);
    if (!window) continue;
    output.proposal = {
      action: 'use-reset-now', requires_explicit_request: true, grant, window: window.kind, usage_source: window.source,
      used_pct: window.used, reset_at: window.row.deadline_at!, projected_exhaustion_at: new Date(window.exhaustion).toISOString(),
      queued_jobs: queued,
    };
    break;
  }
  return output;
}
