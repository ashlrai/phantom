import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export interface WhatsNewRead { version: string; bullets: string[] | null }

export function whatsNewQuery(version: string): QueryDef<WhatsNewRead> {
  return {
    key: `verse-whats-new:${version}`,
    fetch: signal => apiGet<WhatsNewRead>(`/api/verse/whats-new?version=${encodeURIComponent(version)}`, signal),
  };
}
