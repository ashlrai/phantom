/**
 * The transport dead-letter report every bus read shares: the delivery-
 * failure summary a `bus.dead-letter` letter carries under
 * `body.payload.deadLetter` (the sink's wire shape in bus-transport-file),
 * read defensively — stored envelopes are untrusted data, so every field is
 * optional and a missing one stays absent rather than guessed. The address
 * constant is the same literal the status probe, the unified inbox and
 * fleet-edges keep: the router files letters under it, and no import should
 * widen just to name it.
 */
import { scrubSecrets } from '../util/scrub.js';

export const BUS_DEAD_LETTER_ADDRESS = 'bus.dead-letter';

/** The delivery-failure reasons the router records, plus `other` for a
 * letter whose stored body the defensive read cannot classify — the same
 * closed set `agents bus status` tallies. */
export const BUS_DEAD_LETTER_REASONS = ['exhausted', 'expired', 'no-route', 'other'] as const;
export type BusDeadLetterReason = (typeof BUS_DEAD_LETTER_REASONS)[number];

export interface BusDeadLetterReport {
  readonly id: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly kind: string | null;
  readonly reason: string | null;
  readonly attempts: number | null;
  readonly payloadDropped: boolean;
}

export function busDeadLetterReport(body: unknown): BusDeadLetterReport | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const outer = body as Record<string, unknown>;
  const payload = outer.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const letter = (payload as Record<string, unknown>).deadLetter;
  if (letter === null || typeof letter !== 'object' || Array.isArray(letter)) return null;
  const record = letter as Record<string, unknown>;
  const text = (key: string): string | null => {
    const value = record[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };
  const attempts = record.attempts;
  return {
    id: text('id'), from: text('from'), to: text('to'), kind: text('kind'), reason: text('reason'),
    attempts: Array.isArray(attempts) ? attempts.length : null,
    payloadDropped: (payload as Record<string, unknown>).payloadDropped === true,
  };
}

/** The classified failure reason a parsed report carries: the recorded
 * reason when it is one of the router's closed set, `other` for anything
 * else — including a letter whose body never parsed. */
export function busDeadLetterReason(report: BusDeadLetterReport | null): BusDeadLetterReason {
  const reason = report?.reason;
  return reason === 'exhausted' || reason === 'expired' || reason === 'no-route' ? reason : 'other';
}

const DEAD_LETTER_SUMMARY_MAX = 200;

/** Display clip shared by every dead-letter summary: scrub, flatten control
 * characters, collapse whitespace, bound the length — the same field rule
 * the work-mine digest applies to every item summary. */
function clipField(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = scrubSecrets(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The one-line report text a dead-letter item displays — the failure
 * reason, parties, attempt count, original kind/id and the dropped-payload
 * flag, scrubbed and clipped like every other bus summary. Facts the
 * letter never recorded stay absent rather than guessed; a letter whose
 * body never parsed still names itself a dead letter.
 */
export function busDeadLetterSummary(report: BusDeadLetterReport | null): string {
  if (report === null) return 'dead letter';
  const parties = report.from !== null || report.to !== null
    ? `${report.from ?? 'unknown'} → ${report.to ?? 'unknown'}` : 'delivery failure';
  const detail = [
    report.attempts !== null ? `${report.attempts} attempt${report.attempts === 1 ? '' : 's'}` : null,
    report.kind !== null ? `kind ${report.kind}` : null,
    report.id !== null ? `original ${report.id}` : null,
    report.payloadDropped ? 'payload dropped' : null,
  ].filter((part): part is string => part !== null).join(' · ');
  const head = `dead letter${report.reason !== null ? ` ${report.reason}` : ''}: ${parties}`;
  return clipField(detail === '' ? head : `${head} · ${detail}`, DEAD_LETTER_SUMMARY_MAX);
}

/**
 * The `--contains` haystack for a dead-letter report — the descriptive
 * facts only: the failure reason, attempt count, original kind and the
 * dropped-payload flag. The parties and the original envelope id stay out
 * for the same reason every bus read keeps routing labels and wire ids out
 * of a body-summary match — those have their own fields and filters, and a
 * report whose payload was dropped still matches on what the letter itself
 * recorded. The needle fold matches `busReadContains`'s.
 */
export function busDeadLetterContainsText(report: BusDeadLetterReport | null): string {
  if (report === null) return 'dead letter';
  return [
    report.reason !== null ? `dead letter ${report.reason}` : 'dead letter',
    report.attempts !== null ? `${report.attempts} attempt${report.attempts === 1 ? '' : 's'}` : null,
    report.kind !== null ? `kind ${report.kind}` : null,
    report.payloadDropped ? 'payload dropped' : null,
  ].filter((part): part is string => part !== null).join(' · ');
}
