/**
 * The Leader reply box's kept draft, the pure half. What Mason has typed and not sent is written to this
 * browser's storage on every change, so a reload, a crash or a closed window does not lose it. It never
 * leaves this computer and nothing here sends it. A time the record does not hold says "unknown".
 */
import { formatRelative } from '../autonomy/format.js';

export const REPLY_DRAFT_KEY = 'phantom.leaderReplyDraft.v1';
/** The reply box's own limit (its maxLength, and what thread-reply-model's trimReply sends). */
export const REPLY_LIMIT = 6000;
/** From here on the box says how much room is left. */
export const NEAR_LIMIT = 5400;

export interface SavedDraft {
  text: string;
  /** When it was last edited, epoch ms; null when the record does not say. */
  at: number | null;
}

/** localStorage can be denied (private mode); the draft is then kept only while the pane is open. */
export function draftStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** One stored record; null for anything that is not a non-blank draft. */
export function parseDraft(raw: string | null | undefined): SavedDraft | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { text, at } = value as { text?: unknown; at?: unknown };
    if (typeof text !== 'string' || text.trim() === '') return null;
    return { text: text.slice(0, REPLY_LIMIT), at: typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null };
  } catch {
    return null;
  }
}

export function loadDraft(storage: Storage | null): SavedDraft | null {
  try { return parseDraft(storage?.getItem(REPLY_DRAFT_KEY)); } catch { return null; }
}

/** Keeps a non-blank draft and forgets a blank one. `failed` means it exists only in the open pane. */
export function saveDraft(storage: Storage | null, text: string, at: number): 'saved' | 'cleared' | 'failed' {
  if (!storage) return 'failed';
  try {
    if (text.trim() === '') { storage.removeItem(REPLY_DRAFT_KEY); return 'cleared'; }
    storage.setItem(REPLY_DRAFT_KEY, JSON.stringify({ text: text.slice(0, REPLY_LIMIT), at }));
    return 'saved';
  } catch {
    return 'failed';
  }
}

/** The line shown when a kept draft is put back in the box. */
export function restoredLabel(saved: SavedDraft, now: number): string {
  return saved.at === null ? 'Draft restored. When it was last edited is unknown.'
    : `Draft restored, last edited ${formatRelative(new Date(saved.at).toISOString(), now)}.`;
}

export interface LimitNote {
  tone: 'near' | 'full';
  text: string;
  /** How much of the last stretch before the limit is used, 0 to 1. */
  fill: number;
}

/** Nothing until the draft nears the box's limit; then the count, and at the limit what happens next. */
export function limitNote(length: number): LimitNote | null {
  if (length < NEAR_LIMIT) return null;
  const count = `${Math.min(length, REPLY_LIMIT).toLocaleString('en-US')} of ${REPLY_LIMIT.toLocaleString('en-US')} characters`;
  if (length >= REPLY_LIMIT) return { tone: 'full', text: `${count}. The box is full: anything typed or pasted past this is dropped.`, fill: 1 };
  return { tone: 'near', text: `${count}, ${(REPLY_LIMIT - length).toLocaleString('en-US')} left.`, fill: (length - NEAR_LIMIT) / (REPLY_LIMIT - NEAR_LIMIT) };
}
