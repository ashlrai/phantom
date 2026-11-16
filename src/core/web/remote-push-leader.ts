/** Content-free notifications derived from the same sources as the Leader pane. */
import { parseInboxAt } from '../../web-ui/routes/verse/fleet/interject-ack-model.js';

interface PushLeaderLine { who: string; source: string; at: number; text: string }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function validLeaderReplies(value: unknown): value is PushLeaderLine[] {
  return Array.isArray(value) && value.length <= 3000 && value.every(line => record(line)
    && typeof line.who === 'string' && typeof line.source === 'string' && typeof line.at === 'number'
    && typeof line.text === 'string');
}

export function diffLeaderRepliesForPush(previousNewestAt: number | null, lines: readonly PushLeaderLine[]): {
  newestAt: number; intent: { kind: 'leader-reply'; count: number } | null;
} {
  const replies = lines.filter(line => line.who === 'leader' && line.source !== 'system' && Number.isFinite(line.at));
  const newestAt = Math.max(previousNewestAt ?? -Infinity, ...replies.map(line => line.at));
  if (previousNewestAt === null) return { newestAt, intent: null };
  const fresh = new Set(replies.filter(line => line.at > previousNewestAt).map(line => line.text.trim()));
  return { newestAt, intent: fresh.size ? { kind: 'leader-reply', count: fresh.size } : null };
}

/** Reject unavailable or malformed reads so they cannot advance the watermark. */
export async function readLeaderRepliesForPush(read: (path: string) => Promise<unknown>): Promise<unknown> {
  const [thread, fleet, owner] = await Promise.all([
    read('/api/verse/leader/thread?limit=50'), read('/api/verse/fleet/runs'),
    read('/api/verse/comms/owner-thread?limit=100'),
  ]);
  const threadRows = Array.isArray(thread) ? thread : record(thread) ? thread.messages : null;
  if (!Array.isArray(threadRows) || !record(fleet) || !Array.isArray(fleet.outbox)
    || !record(owner) || owner.schema !== 'comms.owner-thread.v1' || owner.unavailable === true
    || !Array.isArray(owner.messages) || (record(owner.status) && (owner.status.kill === true || owner.status.paused === true))) {
    throw new Error('Leader read unavailable');
  }
  const lines: PushLeaderLine[] = [];
  for (const row of threadRows) {
    if (!record(row) || (row.from !== 'leader' && row.from !== 'mason') || typeof row.channel !== 'string'
      || typeof row.at !== 'string' || typeof row.text !== 'string') throw new Error('Leader thread malformed');
    lines.push({ who: row.from, source: row.channel, at: Date.parse(row.at), text: row.text });
  }
  for (const row of fleet.outbox) {
    if (!record(row) || typeof row.at !== 'string' || typeof row.text !== 'string') throw new Error('Leader outbox malformed');
    lines.push({ who: 'leader', source: 'outbox', at: parseInboxAt(row.at, Date.now()) ?? Date.parse(row.at), text: row.text });
  }
  for (const row of owner.messages) {
    if (!record(row) || (row.direction !== 'inbound' && row.direction !== 'outbound') || typeof row.channel !== 'string'
      || typeof row.at !== 'string' || typeof row.text !== 'string') throw new Error('Owner thread malformed');
    lines.push({ who: row.direction === 'outbound' ? 'leader' : 'mason', source: row.channel, at: Date.parse(row.at), text: row.text });
  }
  return lines;
}
