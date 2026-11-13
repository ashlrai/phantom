/**
 * routes/verse/leader-thread/DotReplyAge.model.ts — the pure mapping from the
 * teammate reply-age read (GET /api/verse/comms/teammate-reply-age) to the one
 * header line. Kept framework-free so it unit-tests without a DOM.
 *
 * `answered` is `lastOutboundAt >= lastInboundAt`: the server reports the
 * answer-marker time of the newest inbound text, so the comparison is exactly
 * "the last text was resolved". The bucket is `ok` under ten minutes
 * unanswered, `late` at ten or more, and `unknown` when there is no data —
 * absent is never rendered as a fabricated time.
 */
export interface DotReplyAgeRead {
  lastInboundAt?: string | null;
  lastOutboundAt?: string | null;
  answered?: boolean | null;
  source?: string | null;
}

export type DotReplyAgeBucket = 'answered' | 'ok' | 'late' | 'unknown';

export interface DotReplyAgeView {
  bucket: DotReplyAgeBucket;
  answered: boolean;
  ageMinutes: number | null;
  text: string;
}

/** Unanswered is quiet under this many minutes and urgent at or past it. */
export const DOT_REPLY_LATE_MINUTES = 10;

function ageText(ageMinutes: number): string {
  if (ageMinutes < 1) return '<1 min';
  if (ageMinutes < 60) return `${ageMinutes} min`;
  const hours = Math.floor(ageMinutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export function dotReplyAge(read: DotReplyAgeRead | null | undefined, nowMs: number = Date.now()): DotReplyAgeView {
  const unknown = (text: string): DotReplyAgeView => ({ bucket: 'unknown', answered: false, ageMinutes: null, text });
  if (read === null || read === undefined || typeof read !== 'object' || (read.source !== 'healthy' && read.source !== 'missing')) {
    return unknown('Dot: reply status unknown');
  }
  const inbound = read.lastInboundAt;
  if (read.source === 'missing' || inbound === null || inbound === undefined) {
    return unknown('Dot: no iMessage record yet');
  }
  const inboundMs = typeof inbound === 'string' ? Date.parse(inbound) : NaN;
  if (!Number.isFinite(inboundMs)) return unknown('Dot: reply status unknown');
  if (read.lastOutboundAt != null && (typeof read.lastOutboundAt !== 'string' || !Number.isFinite(Date.parse(read.lastOutboundAt)))) return unknown('Dot: reply status unknown');
  const outboundMs = typeof read.lastOutboundAt === 'string' ? Date.parse(read.lastOutboundAt) : NaN;
  const answered = Number.isFinite(outboundMs) && outboundMs >= inboundMs;
  const ageMinutes = Math.max(0, Math.floor((nowMs - inboundMs) / 60_000));
  const age = ageText(ageMinutes);
  if (answered) return { bucket: 'answered', answered: true, ageMinutes, text: `Dot: last text ${age} ago, answered` };
  const bucket: DotReplyAgeBucket = ageMinutes >= DOT_REPLY_LATE_MINUTES ? 'late' : 'ok';
  return { bucket, answered: false, ageMinutes, text: `Dot: last text ${age} ago, NOT answered` };
}
