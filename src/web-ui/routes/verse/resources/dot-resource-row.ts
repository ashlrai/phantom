/**
 * Pure model for the Dot (Ashlr.) row in the Resources sidebar. Facts come from
 * the existing comms-status read (last reply = newest iMessage ack, reply speed
 * and waiting count = teammate latency). A missing fact is null and reads
 * "No reading yet": a number is never invented or defaulted to zero.
 */
import type { CommsStatus } from '../fleet-inbox/comms-status-model.js';

export const DOT_ACTIVE_WINDOW_MINUTES = 60;
export const DOT_NO_READING = 'No reading yet';

export interface DotResourceRow {
  label: 'Dot (Ashlr.)';
  model: 'Astra 6';
  usageNote: 'own usage, not plan usage';
  /** "12m ago", or "No reading yet" when no reply time is on record. */
  lastReplyAgo: string;
  medianReplyMinutes: number | null;
  /** Null when the teammate log could not be read; 0 is a real reading. */
  waitingCount: number | null;
  state: 'active' | 'quiet' | 'unknown';
  /** Where the reading came from, for the hover text. */
  source: string;
}

function agoText(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export function dotResourceRow(status: CommsStatus | null, now: number): DotResourceRow {
  const base = { label: 'Dot (Ashlr.)', model: 'Astra 6', usageNote: 'own usage, not plan usage' } as const;
  const lastAt = status?.imessage?.lastAckAt ? Date.parse(status.imessage.lastAckAt) : NaN;
  const teammate = status?.teammate && status.teammate.sourceState === 'healthy' ? status.teammate : null;
  const medianReplyMinutes = teammate?.medianMinutes ?? null;
  const waitingCount = teammate ? teammate.unanswered : null;
  const source = status
    ? `Comms status (iMessage acks, teammate log) read ${new Date(status.generatedAt).toISOString()}`
    : 'Comms status not read yet';
  if (!Number.isFinite(lastAt)) {
    return { ...base, lastReplyAgo: DOT_NO_READING, medianReplyMinutes, waitingCount, state: 'unknown', source };
  }
  const minutes = Math.max(0, Math.floor((now - lastAt) / 60_000));
  return {
    ...base, lastReplyAgo: agoText(minutes), medianReplyMinutes, waitingCount, source,
    state: minutes <= DOT_ACTIVE_WINDOW_MINUTES ? 'active' : 'quiet',
  };
}
