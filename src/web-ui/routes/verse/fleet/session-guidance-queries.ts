/**
 * routes/verse/fleet/session-guidance-queries.ts — reads and writes behind
 * the per-session guidance box:
 *
 *   GET  /api/verse/fleet/control/guidance          aggregate ack state
 *   POST /api/verse/fleet/control/guidance/<job>    one {text} message
 *
 * The read is optional like every surface read (a server without the route
 * is "not in this build", never a broken row). The write pulls the held
 * mutation token and refreshes the aggregate after landing.
 */
import { apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { refetchQuery } from '../../../data/cache.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { narrowGuidanceList } from './session-guidance-model.js';

export const VERSE_GUIDANCE_LIST_PATH = '/api/verse/fleet/control/guidance';

export const guidanceListQuery: QueryDef<ReturnType<typeof narrowGuidanceList>> = {
  key: 'verse-fleet-session-guidance',
  async fetch(signal) {
    return narrowGuidanceList(await apiGet<unknown>(VERSE_GUIDANCE_LIST_PATH, signal));
  },
};

export interface PostSessionGuidanceResult {
  ok: true;
  id: string;
  job: string;
  at: string;
  strategy: string;
  state: 'queued';
  truncated: boolean;
}

export function guidancePath(job: string): string {
  return `${VERSE_GUIDANCE_LIST_PATH}/${encodeURIComponent(job)}`;
}

export async function postSessionGuidance(job: string, text: string): Promise<PostSessionGuidanceResult> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  const result = await apiPost<PostSessionGuidanceResult>(guidancePath(job), { text }, token);
  touchMutationHold();
  void refetchQuery(guidanceListQuery.key, () => guidanceListQuery.fetch(), true);
  return result;
}
