import { readAgentChat, type ChatQuery, type ChatResult } from '../agents/chat.js';
import { BUS_PRIORITIES, type BusPriority } from '../fleet/bus-envelope.js';
import { parseSince } from '../fleet/agent-messages.js';
/** Called only behind server.ts local owner read authentication. No remote allowlist expansion. */
export function agentChatResponse(method: string, url: string,
  read: (query: ChatQuery) => ChatResult = readAgentChat): { code: number; body: unknown } {
  if (method !== 'GET') return { code: 405, body: { status: 'method-not-allowed' } };
  const params = new URL(url, 'http://localhost').searchParams;
  const allowed = new Set(['channel', 'topic', 'thread', 'after', 'limit',
    'from', 'excludeFrom', 'contains', 'since', 'before', 'id', 'inReplyTo', 'priority']);
  if ([...params.keys()].some(key => !allowed.has(key) || params.getAll(key).length !== 1)) {
    return { code: 400, body: { status: 'invalid' } };
  }
  const query: ChatQuery = { channel: params.get('channel') ?? '' };
  if (params.has('thread')) query.thread = params.get('thread')!;
  if (params.has('topic')) query.topic = params.get('topic')!;
  for (const key of ['after', 'limit'] as const) {
    if (!params.has(key)) continue;
    const value = params.get(key)!;
    if (!/^\d+$/.test(value)) return { code: 400, body: { status: 'invalid' } };
    query[key] = Number(value);
  }
  for (const key of ['from', 'excludeFrom', 'contains', 'id', 'inReplyTo'] as const) {
    if (params.has(key)) query[key] = params.get(key)!;
  }
  if (params.has('priority')) {
    const priority = params.get('priority')!;
    if (!(BUS_PRIORITIES as readonly string[]).includes(priority)) return { code: 400, body: { status: 'invalid' } };
    query.priority = priority as BusPriority;
  }
  for (const key of ['since', 'before'] as const) {
    if (!params.has(key)) continue;
    const ms = parseSince(params.get(key)!);
    if (ms === null) return { code: 400, body: { status: 'invalid' } };
    query[key] = ms;
  }
  const body = read(query);
  return { code: body.status === 'ok' ? 200 : body.status === 'invalid' ? 400 :
    body.status === 'unknown-channel' ? 404 : 503, body };
}
