import type { AskBatch } from '../../../../core/fleet/asks-batch.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';

const BASE = '/api/verse/agent-bus/needs-mason/asks';

export const asksBatchQuery: QueryDef<AskBatch> = {
  key: 'verse-asks-batch',
  fetch: async (signal) => {
    const raw = await apiGet<AskBatch>(`${BASE}/batch`, signal);
    if (raw?.schema !== 'asks.batch.v1' || !Array.isArray(raw.asks)) throw new Error('Invalid asks response');
    return raw;
  },
};

/** One tap: the same typed answer route the desktop and `phm asks answer` use. Throws with the server's plain reason on a refusal. */
export async function answerAskOnPhone(id: string, answer: string): Promise<void> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  await apiPost<unknown>(`${BASE}/answer`, { id, answer }, token);
  touchMutationHold();
}
