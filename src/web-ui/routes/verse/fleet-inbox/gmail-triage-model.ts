/** The last Gmail triage result for the Inbox pane (GET /api/verse/comms/gmail-triage). Read only; narrowing is defensive, never repairing. */
export const GMAIL_TRIAGE_PATH = '/api/verse/comms/gmail-triage';
/** The CLI that writes the record this card reads. */
export const GMAIL_TRIAGE_COMMAND = 'ashlr fleet gmail-triage --dir <eml dir>';
/** Counts come from the triaged sample, not the whole mailbox. */
export const GMAIL_TRIAGE_SAMPLE_NOTE = 'Counts cover the triaged sample only, not the whole mailbox.';

const SCHEMA = 'fleet.gmail-triage-latest.v1';

export type GmailTriageView =
  | { state: 'never' }
  | {
    state: 'read'; at: string; scanned: number; drafted: number; review: number; failed: number;
    unreadInSample: number; target: number; archiveCandidateCount: number; overTarget: boolean;
  };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export function readGmailTriageView(data: unknown): GmailTriageView | null {
  if (!isRecord(data) || data.schema !== SCHEMA) return null;
  const latest = data.latest;
  if (latest === null) return { state: 'never' };
  if (!isRecord(latest) || latest.schema !== SCHEMA || typeof latest.at !== 'string') return null;
  const { scanned, drafted, review, failed, unreadInSample, target, archiveCandidateCount } = latest;
  if (!isCount(scanned) || !isCount(drafted) || !isCount(review) || !isCount(failed)
    || !isCount(unreadInSample) || !isCount(target) || !isCount(archiveCandidateCount)) return null;
  return {
    state: 'read', at: latest.at, scanned, drafted, review, failed, unreadInSample, target, archiveCandidateCount,
    overTarget: unreadInSample > target,
  };
}

/** "2h ago"; "time unknown" when the time is unparseable or in the future. */
export function triageAge(at: string, nowMs: number): string {
  const then = Date.parse(at);
  if (!Number.isFinite(then) || then > nowMs) return 'time unknown';
  const minutes = Math.floor((nowMs - then) / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export function gmailTriageLine(view: Extract<GmailTriageView, { state: 'read' }>, nowMs: number): { summary: string; unread: string } {
  const age = triageAge(view.at, nowMs);
  const parts = [age === 'time unknown' ? 'Last triage time unknown' : `Last triage ${age}`,
    `${view.scanned} scanned`, `${view.drafted} drafted`, `${view.review} to review`];
  if (view.failed > 0) parts.push(`${view.failed} failed`);
  const unread = view.overTarget
    ? `${view.archiveCandidateCount} archive candidates, unread over target ${view.target}`
    : `${view.unreadInSample} unread in the sample (target ${view.target})`;
  return { summary: parts.join(' · '), unread };
}
