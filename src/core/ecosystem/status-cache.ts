/** Cached `ecosystem status` (SWR, 5 min) for Today, Welcome and GET /api/ecosystem. */
import { swr, invalidateSwr } from '../util/swr-cache.js';
import type { EcosystemReportV1 } from './onboard.js';

export const ECOSYSTEM_STATUS_TTL_MS = 5 * 60_000;
const KEY = 'ecosystem-status';

export async function cachedEcosystemStatus(): Promise<EcosystemReportV1> {
  return swr(KEY, async () => {
    const { runEcosystemUp } = await import('./onboard.js');
    const { realEcosystemDeps } = await import('./onboard-deps.js');
    return runEcosystemUp(await realEcosystemDeps({ withGrant: false }), { statusOnly: true });
  }, { ttlMs: ECOSYSTEM_STATUS_TTL_MS });
}

export function invalidateEcosystemStatus(): void { invalidateSwr(KEY); }
