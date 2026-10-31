import { apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseMutationLockedError } from '../verse-queries.js';

interface InboxTail {
  inbox: Array<{ at: string; source: string; text: string }>;
  sources?: { inbox?: string };
}

export const inboxTailQuery: QueryDef<InboxTail> = {
  key: 'verse-fleet-inbox-tail',
  async fetch(signal) {
    const value = await apiGet<InboxTail>('/api/verse/fleet/runs', signal);
    if (!value || !Array.isArray(value.inbox) || !value.inbox.every(row => row
      && typeof row.at === 'string' && typeof row.source === 'string' && typeof row.text === 'string')) {
      throw new Error('The inbox tail is unavailable.');
    }
    return { inbox: value.inbox, sources: value.sources };
  },
};

export async function postInterjection(text: string): Promise<{ at: string }> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<{ at: string }>('/api/verse/fleet/runs/inbox', { text, source: 'Phantom desktop' }, token);
  if (!result || typeof result.at !== 'string') throw new Error('The message could not be confirmed. Refresh and check the inbox.');
  touchMutationHold();
  return { at: result.at };
}
