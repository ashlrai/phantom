/** Wire shapes the /verse/ interject box sends and reads; pure so the server-side e2e test shares them. */
export const INTERJECT_POST_PATH = '/api/verse/fleet/runs/inbox';
export const INTERJECT_ACK_READ_PATH = '/api/verse/fleet/runs/inbox?limit=100';
export const INTERJECT_SOURCE = 'Phantom desktop';

export type InboxAck = 'acked' | 'skipped' | 'pending' | 'unknown';

/** One id per composed message; a retry reposts the same id so the Hub replays
 * the first write instead of appending twice. The grammar matches the route's
 * `CHANNEL_REQUEST_ID_PATTERN` — a malformed id is rejected, never rewritten. */
export function mintInterjectRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `req-${uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`}`;
}

/** `requestId` rides along when the caller already minted one for this composed
 * message — retries pass the same value so a repeat lands only once. */
export function buildInterjectBody(text: string, requestId?: string): { text: string; source: string; requestId?: string } {
  return requestId === undefined
    ? { text, source: INTERJECT_SOURCE }
    : { text, source: INTERJECT_SOURCE, requestId };
}

/** GET inbox answers `{ entries: [{ id, ack }] }`; the legacy `inbox` key is still read, and missing id/ack reads as unknown. */
export function pickInboxAck(value: unknown, id: string): InboxAck {
  const wire = value as { entries?: unknown; inbox?: unknown } | null;
  const entries = wire?.entries ?? wire?.inbox;
  const row = Array.isArray(entries)
    ? entries.find((entry: { id?: unknown } | null) => entry?.id === id) as { ack?: unknown } | undefined
    : undefined;
  return row?.ack === 'acked' || row?.ack === 'skipped' || row?.ack === 'pending' ? row.ack : 'unknown';
}
