import { getReadClientProof, reportSessionExpired } from '../../../data/auth-store.js';
import type { QueryDef } from '../../../data/queries.js';
import { isRemoteMobileMode } from '../../../data/remote-mode.js';

export interface NeedsMasonItem {
  id: string;
  text: string;
}
export interface NeedsMasonRead {
  v: 1;
  state: 'absent' | 'ok' | 'unreadable';
  items: NeedsMasonItem[];
}
export type NeedsMasonResult = { kind: 'available'; data: NeedsMasonRead } | { kind: 'notInBuild' };

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function isNeedsMasonRead(value: unknown): value is NeedsMasonRead {
  return object(value) && value.v === 1
    && (value.state === 'absent' || value.state === 'ok' || value.state === 'unreadable')
    && Array.isArray(value.items)
    && value.items.every((item: unknown) => object(item) && typeof item.id === 'string' && typeof item.text === 'string');
}

export const needsMasonQuery: QueryDef<NeedsMasonResult> = {
  key: 'verse-fleet-runs-needs-mason',
  async fetch(signal) {
    const remote = isRemoteMobileMode();
    try {
      const response = await fetch('/api/verse/fleet/runs/needs-mason', {
        method: 'GET', credentials: 'same-origin', signal,
        ...(remote ? { cache: 'no-store', redirect: 'manual' } : { headers: { 'x-ashlr-read-client': getReadClientProof() } }),
      });
      if (response.status === 401 || remote && (response.type === 'opaqueredirect'
        || response.status >= 300 && response.status < 400 || response.headers.get('content-type')?.includes('text/html'))) {
        reportSessionExpired();
      }
      // A 404 — or any non-200 — means this build has no route: no rows, no error.
      if (response.status !== 200) return { kind: 'notInBuild' };
      const data: unknown = await response.json();
      return isNeedsMasonRead(data) ? { kind: 'available', data } : { kind: 'notInBuild' };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { kind: 'notInBuild' };
    }
  },
};
