/** Wire shapes the /verse/ interject box sends and reads; pure so the server-side e2e test shares them. */
export const INTERJECT_POST_PATH = '/api/verse/fleet/runs/inbox';
export const INTERJECT_ACK_READ_PATH = '/api/verse/fleet/runs/inbox?limit=100';
export const INTERJECT_SOURCE = 'Phantom desktop';

export type InboxAck = 'acked' | 'skipped' | 'pending' | 'unknown';

export function buildInterjectBody(text: string): { text: string; source: string } {
  return { text, source: INTERJECT_SOURCE };
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
