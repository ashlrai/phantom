import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { narrowSlackTrace, type SlackTraceView } from './slack-trace-model.js';

/** `null` = this build has no route (404) or the payload did not parse. */
export const slackTraceQuery: QueryDef<SlackTraceView | null> = {
  key: 'verse-fleet-slack-trace',
  async fetch(signal) {
    try { return narrowSlackTrace(await apiGet<unknown>('/api/verse/fleet/control/slack-trace', signal)); }
    catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
