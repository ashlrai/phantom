/** Desktop read of the newest release's stages (published, update feed). Read-only: it
 * never publishes, uploads, edits or retags. Answers only the local dispatch session. */
import { updateWhy } from '../desktop/update-why.js';
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { fetchLatestRelease, observeMilestones, type MilestoneReader, type ReleaseRunner } from '../fleet/release-live-notice.js';

export const VERSE_UPDATE_WHY_PATH = '/api/verse/update/why';
export const VERSE_RELEASE_STAGES_PATH = '/api/verse/release/stages';
export const RELEASE_STAGES_SCHEMA = 'verse.release-stages.v1';
const REPO = 'ashlrai/phantom';
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface ReleaseStage { stage: 'published' | 'feed-ready'; status: 'observed' | 'unknown'; version: string | null; reason: string | null }
export interface ReleaseStagesResponse {
  schema: typeof RELEASE_STAGES_SCHEMA; repo: string; tag: string | null; checkedAt: string; stages: ReleaseStage[]; reason?: string;
}

export interface ReleaseStagesApiDeps {
  run?: ReleaseRunner;
  feed?: MilestoneReader;
  now?: () => Date;
  /** How long the last result is reused so a polling pane never spams gh or GitHub. */
  ttlMs?: number;
}

export function createReleaseStagesApi(deps: ReleaseStagesApiDeps = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  let cached: { at: number; body: ReleaseStagesResponse } | null = null;
  let inflight: Promise<ReleaseStagesResponse> | null = null;

  async function read(): Promise<ReleaseStagesResponse> {
    const at = now();
    const unavailable: ReleaseStagesResponse = { schema: RELEASE_STAGES_SCHEMA, repo: REPO, tag: null, checkedAt: at.toISOString(), stages: [], reason: 'release unavailable; retry' };
    try {
      const newest = await fetchLatestRelease(REPO, deps.run);
      if (!newest) return unavailable;
      const fact = await fetchLatestRelease(REPO, deps.run, newest.tag);
      const observed = await observeMilestones(REPO, newest.tag, fact, at, deps.feed);
      const stages = observed.filter(o => o.stage !== 'installed')
        .map(o => ({ stage: o.stage as ReleaseStage['stage'], status: o.status, version: o.version, reason: o.reason }));
      return { schema: RELEASE_STAGES_SCHEMA, repo: REPO, tag: newest.tag, checkedAt: at.toISOString(), stages };
    } catch { return unavailable; }
  }

  return async (ctx, _req, res, path, method) => {
    if (path === VERSE_UPDATE_WHY_PATH) {
      if (method !== 'GET') sendJson(res, 405, { error: 'method not allowed' });
      else if (!ctx.allowDispatch) sendJson(res, 404, { error: 'not found' });
      else sendJson(res, 200, await updateWhy());
      return true;
    }
    if (path !== VERSE_RELEASE_STAGES_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'Release stages are read only here.' });
      return true;
    }
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    if (!cached || now().getTime() - cached.at >= ttlMs) {
      inflight ??= read().finally(() => { inflight = null; });
      const body = await inflight;
      cached = { at: now().getTime(), body };
    }
    sendJson(res, 200, cached.body);
    return true;
  };
}

export const handleReleaseStagesApi: ApiModule = createReleaseStagesApi();
