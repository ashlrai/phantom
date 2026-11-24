/** Settings ▸ Live build limits: the one read the Settings row and the Live build line share. */
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { VerseBuildStaleLimitsSnapshot } from '../../../../core/verse/control-api.js';
export const BUILD_STALE_LIMITS_PATH = '/api/verse/build-stale-limits';
export type BuildStaleLimitsView = VerseBuildStaleLimitsSnapshot;
const int = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0;
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const pair = (x: unknown, nullable: boolean): boolean => typeof x === 'object' && x !== null
  && [(x as Record<string, unknown>)['commits'], (x as Record<string, unknown>)['hours']].every(n => (nullable ? int(n) || n === null : num(n)));
const range = (x: unknown): boolean => typeof x === 'object' && x !== null && int((x as Record<string, unknown>)['min']) && int((x as Record<string, unknown>)['max']);
/** A malformed answer is null, so callers fall back to the defaults instead of showing guessed numbers. */
export function narrowBuildStaleLimits(x: unknown): BuildStaleLimitsView | null {
  if (typeof x !== 'object' || x === null) return null;
  const r = x as Record<string, unknown>;
  const env = r['envOverride'] as Record<string, unknown> | undefined;
  const ranges = r['ranges'] as Record<string, unknown> | undefined;
  if (r['schema'] !== 'ashlr.build-stale-limits.v1' || !pair(r['limits'], false) || !pair(r['saved'], true) || !pair(r['defaults'], false)
    || typeof env?.['commits'] !== 'boolean' || typeof env['hours'] !== 'boolean' || !range(ranges?.['commits']) || !range(ranges?.['hours'])) return null;
  return x as BuildStaleLimitsView;
}
export const buildStaleLimitsQuery: QueryDef<BuildStaleLimitsView | null> = {
  key: 'verse-build-stale-limits',
  fetch: async signal => { try { return narrowBuildStaleLimits(await apiGet<unknown>(BUILD_STALE_LIMITS_PATH, signal)); } catch { return null; } },
};
/** Save both limits (null = default). Resolves to the server's read-back; throws if it does not verify. */
export async function postBuildStaleLimits(body: { commits: number | null; hours: number | null }): Promise<BuildStaleLimitsView> {
  const token = getMutationToken();
  if (!token) throw new Error('Unlock actions with the mutation token before changing the limits.');
  const saved = narrowBuildStaleLimits(await apiPost<unknown>(BUILD_STALE_LIMITS_PATH, body, token));
  if (!saved) throw new Error('The saved limits could not be verified.');
  touchMutationHold();
  return saved;
}
