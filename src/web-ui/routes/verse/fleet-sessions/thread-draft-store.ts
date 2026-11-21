/**
 * routes/verse/fleet-sessions/thread-draft-store.ts: what Mason has typed to a
 * session and not sent, and what he sent that no record names yet, each kept
 * under the session it was written to. A conversation's reply box used to hold
 * its words itself, so moving to another session either dropped them or left
 * them in a box now aimed at somebody else.
 *
 * Drafts are written to this browser's storage on every change (the Leader
 * reply box does the same, reply-draft-model.ts), so a reload does not lose
 * them; they never leave this computer and nothing here sends one. When
 * storage is denied (private mode) they last as long as the window does. Sent
 * lines are kept for the window only: the next read's own record replaces them.
 */
import { useCallback, useSyncExternalStore } from 'react';

export const THREAD_DRAFTS_KEY = 'phantom.sessionThreadDrafts.v1';
/** Sessions with a kept draft; the ones edited longest ago are dropped first. */
export const MAX_DRAFTS = 40;
/** Mirror of the reply box's limit (THREAD_REPLY_MAX in session-thread-model.ts). */
const MAX_TEXT = 6_000;

export interface ThreadDraft {
  text: string;
  /** When it was last edited, epoch ms; null when the record does not say. */
  at: number | null;
}
/** A message sent from a conversation, shown there until the read holds the inbox's own record of it. */
export interface SentLine { key: string; at: string; text: string }

const NO_LINES: readonly SentLine[] = [];
let drafts: Map<string, ThreadDraft> | null = null;
let watching = false;
const sent = new Map<string, readonly SentLine[]>();
const listeners = new Set<() => void>();

function draftsStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}
const emit = () => { for (const listener of [...listeners]) listener(); };

/** The stored drafts; anything unreadable, misshapen or blank is dropped, never trusted. */
export function parseThreadDrafts(raw: string | null | undefined): Map<string, ThreadDraft> {
  const out = new Map<string, ThreadDraft>();
  if (!raw) return out;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
    for (const [id, record] of Object.entries(value)) {
      if (typeof record !== 'object' || record === null) continue;
      const { text, at } = record as { text?: unknown; at?: unknown };
      if (typeof text !== 'string' || text.trim() === '') continue;
      out.set(id, { text: text.slice(0, MAX_TEXT), at: typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null });
    }
  } catch { /* an unreadable record is no record */ }
  return out;
}

function load(): Map<string, ThreadDraft> {
  if (drafts === null) {
    let raw: string | null = null;
    try { raw = draftsStorage()?.getItem(THREAD_DRAFTS_KEY) ?? null; } catch { /* storage denied */ }
    drafts = parseThreadDrafts(raw);
    if (!watching && typeof window !== 'undefined') {
      watching = true;
      // Another window of the console edited a draft: both show the same words.
      window.addEventListener('storage', event => {
        if (event.key !== THREAD_DRAFTS_KEY && event.key !== null) return;
        drafts = parseThreadDrafts(event.key === null ? null : event.newValue);
        emit();
      });
    }
  }
  return drafts;
}

function persist(all: Map<string, ThreadDraft>): void {
  try {
    const storage = draftsStorage();
    if (all.size === 0) storage?.removeItem(THREAD_DRAFTS_KEY);
    else storage?.setItem(THREAD_DRAFTS_KEY, JSON.stringify(Object.fromEntries(all)));
  } catch { /* storage denied or full: the drafts last as long as the window */ }
}

/** The kept draft for a session, null when there is none. */
export const keptThreadDraft = (id: string): ThreadDraft | null => load().get(id) ?? null;
/** The words waiting in a session's reply box; '' when none. */
export const threadDraft = (id: string): string => load().get(id)?.text ?? '';
/** Blank words are no draft: a box holding only spaces marks nothing. */
export const hasThreadDraft = (id: string): boolean => load().has(id);

/** Keeps the words under their session, or forgets the session's draft when they are blank. */
export function setThreadDraft(id: string, text: string, now = Date.now()): void {
  const all = load(), kept = all.get(id);
  if (text.trim() === '') {
    if (!kept) return;
    all.delete(id);
  } else {
    if (kept?.text === text) return;
    all.set(id, { text: text.slice(0, MAX_TEXT), at: now });
    if (all.size > MAX_DRAFTS) {
      const oldest = [...all].filter(([other]) => other !== id).sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0))[0];
      if (oldest) all.delete(oldest[0]);
    }
  }
  persist(all);
  emit();
}

/** What was sent from a session's conversation and is not on its record yet. */
export const threadSent = (id: string): readonly SentLine[] => sent.get(id) ?? NO_LINES;

export function setThreadSent(id: string, lines: readonly SentLine[]): void {
  if (lines.length === 0) { if (!sent.delete(id)) return; } else sent.set(id, lines);
  emit();
}
export const addThreadSent = (id: string, line: SentLine): void => setThreadSent(id, [...threadSent(id), line]);
/** Drops the sent lines the read now holds a record of. */
export function settleThreadSent(id: string, onRecord: (text: string) => boolean): void {
  const lines = threadSent(id), left = lines.filter(line => !onRecord(line.text));
  if (left.length !== lines.length) setThreadSent(id, left);
}

export function subscribeThreadDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A session's draft and the way to change it, shared by every box open on that session. */
export function useThreadDraft(id: string): readonly [string, (text: string) => void] {
  const text = useSyncExternalStore(subscribeThreadDrafts, () => threadDraft(id));
  return [text, useCallback((next: string) => setThreadDraft(id, next), [id])] as const;
}
export function useHasThreadDraft(id: string): boolean {
  return useSyncExternalStore(subscribeThreadDrafts, () => hasThreadDraft(id));
}
/** The lines sent from one session's conversation, with a setter shaped like a state setter's. */
export function useSentLines(id: string): readonly [readonly SentLine[], (update: (lines: readonly SentLine[]) => readonly SentLine[]) => void] {
  const lines = useSyncExternalStore(subscribeThreadDrafts, () => threadSent(id));
  return [lines, useCallback((update: (lines: readonly SentLine[]) => readonly SentLine[]) => setThreadSent(id, update(threadSent(id))), [id])] as const;
}

/** Test seam: forget what is in memory so the next read comes from storage, as a reload would. */
export function reloadThreadDrafts(): void { drafts = null; sent.clear(); emit(); }
/** Test seam: forget every draft and sent line, in memory and in storage. */
export function forgetThreadDrafts(): void {
  drafts = new Map();
  sent.clear();
  try { draftsStorage()?.removeItem(THREAD_DRAFTS_KEY); } catch { /* storage denied */ }
  emit();
}
