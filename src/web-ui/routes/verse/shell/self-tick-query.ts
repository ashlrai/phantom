import { getReadClientProof, reportSessionExpired } from '../../../data/auth-store.js';
import type { QueryDef } from '../../../data/queries.js';
import { isRemoteMobileMode } from '../../../data/remote-mode.js';

/**
 * Wire mirror of core's SelfTickLastView (fleet/self-tick-last.ts): declared
 * here rather than imported so the web bundle never pulls server code.
 */
export interface SelfTickLastOk {
  state: 'ok';
  at: string;
  mode: 'apply' | 'dry-run';
  ranState: 'ran' | 'busy';
  ageSeconds: number;
  failedSteps: string[];
}
export interface SelfTickLastUnreadable { state: 'unreadable' }
export type SelfTickLastView = SelfTickLastOk | SelfTickLastUnreadable;
export interface SelfTickData {
  v: 1;
  /** null when no self-tick run has ever been recorded. */
  last: SelfTickLastView | null;
}
export type SelfTickRead = { kind: 'available'; data: SelfTickData } | { kind: 'notInBuild' };

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function isSelfTickLastView(value: unknown): value is SelfTickLastView {
  if (!object(value)) return false;
  if (value.state === 'unreadable') return true;
  return value.state === 'ok' && typeof value.at === 'string'
    && (value.mode === 'apply' || value.mode === 'dry-run')
    && (value.ranState === 'ran' || value.ranState === 'busy')
    && typeof value.ageSeconds === 'number' && Number.isSafeInteger(value.ageSeconds) && value.ageSeconds >= 0
    && Array.isArray(value.failedSteps) && value.failedSteps.every((step: unknown) => typeof step === 'string');
}

function isSelfTickData(value: unknown): value is SelfTickData {
  return object(value) && value.v === 1 && (value.last === null || isSelfTickLastView(value.last));
}

export const selfTickQuery: QueryDef<SelfTickRead> = {
  key: 'verse-fleet-self-tick',
  async fetch(signal) {
    const remote = isRemoteMobileMode();
    try {
      const response = await fetch('/api/verse/fleet/self-tick', {
        method: 'GET', credentials: 'same-origin', signal,
        ...(remote ? { cache: 'no-store', redirect: 'manual' } : { headers: { 'x-ashlr-read-client': getReadClientProof() } }),
      });
      if (response.status === 401 || remote && (response.type === 'opaqueredirect'
        || response.status >= 300 && response.status < 400 || response.headers.get('content-type')?.includes('text/html'))) {
        reportSessionExpired();
      }
      if (response.status !== 200) return { kind: 'notInBuild' };
      const data: unknown = await response.json();
      return isSelfTickData(data) ? { kind: 'available', data } : { kind: 'notInBuild' };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { kind: 'notInBuild' };
    }
  },
};
