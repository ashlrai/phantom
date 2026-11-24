/**
 * routes/verse/leader-thread/leader-reading.ts: where a session named in the
 * Leader chat opens. A routed job's Conversation button, a job named in a
 * command's answer and `/thread` all ask here. While a Leader pane is on
 * screen the session opens in that pane (beside the chat when there is room,
 * over it otherwise), so reading a session never takes Mason away from the
 * Leader. With no Leader pane mounted (the chat rendered by itself) it opens
 * in the Conversations pane, as it always did.
 *
 * The store also knows which sessions are open, so the button that opened one
 * can say so, and it hands the keyboard back to that button when the
 * conversation closes.
 */
import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { openDockPane } from '../dock/dock-store.js';
import { requestWallSession } from '../session-wall/wall-selection.js';

/** `leader`: in the Leader pane the request came from. `conversations`: handed to the Conversations pane. */
export type ReadingPlace = 'leader' | 'conversations';

interface Surface {
  root: () => HTMLElement | null;
  open: (id: string, from: HTMLElement | null) => void;
  reading: string | null;
}

/** Session ids are job ids, `leader`, or helper ids: one short token, never free text. */
const SESSION_ID_RE = /^[\w.:@-]{1,160}$/;

const surfaces: Surface[] = [];
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Opens `id` as a conversation and says where. The Leader pane holding the keyboard wins; failing that, the newest one. */
export function openConversationFromLeader(id: string): ReadingPlace {
  const from = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const surface = SESSION_ID_RE.test(id)
    ? surfaces.find(candidate => from !== null && candidate.root()?.contains(from)) ?? surfaces[surfaces.length - 1]
    : undefined;
  if (!surface) {
    requestWallSession(id);
    openDockPane('session-wall');
    return 'conversations';
  }
  surface.open(id, from);
  return 'leader';
}

/** True while a Leader pane has `id` open as a conversation. */
export function useIsReading(id: string): boolean {
  return useSyncExternalStore(subscribe, () => surfaces.some(surface => surface.reading === id), () => false);
}

/**
 * Makes a Leader pane the place its chat opens sessions in. `reading` is the
 * session it has open (null for none) and `open` shows one. When the
 * conversation a chat button opened closes, that button gets the keyboard
 * back, unless Mason has since moved to another session from the strip.
 */
export function useLeaderReading(root: RefObject<HTMLElement | null>, reading: string | null, open: (id: string) => void): void {
  const show = useRef(open);
  useEffect(() => { show.current = open; }, [open]);
  const surface = useRef<Surface | null>(null);
  const opener = useRef<{ id: string; node: HTMLElement } | null>(null);
  const last = useRef<string | null>(null);

  useEffect(() => {
    const entry: Surface = {
      root: () => root.current,
      reading: last.current,
      open: (id, from) => {
        opener.current = from && root.current?.contains(from) ? { id, node: from } : null;
        show.current(id);
      },
    };
    surface.current = entry;
    surfaces.push(entry);
    changed();
    return () => {
      surface.current = null;
      const at = surfaces.indexOf(entry);
      if (at >= 0) surfaces.splice(at, 1);
      changed();
    };
  }, [root]);

  useEffect(() => {
    const before = last.current;
    last.current = reading;
    if (surface.current) surface.current.reading = reading;
    changed();
    if (reading !== null) return;
    const from = opener.current;
    opener.current = null;
    if (!from || from.id !== before) return;
    // A chat that was covered may have drawn its lines again: the same session's button then stands in for the one clicked.
    const door = from.node.isConnected ? from.node
      : [...(root.current?.querySelectorAll<HTMLElement>('[data-conversation-door]') ?? [])].find(node => node.dataset.conversationDoor === from.id);
    door?.focus();
  }, [reading, root]);
}
