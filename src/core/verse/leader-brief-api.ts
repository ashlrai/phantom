/** Desktop read of the Leader's "Phantom status" brief (the same text `ashlr fleet brief-send`
 * delivers). Read-only: it never sends and never writes an inbox. Answers only the local
 * dispatch session. */
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { fixedOwnerRunsDir } from '../comms/owner-channel.js';
import { leaderDailyBrief } from '../comms/leader-daily-brief.js';

export const VERSE_LEADER_BRIEF_PATH = '/api/verse/leader/brief';
export const LEADER_BRIEF_SCHEMA = 'verse.leader-brief.v1';
/** Polling clients share one read per window. */
export const LEADER_BRIEF_CACHE_MS = 60_000;

export interface LeaderBriefApiDeps {
  /** Default: the fixed owner runs dir (neither env nor the request picks it). */
  runsDir?: string;
  /** Test seam; default `leaderDailyBrief`. */
  brief?: (runsDir: string, now: Date) => Promise<string>;
  now?: () => Date;
}

export interface LeaderBriefBody { schema: typeof LEADER_BRIEF_SCHEMA; at: string; text: string | null; reason?: 'unavailable' }

/** The brief's own title line becomes the desktop heading. */
function withStatusHeading(text: string): string {
  const rest = text.split('\n').slice(1);
  return ['Phantom status', ...rest].join('\n');
}

export function createLeaderBriefApi(deps: LeaderBriefApiDeps = {}): ApiModule {
  const brief = deps.brief ?? leaderDailyBrief;
  const clock = deps.now ?? (() => new Date());
  let cached: { until: number; read: Promise<LeaderBriefBody> } | null = null;

  const read = async (): Promise<LeaderBriefBody> => {
    const now = clock();
    const at = now.toISOString();
    try {
      const text = await brief(deps.runsDir ?? fixedOwnerRunsDir(), now);
      if (typeof text !== 'string' || text.trim() === '') throw new Error('empty brief');
      return { schema: LEADER_BRIEF_SCHEMA, at, text: withStatusHeading(text) };
    } catch {
      return { schema: LEADER_BRIEF_SCHEMA, at, text: null, reason: 'unavailable' };
    }
  };

  return async (ctx, _req, res, path, method) => {
    if (path !== VERSE_LEADER_BRIEF_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'The Leader brief is read only here.' });
      return true;
    }
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    const nowMs = clock().getTime();
    if (!cached || nowMs >= cached.until || nowMs < cached.until - LEADER_BRIEF_CACHE_MS) {
      cached = { until: nowMs + LEADER_BRIEF_CACHE_MS, read: read() };
    }
    sendJson(res, 200, await cached.read);
    return true;
  };
}

export const handleLeaderBriefApi: ApiModule = createLeaderBriefApi();
