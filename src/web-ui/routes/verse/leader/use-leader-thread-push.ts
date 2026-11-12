/**
 * use-leader-thread-push.ts — refetch the Leader thread the moment another
 * process writes it. Rides the app's shared /api/events stream (data/sse.ts):
 * the server watches the thread file and sends a body-less `leader-thread`
 * event, and the thread is re-read through its authenticated route.
 *
 * `live` is false whenever that stream is not open (signed out, reconnecting,
 * the scoped console that has no stream), so the caller keeps its polling.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { isSseLive, onSseEvent, subscribeSseLive } from '../../../data/sse.js';

export function useLeaderThreadPush(refetch: () => void): { live: boolean } {
  const live = useSyncExternalStore(subscribeSseLive, isSseLive, () => false);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  useEffect(() => onSseEvent('leader-thread', () => refetchRef.current()), []);
  // A stream that just (re)opened may have missed writes while it was down.
  useEffect(() => {
    if (live) refetchRef.current();
  }, [live]);
  return { live };
}
