/** Shared read-only Actions facts for console, phone and agents. */
import { readCiRunFacts, summarizeCiRuns, type CiRunFactsV1 } from '../fleet/ci-run-facts.js';
import { resolveGitHubOriginAuthorityAsync } from '../git.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const VERSE_FLEET_CI_RUNS_PATH = '/api/verse/fleet/ci-runs';
export interface FleetCiRunsApiDeps {
  read?: typeof readCiRunFacts;
  repo?: () => Promise<string | null>;
  now?: () => number;
}
export function createFleetCiRunsApi(deps: FleetCiRunsApiDeps = {}): ApiModule {
  const cache = new Map<string, { at: number; body: Promise<CiRunFactsV1> }>();
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_CI_RUNS_PATH || method !== 'GET') return false;
    const value = Number(new URL(req.url ?? path, 'http://localhost').searchParams.get('hours') ?? 24);
    const hours = Number.isFinite(value) ? Math.min(168, Math.max(1, Math.trunc(value))) : 24;
    const nowMs = (deps.now ?? Date.now)();
    let repo: string | null = null;
    try { repo = await (deps.repo ?? (() => resolveGitHubOriginAuthorityAsync(process.cwd())))(); } catch { /* unknown repo */ }
    const unavailable = (reason: string): CiRunFactsV1 => ({ ...summarizeCiRuns([], new Map(), { nowMs, windowHours: hours, repo }), available: false, reason });
    if (!repo) { sendJson(res, 200, unavailable('Current GitHub repository is unknown.')); return true; }
    const key = `${repo}:${hours}`;
    let entry = cache.get(key);
    if (!entry || nowMs - entry.at >= 300000) {
      const body = Promise.resolve().then(() => (deps.read ?? readCiRunFacts)({ repo, windowHours: hours, nowMs })).catch(() => unavailable('GitHub Actions facts could not be read.'));
      entry = { at: nowMs, body };
      cache.set(key, entry);
      if (cache.size > 168) cache.delete(cache.keys().next().value!);
    }
    sendJson(res, 200, await entry.body);
    return true;
  };
}
export const handleFleetCiRunsApi: ApiModule = createFleetCiRunsApi();
