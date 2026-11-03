import { apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseMutationLockedError } from '../verse-queries.js';

interface InboxTail {
  inbox: Array<{ at: string; source: string; text: string }>;
  sources?: { inbox?: string };
  generatedAt?: string;
  lastTick?: string | null;
  leaders?: Array<{ label: string; ageSeconds: number | null }>;
}

export const inboxTailQuery: QueryDef<InboxTail> = {
  key: 'verse-fleet-inbox-tail',
  async fetch(signal) {
    const value = await apiGet<InboxTail>('/api/verse/fleet/runs', signal);
    if (!value || !Array.isArray(value.inbox) || !value.inbox.every(row => row
      && typeof row.at === 'string' && typeof row.source === 'string' && typeof row.text === 'string')) {
      throw new Error('The inbox tail is unavailable.');
    }
    return {
      inbox: value.inbox, sources: value.sources,
      generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : undefined,
      lastTick: typeof value.lastTick === 'string' || value.lastTick === null ? value.lastTick : undefined,
      leaders: Array.isArray(value.leaders) && value.leaders.every(leader => leader
        && typeof leader.label === 'string' && (leader.ageSeconds === null
          || (typeof leader.ageSeconds === 'number' && Number.isFinite(leader.ageSeconds) && leader.ageSeconds >= 0)))
        ? value.leaders : undefined,
    };
  },
};

export type InboxAck = 'acked' | 'skipped' | 'pending' | 'unknown';

async function post(text: string): Promise<{ at: string; duplicate: boolean; accepted: boolean; id?: string }> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<{ at: string; duplicate?: unknown; accepted?: unknown; id?: unknown }>('/api/verse/fleet/runs/inbox', { text, source: 'Phantom desktop' }, token);
  if (!result || typeof result.at !== 'string') throw new Error('The message could not be confirmed. Refresh and check the inbox.');
  touchMutationHold();
  const id = typeof result.id === 'string' && result.id ? result.id : undefined;
  return { at: result.at, duplicate: result.duplicate === true, accepted: result.accepted === true, ...(id ? { id } : {}) };
}

export async function postInterjection(text: string): Promise<{ at: string; id?: string }> {
  const { at, id } = await post(text);
  return { at, ...(id ? { id } : {}) };
}

/** The planner's acknowledgement of one inbox entry; every field is optional on older servers. */
export async function readInboxAck(id: string, signal?: AbortSignal): Promise<InboxAck> {
  const value = await apiGet<{ inbox?: Array<{ id?: unknown; ack?: unknown } | null> }>('/api/verse/fleet/runs/inbox?limit=100', signal);
  const entry = Array.isArray(value?.inbox) ? value.inbox.find(row => row?.id === id) : undefined;
  return entry?.ack === 'acked' || entry?.ack === 'skipped' || entry?.ack === 'pending' ? entry.ack : 'unknown';
}

export const postInterjectionDetailed = post;
