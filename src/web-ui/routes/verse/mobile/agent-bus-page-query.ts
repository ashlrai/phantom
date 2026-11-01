import { ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isRemoteMobileMode } from '../../../data/remote-mode.js';
import { agentBusPageQuery, type AgentBusPage } from '../fleet-bus/agent-bus-queries.js';

export const mobileAgentBusPageQuery: QueryDef<AgentBusPage | null> = {
  key: 'verse-mobile-agent-bus',
  async fetch(signal) {
    try {
      let after = 0;
      let messages: AgentBusPage['messages'] = [];
      // The API pages oldest first. Retain only the newest twenty, including
      // when expired envelopes advance the cursor without producing rows.
      for (;;) {
        const page = await agentBusPageQuery(after, 20).fetch(signal);
        if (!page) throw new ApiError('Unrecognized durable bus page.', 502, '/api/verse/agent-bus');
        messages = [...messages, ...page.messages].slice(-20);
        if (page.messages.length < 20 || page.nextCursor <= after) return { ...page, messages };
        after = page.nextCursor;
      }
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || (error.status === 403 && isRemoteMobileMode()))) return null;
      throw error;
    }
  },
};
