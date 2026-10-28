/** Fleet spending gate and read-only usage evidence; neither attests provider funding. */
import type { EffectivePolicy } from '../authority/types.js';
import type { DevinGate } from './types.js';

/**
 * Cloud API creates can consume on-demand credits. A human attribution, Max
 * label or local ACU budget cannot prove included-only billing. Keep this
 * separate from shared Devin native CLI authorization and metadata reads.
 * A positive allowance preserves existing behavior; it does NOT establish
 * exact USD accounting, remaining provider funding or a dollar reservation.
 */
export function devinFleetApiBillingGate(policy: Pick<EffectivePolicy, 'spend'> | null): DevinGate {
  const allowance = policy?.spend?.meteredUsdPerDay;
  if (typeof allowance === 'number' && Number.isFinite(allowance) && allowance > 0) {
    return { ok: true, reason: null };
  }
  return { ok: false, reason: `${allowance === 0 ? 'The standing metered API allowance is $0/day.' : 'The standing metered API allowance is unavailable.'} `
    + 'Devin fleet API launches are held. Review and authorize a positive metered allowance before using this lane; subscription quota and human attribution do not establish included API billing.' };
}

/**
 * Read-only organization ACUs, separate from the spending gate above.
 * https://docs.devin.ai/api-reference/v3/consumption/organizations-consumption-daily
 * DEVIN_API_KEY must be injected by Phantom Secrets (`phantom exec --`).
 * No Keychain, config, command arguments, response details or exception logging.
 */
export async function readDevinBillingUsage(options: {
  env: NodeJS.ProcessEnv;
  orgId?: string;
  start: number;
  end: number;
  fetch?: typeof globalThis.fetch;
}): Promise<number | null> {
  const key = options.env['DEVIN_API_KEY'];
  const org = options.orgId ?? options.env['DEVIN_ORG_ID'];
  if (!key || !org || !/^org-[A-Za-z0-9_-]+$/.test(org)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const query = new URLSearchParams({
      time_after: String(Math.floor(options.start / 1000)),
      time_before: String(Math.floor(options.end / 1000)),
    });
    const response = await (options.fetch ?? globalThis.fetch)(
      `https://api.devin.ai/v3/organizations/${encodeURIComponent(org)}/consumption/daily?${query}`,
      { method: 'GET', headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: controller.signal },
    );
    if (!response.ok || !response.body) { await response.body?.cancel(); return null; }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_048_576) { await reader.cancel(); return null; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const { parseDevinDailyConsumption } = await import('./client.js');
    return parseDevinDailyConsumption(JSON.parse(Buffer.concat(chunks).toString('utf8')))?.totalAcus ?? null;
  } catch {
    // Transport errors and provider bodies may contain credentials. Drop both.
    return null;
  } finally { clearTimeout(timer); }
}
