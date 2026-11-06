import { execFile } from 'node:child_process';
import { scrubSecrets } from '../../util/scrub.js';
import { DEVIN_USAGE_WORKER } from './devin-usage-worker.js';

export const DEVIN_USAGE_TTL_MS = 5 * 60_000;
const NEGATIVE_TTL_MS = 30_000;
const MAX_RETRY_MS = 24 * 60 * 60_000;
export interface DevinUsage {
  pool: 'devin';
  acuUsed: number;
  acuLimit: number;
  /** Null for a zero limit: a percentage is undefined. */
  pctUsed: number | null;
  resetAt: string;
  source: 'devin-api-v3-org-cycle';
  fetchedAt: string;
}
export interface DevinUsageUnknown { status: 'unknown'; reason: string }
export type DevinUsageResult = DevinUsage | DevinUsageUnknown;

const unknown = (reason: string): DevinUsageUnknown => ({ status: 'unknown', reason });
const reasons = new Set(['missing-key', 'missing-organization', 'rate-limited', 'unauthorized', 'forbidden',
  'api-unavailable', 'malformed-body', 'pagination-limit', 'unknown-cycle', 'unknown-limit', 'api-unreachable']);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const iso = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)) return false;
  const time = Date.parse(v);
  return Number.isFinite(time) && new Date(time).toISOString() === v;
};

/** Pipes are captured, never inherited or logged, including Phantom's diagnostics. */
function runCustodied(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('phantom', ['exec', '--', process.execPath, '-e', DEVIN_USAGE_WORKER], {
      timeout: 45_000, maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(new Error('custody-unavailable'));
      else resolve(stdout);
    });
  });
}

/** One cache per project/organization. Never reads credentials in the host process. */
export function createDevinUsageReader(deps: { run?: () => Promise<string>; now?: () => number } = {}): () => Promise<DevinUsageResult> {
  const run = deps.run ?? runCustodied;
  const now = deps.now ?? Date.now;
  let cached: DevinUsageResult | undefined;
  let expiresAt = 0;
  let flight: Promise<DevinUsageResult> | undefined;
  return async () => {
    if (cached && now() < expiresAt) return { ...cached };
    if (!flight) {
      flight = (async () => {
        let result: DevinUsageResult;
        let retryAt = 0;
        try {
          // Defense in depth. Only allowlisted fields survive parsing below.
          const output = scrubSecrets(await run());
          let body: Record<string, unknown> | null;
          try { body = JSON.parse(output) as Record<string, unknown> | null; }
          catch { body = null; }
          const checkedAt = now();
          if (body?.['status'] === 'unknown') {
            const reason = body['reason'];
            result = unknown(typeof reason === 'string' && reasons.has(reason) ? reason : 'malformed-body');
            if (reason === 'rate-limited' && typeof body['retryAt'] === 'number' && Number.isSafeInteger(body['retryAt'])) {
              retryAt = Math.min(body['retryAt'], checkedAt + MAX_RETRY_MS);
            }
          } else {
            if (!body || body['pool'] !== 'devin' || body['source'] !== 'devin-api-v3-org-cycle'
              || !finite(body['acuUsed']) || !finite(body['acuLimit'])
              || !(body['pctUsed'] === null || finite(body['pctUsed'])) || !iso(body['resetAt']) || !iso(body['fetchedAt'])) {
              result = unknown('malformed-body');
            } else {
              const pctUsed = body['acuLimit'] === 0 ? null : body['acuUsed'] / body['acuLimit'] * 100;
              if (pctUsed !== null && !finite(pctUsed)) result = unknown('malformed-body');
              else if (body['pctUsed'] !== pctUsed) result = unknown('inconsistent-percentage');
              else if (Date.parse(body['fetchedAt']) > checkedAt) result = unknown('future-fetched-at');
              else if (Date.parse(body['resetAt']) <= checkedAt) result = unknown('expired-cycle');
              else result = { pool: 'devin', acuUsed: body['acuUsed'], acuLimit: body['acuLimit'], pctUsed,
                resetAt: body['resetAt'], source: 'devin-api-v3-org-cycle', fetchedAt: body['fetchedAt'] };
            }
          }
        } catch { result = unknown('custody-unavailable'); }
        cached = result;
        const completedAt = now();
        expiresAt = 'status' in result ? Math.max(completedAt + NEGATIVE_TTL_MS, retryAt)
          : Math.min(completedAt + DEVIN_USAGE_TTL_MS, Date.parse(result.resetAt));
        return result;
      })().finally(() => { flight = undefined; });
    }
    return { ...await flight };
  };
}

export const readDevinUsage = createDevinUsageReader();

/** RQ-ECON-RESOURCE-VIEW integration: preserves other pools and exposes failures explicitly. */
export async function withDevinUsage<T extends { resources?: Record<string, unknown> }>(
  fleet: T, read: () => Promise<DevinUsageResult> = readDevinUsage,
): Promise<T & { resources: Record<string, unknown> & { devin: DevinUsageResult } }> {
  let devin: DevinUsageResult;
  try { devin = await read(); } catch { devin = unknown('reader-unavailable'); }
  return { ...fleet, resources: { ...fleet.resources, devin } };
}
