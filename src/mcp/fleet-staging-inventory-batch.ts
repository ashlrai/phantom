import { isAbsolute, normalize } from 'node:path';
import { ELIGIBILITY, inventoryStaging } from '../core/fleet/staging-inventory.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const MAX_STAGING_BATCH_INPUT_BYTES = 16 * 1024;
export type StagingScanner = (root: string) => ReturnType<typeof inventoryStaging>;

export function parseStagingBatchArgs(value: Record<string, unknown>): string[] | null {
  try {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_STAGING_BATCH_INPUT_BYTES) return null;
  } catch { return null; }
  if (Object.keys(value).length !== 1 || !Array.isArray(value.roots)
    || value.roots.length < 1 || value.roots.length > 8) return null;
  const roots: string[] = [];
  for (const root of value.roots) {
    if (typeof root !== 'string' || root.includes('\0') || !isAbsolute(root)) return null;
    const path = normalize(root);
    if (roots.includes(path)) return null;
    roots.push(path);
  }
  return roots;
}

export async function readStagingBatch(roots: string[], scan: StagingScanner = inventoryStaging, signal?: AbortSignal): Promise<unknown> {
  const reports: (Awaited<ReturnType<StagingScanner>> | { root: string; complete: false; source: 'failed' | 'unattempted'; cleanupEligibility: string })[] = [];
  let completed = 0;
  let cancelled = false;
  for (const [index, root] of roots.entries()) {
    if (signal?.aborted) {
      cancelled = true;
      for (const unattempted of roots.slice(index)) {
        reports.push({ root: unattempted, complete: false, source: 'unattempted', cleanupEligibility: ELIGIBILITY });
      }
      break;
    }
    try {
      const report = await scan(root);
      reports.push(report);
      if (report.complete) completed++;
    } catch {
      reports.push({ root, complete: false, source: 'failed', cleanupEligibility: ELIGIBILITY });
    }
    if (signal?.aborted && index === roots.length - 1) cancelled = true;
  }
  return sanitizePublicJson({ schema: 'fleet.staging-inventory-batch.v1', requested: roots.length, completed, reports,
    ...(cancelled ? { cancelled: true, complete: false } : {}) });
}
