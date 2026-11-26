import { join } from 'node:path';
import { z } from 'zod';
import { asPlainObject as object } from '../runway.js';
import { readPrivateJson, readResourceEvidenceFile, updateEvidence } from './store.js';
import {
  CODEX_RESET_BANK_MIN_VERSION, CODEX_RESET_BANK_TOO_OLD, CODEX_RESET_BANK_UNKNOWN_REASONS, RESOURCE_LIVE_STALE_MS,
  type BankedResetGrant, type BurnDownPlan, type BurnDownRow, type CodexResetBankUnknownReason,
} from './types.js';

const time = z.iso.datetime().refine(value => Number.isFinite(Date.parse(value)));
const grantSchema = z.object({
  count: z.number().int().min(1).max(100),
  kind: z.enum(['full', '5h', 'weekly']),
  expires_at: time,
  source: z.enum(['codex-app-server', 'chatgpt-settings-usage', 'owner-screenshot']),
}).strict();
export const bankSchema = z.object({ observed_at: time, count: z.number().int().min(0).max(100), grants: z.array(grantSchema).max(100) })
  .strict().refine(row => row.grants.reduce((n, grant) => n + grant.count, 0) === row.count);

const BANK_KEY = 'codex-personal-resets';
const STATUS_KEY = 'codex-personal-reset-status';
const resetStatusSchema = z.object({ observed_at: time, unknown_reason: z.enum(CODEX_RESET_BANK_UNKNOWN_REASONS).nullable() }).strict();

export function codexResetBankUpgradeHint(reason?: CodexResetBankUnknownReason | null): string | undefined {
  return reason === CODEX_RESET_BANK_TOO_OLD ? `Upgrade codex-cli to ${CODEX_RESET_BANK_MIN_VERSION} or newer to read the reset bank.` : undefined;
}

export async function publishCodexResetBank(runsDir: string, observedAt: string, grants: BankedResetGrant[] | null,
  reason?: CodexResetBankUnknownReason,
): Promise<void> {
  const bank = grants && bankSchema.safeParse({ observed_at: observedAt, count: grants.length, grants });
  const status = resetStatusSchema.safeParse({ observed_at: observedAt, unknown_reason: bank?.success ? null : reason });
  if (!status.success) return;
  await updateEvidence(runsDir, async readings => {
    const at = Date.parse(observedAt);
    const previousStatus = resetStatusSchema.safeParse(readings[STATUS_KEY]);
    const newerStatus = !previousStatus.success || Date.parse(previousStatus.data.observed_at) < at;
    if (!newerStatus) return { changed: false, result: undefined };
    readings[STATUS_KEY] = status.data;
    const previousBank = bankSchema.safeParse(readings[BANK_KEY]);
    if (bank?.success && (!previousBank.success || Date.parse(previousBank.data.observed_at) < at)) readings[BANK_KEY] = bank.data;
    return { changed: true, result: undefined };
  });
}

interface ResetInputs { observed_at: string | null; grants: BankedResetGrant[] | null; queued: number | null;
  unknown_reason?: CodexResetBankUnknownReason }

export async function readBankedResets(runsDir: string, now: number): Promise<ResetInputs> {
  const [evidence, status] = await Promise.all([
    readResourceEvidenceFile(runsDir), readPrivateJson(join(runsDir, 'queue', 'status.json'), 1024 * 1024),
  ]).then(rows => rows.map(object));
  const readings = evidence?.['schema'] === 'resource-evidence.v1' ? object(evidence['readings']) : {};
  const parsed = bankSchema.safeParse(readings[BANK_KEY]);
  const nativeStatus = resetStatusSchema.safeParse(readings[STATUS_KEY]);
  const statusAge = nativeStatus.success ? now - Date.parse(nativeStatus.data.observed_at) : Infinity;
  const reason = nativeStatus.success && statusAge >= 0 && statusAge < RESOURCE_LIVE_STALE_MS ? nativeStatus.data.unknown_reason : null;
  const age = parsed.success ? now - Date.parse(parsed.data.observed_at) : Infinity;
  const tick = now - Date.parse(String(status?.['last_tick'] ?? ''));
  const queued = object(object(status?.['lanes'])['codex-personal'])['queued'];
  const grants = parsed.success && age >= 0 && age < RESOURCE_LIVE_STALE_MS ? parsed.data.grants
    .filter(grant => Date.parse(grant.expires_at) > now)
    .sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at)) : null;
  return {
    observed_at: grants && parsed.success ? parsed.data.observed_at : null,
    ...(!grants && reason ? { unknown_reason: reason } : {}),
    grants, queued: status?.['schema'] === 'dispatchd.status.v1' && tick >= 0 && tick <= 5 * 60_000 &&
      typeof queued === 'number' && Number.isSafeInteger(queued) && queued >= 0 ? queued : null,
  };
}

export function planBankedReset(
  input: ResetInputs, allowances: BurnDownRow[], sources: ReadonlyMap<string, string | null>, now: number,
): NonNullable<BurnDownPlan['banked_resets']> {
  const { grants, observed_at, queued, unknown_reason } = input;
  const output: NonNullable<BurnDownPlan['banked_resets']> = {
    observed_at, grants, count: grants?.reduce((sum, grant) => sum + grant.count, 0) ?? null, proposal: null,
    ...(unknown_reason ? { unknown_reason } : {}),
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
