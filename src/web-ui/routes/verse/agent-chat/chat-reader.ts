import type { ChatResult } from '../../../../core/agents/chat.js';
import { apiGet } from '../../../data/client.js';
export type ChatPage = Extract<ChatResult, { status: 'ok' }>;
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const count = (x: unknown): x is number => Number.isSafeInteger(x) && Number(x) >= 0;
/** Fail closed on scope mismatch; no cross-channel cache or raw-error rendering. */
export function narrowChatPage(x: unknown, channel: string, thread: string, after: number): ChatPage | null {
  if (!record(x) || x.status !== 'ok' || x.schema !== 'agent-chat.v1' || x.channel !== channel ||
      x.retention !== 'live-retained-only' || !count(x.asOf) || !count(x.nextCursor) || x.nextCursor < after ||
      typeof x.hasMore !== 'boolean' || !Array.isArray(x.participants) || !Array.isArray(x.threads) ||
      !Array.isArray(x.messages) || x.messages.length > 100) return null;
  if (!x.participants.every(p => record(p) && typeof p.agentId === 'string' && typeof p.handle === 'string' &&
      typeof p.displayName === 'string' && (p.engine === null || typeof p.engine === 'string') &&
      p.state === 'unknown' && typeof p.avatarColor === 'string' && /^#[0-9a-f]{6}$/i.test(p.avatarColor))) return null;
  const ids = new Set(x.participants.map(p => (p as { agentId: string }).agentId));
  if (!x.threads.every(t => record(t) && typeof t.id === 'string' && /^(outcome|run):[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(t.id) && count(t.messageCount) && count(t.lastCursor))) return null;
  let cursor = after;
  const messageIds = new Set<string>();
  for (const m of x.messages) {
    if (!record(m) || !thread || m.thread !== thread || typeof m.id !== 'string' || messageIds.has(m.id) ||
        typeof m.agentId !== 'string' || !ids.has(m.agentId) || !count(m.cursor) || m.cursor <= cursor ||
        m.cursor > x.nextCursor || !count(m.receivedAt) || m.receivedAt > 8_640_000_000_000_000 ||
        !['message', 'interjection'].includes(String(m.kind)) || typeof m.text !== 'string') return null;
    cursor = m.cursor; messageIds.add(m.id);
  }
  if (x.hasMore && (!x.messages.length || x.nextCursor <= after || x.nextCursor !== cursor)) return null;
  return x as unknown as ChatPage;
}
export async function readChat(channel: string, thread: string, after: number, signal: AbortSignal): Promise<ChatPage> {
  const params = new URLSearchParams({ channel, after: String(after), limit: '100' });
  if (thread) params.set('thread', thread);
  const page = narrowChatPage(await apiGet<unknown>(`/api/agents/chat?${params}`, signal), channel, thread, after);
  if (!page) throw new Error('Chat response unavailable');
  return page;
}
