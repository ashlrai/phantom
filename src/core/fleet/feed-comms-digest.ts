/**
 * fleet/feed-comms-digest.ts: the Comms agent's run as one Feed item. Pure: it
 * only reshapes readings the Comms status surfaces already hold (unread per
 * inbox, archived count, pending drafts, texts from Dot waiting for a reply);
 * it reads no mail or iMessage itself and never sends, archives or drafts.
 *
 * A reading that is missing or not a count stays "unknown" in the text and is
 * never shown as 0. The item id comes from the Comms run id, so polling the
 * same run gives the same id and the Feed dedupes it. An inbox over the unread
 * target, or a draft waiting longer than DRAFT_ALERT_MS, makes the item an
 * alert (the Feed's existing alert kind); otherwise it is a plain fleet item.
 */
import type { FeedItem } from '../../web-ui/routes/verse/feed/feed-model.js';

/** Mason's target: both Gmail inboxes at 100 unread or fewer. */
export const UNREAD_TARGET = 100;
export const DRAFT_ALERT_MS = 12 * 60 * 60 * 1000;

export interface CommsDigestInbox {
  address: string;
  /** null = not read. */
  unread: number | null;
}

export interface CommsDigestInput {
  /** Stable per Comms run; becomes the item id. */
  runId: string;
  /** ISO time of the run. */
  at: string;
  inboxes?: readonly CommsDigestInbox[] | null;
  archived?: number | null;
  drafts?: { pending: number | null; oldestPendingAt?: string | null } | null;
  /** Texts from Dot (Ashlr.AI) still waiting for a reply. */
  dotWaiting?: number | null;
}

const count = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
const show = (value: number | null): string => value === null ? 'unknown' : String(value);

export function buildCommsDigestFeedItems(input: CommsDigestInput | null | undefined, now: number | Date): FeedItem[] {
  if (!input || !input.runId || !Number.isFinite(Date.parse(input.at))) return [];
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const alerts: string[] = [];
  const lines: string[] = [];

  const inboxes = input.inboxes ?? [];
  if (inboxes.length === 0) lines.push(`Unread: unknown (target ${UNREAD_TARGET} or fewer)`);
  for (const inbox of inboxes) {
    const unread = count(inbox.unread);
    lines.push(`${inbox.address}: ${show(unread)} unread (target ${UNREAD_TARGET} or fewer)`);
    if (unread !== null && unread > UNREAD_TARGET) alerts.push(`${inbox.address} has ${unread} unread`);
  }

  lines.push(`Archived this run: ${show(count(input.archived))}`);

  const pending = count(input.drafts?.pending);
  const oldest = input.drafts?.oldestPendingAt ? Date.parse(input.drafts.oldestPendingAt) : NaN;
  const ageMs = Number.isFinite(oldest) ? nowMs - oldest : null;
  let draftLine = `Drafts waiting for Mason: ${show(pending)}`;
  if (pending !== null && pending > 0 && ageMs !== null) {
    const hours = Math.max(0, Math.floor(ageMs / 3_600_000));
    draftLine += ` (oldest ${hours}h)`;
    if (ageMs > DRAFT_ALERT_MS) alerts.push(`a draft has waited over ${DRAFT_ALERT_MS / 3_600_000}h`);
  }
  lines.push(draftLine);

  lines.push(`Texts from Dot waiting for a reply: ${show(count(input.dotWaiting))}`);

  return [{
    id: `comms-digest:${input.runId}`,
    at: input.at,
    kind: alerts.length ? 'alert' : 'fleet',
    title: alerts.length ? `Comms digest: ${alerts.join('; ')}` : 'Comms digest',
    body: lines.join('\n'),
    label: alerts.length ? 'Comms alert' : 'Comms',
  }];
}
