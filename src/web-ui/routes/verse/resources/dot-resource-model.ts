/**
 * routes/verse/resources/dot-resource-model.ts — the Dot (Ashlr.) card in the
 * Resources drawer (⌘.). Facts come from the same comms-status read the inbox
 * Comms card uses: the teammate log carries the newest inbound text time, the
 * unanswered count and the oldest waiting age; iMessage ack evidence carries
 * the last reply time; the path check says whether the transport is configured.
 * A missing fact stays null and the state reads honestly — numbers are never
 * invented, and Dot's own usage allowance is never read or estimated.
 */
import type { CommsStatus } from '../fleet-inbox/comms-status-model.js';

/** An unanswered inbound older than this counts as waiting on the fleet. */
export const DOT_WAITING_MINUTES = 5;
/** Any contact inside this window reads "live". Same window the sidebar Dot row uses. */
export const DOT_LIVE_WINDOW_MINUTES = 60;
export const DOT_USAGE_NOTE = 'Usage: own allowance, not read by Phantom';
export const DOT_NO_CONTACT = 'No contact on record';

export type DotResourceState = 'live' | 'waiting-on-fleet' | 'quiet' | 'not-configured' | 'unknown';

export interface DotResourceInput {
  /** iMessage comms transport configured; null when that read is unavailable. */
  configured: boolean | null;
  lastInboundAt: string | null;
  lastReplyAt: string | null;
  /** Unanswered inbound texts; null when the teammate log is unreadable. */
  pending: number | null;
  /** Age in minutes of the oldest still-unanswered text; null when none or unreadable. */
  oldestPendingMinutes: number | null;
}

export interface DotResourceView {
  state: DotResourceState;
  lastInboundAt: string | null;
  lastReplyAt: string | null;
  pending: number | null;
  /** "last from Dot 4m ago · last reply 1m ago" — a half with no time is dropped. */
  line: string;
}

function agoText(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

const ageMinutes = (iso: string, now: number): number => Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));

const parseable = (value: string | null): string | null =>
  value !== null && Number.isFinite(Date.parse(value)) ? value : null;

export function dotResourceModel(input: DotResourceInput, now: number): DotResourceView {
  const lastInboundAt = parseable(input.lastInboundAt);
  const lastReplyAt = parseable(input.lastReplyAt);
  const line = [
    lastInboundAt !== null ? `last from Dot ${agoText(ageMinutes(lastInboundAt, now))}` : null,
    lastReplyAt !== null ? `last reply ${agoText(ageMinutes(lastReplyAt, now))}` : null,
  ].filter((part) => part !== null).join(' · ') || DOT_NO_CONTACT;

  const inboundMs = lastInboundAt === null ? null : Date.parse(lastInboundAt);
  const replyMs = lastReplyAt === null ? null : Date.parse(lastReplyAt);
  let state: DotResourceState;
  if (input.configured === false) {
    state = 'not-configured';
  } else {
    // The teammate log's own answer markers are the authority on a waiting text;
    // the time comparison covers gaps the marker write never recorded.
    const waitingByLog = input.pending !== null && input.pending > 0
      && input.oldestPendingMinutes !== null && input.oldestPendingMinutes > DOT_WAITING_MINUTES;
    const waitingByTimes = inboundMs !== null && (replyMs === null || inboundMs > replyMs)
      && now - inboundMs > DOT_WAITING_MINUTES * 60_000;
    const freshest = Math.max(inboundMs ?? -Infinity, replyMs ?? -Infinity);
    if (waitingByLog || waitingByTimes) state = 'waiting-on-fleet';
    else if (freshest !== -Infinity && now - freshest <= DOT_LIVE_WINDOW_MINUTES * 60_000) state = 'live';
    else if (freshest !== -Infinity || input.configured === true || input.pending !== null) state = 'quiet';
    else state = 'unknown';
  }
  return { state, lastInboundAt, lastReplyAt, pending: input.pending, line };
}

/** Project the shared comms-status read into the card input. A teammate log that is not healthy contributes nothing — not even partial facts. */
export function dotResourceFromStatus(status: CommsStatus | null, now: number): DotResourceView {
  const teammate = status?.teammate && status.teammate.sourceState === 'healthy' ? status.teammate : null;
  const configState = status?.imessage?.configuration.state;
  return dotResourceModel({
    configured: configState === 'configured' ? true : configState === 'disabled' ? false : null,
    lastInboundAt: teammate?.latestTextAt ?? null,
    lastReplyAt: status?.imessage?.lastAckAt ?? null,
    pending: teammate?.unanswered ?? null,
    oldestPendingMinutes: teammate?.oldestUnanswered?.ageMinutes ?? null,
  }, now);
}
