import { readAgentChat, type ChatQuery, type ChatResult } from '../agents/chat.js';
/** Called only behind server.ts local owner read authentication. No remote allowlist expansion. */
export function agentChatResponse(method: string, url: string,
  read: (query: ChatQuery) => ChatResult = readAgentChat): { code: number; body: unknown } {
  if (method !== 'GET') return { code: 405, body: { status: 'method-not-allowed' } };
  const params = new URL(url, 'http://localhost').searchParams;
  const allowed = new Set(['channel', 'thread', 'after', 'limit']);
  if ([...params.keys()].some(key => !allowed.has(key) || params.getAll(key).length !== 1)) {
    return { code: 400, body: { status: 'invalid' } };
  }
  const query: ChatQuery = { channel: params.get('channel') ?? '' };
  if (params.has('thread')) query.thread = params.get('thread')!;
  for (const key of ['after', 'limit'] as const) {
    if (!params.has(key)) continue;
    const value = params.get(key)!;
    if (!/^\d+$/.test(value)) return { code: 400, body: { status: 'invalid' } };
    query[key] = Number(value);
  }
  const body = read(query);
  return { code: body.status === 'ok' ? 200 : body.status === 'invalid' ? 400 :
    body.status === 'unknown-channel' ? 404 : 503, body };
}
