import { useCallback, useEffect, useRef, useState } from 'react';
import { getMutationToken } from '../../../data/auth-store.js';
import { getQuerySnapshot } from '../../../data/cache.js';
import { useRefetch, useRefresh } from '../../../data/hooks.js';
import { fetchOriginNow } from './update-fetch-client.js';
import { updateStatusQuery } from './update-status-queries.js';

const STORAGE_KEY = 'ashlr.verse.update-fetch.last';
const DEFAULT_INTERVAL_MS = 30 * 60_000;
let fetchInFlight = false;

export function shouldFetchOnFocus(input: {
  lastFetchAt: number | null; now: number; visible: boolean; hasToken: boolean;
  routeAvailable: boolean; minIntervalMs?: number;
}): boolean {
  return input.visible && input.hasToken && input.routeAvailable
    && (input.lastFetchAt === null || input.now - input.lastFetchAt >= (input.minIntervalMs ?? DEFAULT_INTERVAL_MS));
}

export function readLastFetchAt(): number | null {
  try {
    const value = sessionStorage.getItem(STORAGE_KEY);
    if (value === null || value.trim() === '') return null;
    const time = Number(value);
    return Number.isFinite(time) && time >= 0 ? time : null;
  } catch { return null; }
}

export function writeLastFetchAt(ms: number): void {
  try { sessionStorage.setItem(STORAGE_KEY, String(ms)); } catch { /* Storage is optional. */ }
}

export function useFetchOriginOnFocus({ routeAvailable }: { routeAvailable: boolean }): {
  lastFetchAt: number | null; markFetched: () => void;
} {
  const [lastFetchAt, setLastFetchAt] = useState(readLastFetchAt);
  const lastFetchRef = useRef(lastFetchAt);
  const routeRef = useRef(routeAvailable);
  const refetch = useRefetch(updateStatusQuery);
  const refresh = useRefresh(updateStatusQuery);
  const markFetched = useCallback(() => {
    const now = Date.now();
    lastFetchRef.current = now;
    writeLastFetchAt(now);
    setLastFetchAt(now);
  }, []);

  useEffect(() => {
    // The row's query is disabled while the document is hidden. Retain its
    // last known route availability until the visibility event arrives.
    if (document.visibilityState !== 'hidden') routeRef.current = routeAvailable;
  }, [routeAvailable]);

  useEffect(() => {
    function onFocus() {
      const stored = readLastFetchAt();
      const last = stored === null ? lastFetchRef.current
        : lastFetchRef.current === null ? stored : Math.max(stored, lastFetchRef.current);
      if (fetchInFlight || !shouldFetchOnFocus({ lastFetchAt: last, now: Date.now(),
        visible: document.visibilityState !== 'hidden', hasToken: !!getMutationToken(), routeAvailable: routeRef.current })) return;
      fetchInFlight = true;
      void (async () => {
        try {
          const outcome = await fetchOriginNow();
          if (outcome.kind === 'fetched') {
            markFetched();
            // A read started before the fetch cannot report the new origin.
            const status = getQuerySnapshot(updateStatusQuery.key).status;
            if (status === 'loading' || status === 'refreshing') refresh();
            else refetch();
          }
        } finally { fetchInFlight = false; }
      })();
    }
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
    };
  }, [markFetched, refetch, refresh]);
  return { lastFetchAt, markFetched };
}
