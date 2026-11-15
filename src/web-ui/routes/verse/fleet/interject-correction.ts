// "Correct last message" for the steer box. The original inbox entry is never
// edited: a correction is a new append-only entry whose text starts with
// `CORRECTION to <entryId>: `. The planner side (RQ-PHX-INBOXCORRECTSUPERSEDE99)
// reads that exact prefix, so the format below is a shared contract.

export const CORRECTION_WINDOW_MS = 30 * 60_000;
export const LAST_SENT_KEY = 'phantom.interject.last-sent.v1';
export const INTERJECT_MAX_CHARS = 6_000;

/** Inbox entry ids minted by appendInboxEntry, e.g. `desk-0123456789abcdef`. */
const ENTRY_ID = /^[a-z0-9]{1,16}-[0-9a-f]{16}$/;

export interface LastSent { id: string; text: string; sentAtMs: number }

export function isCorrectableId(id: unknown): id is string {
  return typeof id === 'string' && ENTRY_ID.test(id);
}

/** The last message sent from this device, if it can still be corrected at `nowMs`. */
export function lastCorrectable(storage: Pick<Storage, 'getItem'>, nowMs: number): LastSent | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(LAST_SENT_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const { id, text, sentAtMs } = value as Record<string, unknown>;
    if (!isCorrectableId(id) || typeof text !== 'string' || !text.trim() || text.length > INTERJECT_MAX_CHARS) return null;
    if (typeof sentAtMs !== 'number' || !Number.isFinite(sentAtMs)) return null;
    const age = nowMs - sentAtMs;
    return age >= 0 && age < CORRECTION_WINDOW_MS ? { id, text, sentAtMs } : null;
  } catch { return null; }
}

/** Records a successful send; `null` forgets it (a send whose id the server did not return). */
export function saveLastSent(storage: Pick<Storage, 'setItem' | 'removeItem'>, sent: LastSent | null): void {
  try {
    if (sent === null || !isCorrectableId(sent.id)) storage.removeItem(LAST_SENT_KEY);
    else storage.setItem(LAST_SENT_KEY, JSON.stringify({ id: sent.id, text: sent.text, sentAtMs: sent.sentAtMs }));
  } catch { /* Storage can be unavailable. */ }
}

export function correctionPrefix(id: string): string {
  return `CORRECTION to ${id}: `;
}

/** The correction entry text, or null when `id` is not an inbox entry id (send normally instead). */
export function buildCorrectionText(id: string, text: string): string | null {
  return isCorrectableId(id) ? `${correctionPrefix(id)}${text.trim()}` : null;
}

/** Room left for the edited text once the prefix counts against the 6,000-char limit. */
export function correctionBodyLimit(id: string): number {
  return INTERJECT_MAX_CHARS - correctionPrefix(id).length;
}

/** `23:07` in local time, for "Correcting your 23:07 message". */
export function correctionClock(sentAtMs: number): string {
  const at = new Date(sentAtMs);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}
