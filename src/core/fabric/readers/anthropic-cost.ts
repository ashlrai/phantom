import { execFile } from 'node:child_process';
import { scrubSecrets } from '../../util/scrub.js';
import { liveSourcesSchema, type LiveSourcesConfig } from '../../usage/resource-live/config.js';
import type { ResourceLiveSource } from '../../usage/resource-live/source-types.js';
import { ANTHROPIC_COST_WORKER } from './anthropic-cost-worker.js';

export function anthropicCostSource(config: NonNullable<LiveSourcesConfig['anthropicCost']>,
  run?: (nowMs: number) => Promise<string>): ResourceLiveSource {
  const valid = liveSourcesSchema.safeParse({ anthropicCost: config }).success;
  const custodied = run ?? ((nowMs: number) => new Promise<string>((resolve, reject) => {
    execFile('phantom', ['exec', '--', process.execPath, '-e', ANTHROPIC_COST_WORKER,
      JSON.stringify({ ...config, observedAt: new Date(nowMs).toISOString() })],
      { timeout: 18_000, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true },
      (error, stdout) => { if (error) reject(new Error('custody-unavailable')); else resolve(stdout); });
  }));
  return { tier: 'official', read: async nowMs => {
    if (!valid || Date.parse(config.windowStart) >= nowMs || (config.expiresAt && Date.parse(config.expiresAt) <= nowMs)) return null;
    try {
      const row = JSON.parse(scrubSecrets(await custodied(nowMs))) as Record<string, unknown> | null;
      if (!row || typeof row.used !== 'number' || !Number.isFinite(row.used) || row.used < 0 ||
        typeof row.observed_at !== 'string' || !Number.isFinite(Date.parse(row.observed_at)) || Date.parse(row.observed_at) > nowMs ||
        Date.parse(row.observed_at) < Date.parse(config.windowStart)) return null;
      return { used: row.used, limit: config.creditUsd, unit: 'usd', reset_at: null,
        ...(config.expiresAt ? { expires_at: config.expiresAt } : {}),
        source: 'anthropic-admin-cost', observed_at: row.observed_at };
    } catch { return null; }
  } };
}
