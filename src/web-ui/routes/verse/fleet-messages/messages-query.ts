import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { narrowAgentMessages, type AgentMessages } from './messages-model.js';

export const MESSAGES_PATH = '/api/verse/agent-bus/messages';
/** The Messages pane's read: the newest 200, filtered by agent in the view. */
export const agentMessagesQuery: QueryDef<AgentMessages | null> = {
  key: 'verse-agent-messages', fetch: async signal => narrowAgentMessages(await apiGet<unknown>(`${MESSAGES_PATH}?limit=200`, signal)),
};
/** What two agents last said to each other (`phm messages --agent a --with b --limit 20`): the read behind a message line on the map. */
export const PAIR_LIMIT = 20;
export const pairMessagesQuery = ([a, b]: readonly [string, string]): QueryDef<AgentMessages | null> => ({
  key: `verse-agent-messages-pair:${a}\n${b}`,
  fetch: async signal => narrowAgentMessages(await apiGet<unknown>(`${MESSAGES_PATH}?agent=${encodeURIComponent(a)}&with=${encodeURIComponent(b)}&limit=${PAIR_LIMIT}`, signal)),
});
/** The Org pane's "talking now" read: the same API, last 15 minutes. */
export const talkingNowQuery: QueryDef<AgentMessages | null> = {
  key: 'verse-agent-messages-15m', fetch: async signal => narrowAgentMessages(await apiGet<unknown>(`${MESSAGES_PATH}?since=15m&limit=1024`, signal)),
};
