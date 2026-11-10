/**
 * routes/verse/fleet/session-guidance-queries.ts — reads and writes behind
 * the per-session guidance box:
 *
 *   GET  /api/fleet/guidance                     aggregate ack state
 *   POST /api/fleet/sessions/<job>/guidance      one {text} message
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
import { FLEET_GUIDANCE_LIST_PATH, FLEET_SESSION_GUIDANCE_PREFIX } from '../../../../core/fleet/session-guidance.js';
import { narrowGuidanceList } from './session-guidance-model.js';

export const guidanceListQuery: QueryDef<ReturnType<typeof narrowGuidanceList>> = {
  key: 'verse-fleet-session-guidance',
  async fetch(signal) {
    return narrowGuidanceList(await apiGet<unknown>(FLEET_GUIDANCE_LIST_PATH, signal));
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
  return `${FLEET_SESSION_GUIDANCE_PREFIX}${encodeURIComponent(job)}/guidance`;
}

export async function postSessionGuidance(job: string, text: string): Promise<PostSessionGuidanceResult> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  const result = await apiPost<PostSessionGuidanceResult>(guidancePath(job), { text }, token);
  touchMutationHold();
  void refetchQuery(guidanceListQuery.key, () => guidanceListQuery.fetch(), true);
  return result;
}
