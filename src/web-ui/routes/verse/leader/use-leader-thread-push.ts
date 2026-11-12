/** Refetch through the authenticated thread query on invalidation or reconnect. */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { isSseLive, onSseEvent, subscribeSseLive } from '../../../data/sse.js';

export function useLeaderThreadPush(refetch: () => void): { live: boolean } {
  const live = useSyncExternalStore(subscribeSseLive, isSseLive, () => false);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  useEffect(() => onSseEvent('leader-thread', () => refetchRef.current()), []);
  useEffect(() => {
    if (live) refetchRef.current();
  }, [live]);
  return { live };
}
