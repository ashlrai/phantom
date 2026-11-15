/**
 * components/notifications/leader-reply-mark-store.ts — localStorage
 * persistence for the Leader-reply high-water mark: the epoch ms of the
 * newest Leader line Mason has already been told about (or has seen).
 * Operational state, never a secret.
 *
 * Never throws: unreadable storage and bad JSON both read as "no mark", which
 * makes the next load seed again instead of bursting old lines.
 */
export const LEADER_REPLY_MARK_STORAGE_KEY = 'phantom.leaderReplyMark.v1';

/** The stored mark, or null when absent or unreadable (the caller seeds). */
export function loadLeaderReplyMark(): number | null {
  try {
    const raw = localStorage.getItem(LEADER_REPLY_MARK_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function saveLeaderReplyMark(mark: number): void {
  try {
    localStorage.setItem(LEADER_REPLY_MARK_STORAGE_KEY, JSON.stringify(mark));
  } catch {
    /* best-effort */
  }
}
