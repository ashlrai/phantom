/** Narrowed view for GET /api/verse/fleet/control/slack-trace. Ids and timestamps only. Never throws. */
export type SlackTraceOutcomeLabel = 'ANSWERED' | 'UNCERTAIN' | 'BUS-FAILED' | 'UNANSWERED';
export interface SlackTraceViewRow { at: string; channelId?: string; threadTs: string; ingress: string; outcome: SlackTraceOutcomeLabel; replyTs: string | null }
export interface SlackTraceView {
  asOf: string;
  rows: SlackTraceViewRow[];
  total: number;
  counts: { answered: number; uncertain: number; busFailed: number; unanswered: number };
  truncated: boolean;
  complete: boolean;
  /** Header line; never an all-clear when evidence is incomplete or empty. */
  header: string;
}

export const SLACK_TRACE_VIEW_ROWS = 20;
const LABELS: Record<string, SlackTraceOutcomeLabel> = {
  answered: 'ANSWERED', uncertain: 'UNCERTAIN', 'bus-failed': 'BUS-FAILED', unanswered: 'UNANSWERED',
};
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const str = (v: unknown): string => typeof v === 'string' ? v.slice(0, 64) : '';
const state = (v: unknown): string => typeof v === 'string' && v ? v.slice(0, 32) : 'unknown';

export function narrowSlackTrace(raw: unknown): SlackTraceView | null {
  if (!object(raw) || !Array.isArray(raw.rows) || !object(raw.counts) || !object(raw.sources)) return null;
  const rows = raw.rows.slice(0, SLACK_TRACE_VIEW_ROWS).flatMap((r): SlackTraceViewRow[] => {
    if (!object(r)) return [];
    const outcome = typeof r.outcome === 'string' ? LABELS[r.outcome] : undefined;
    if (!outcome || !str(r.at)) return [];
    return [{ at: str(r.at), channelId: typeof r.channelId === 'string' && r.channelId.length <= 64 ? r.channelId : undefined, threadTs: str(r.threadTs), ingress: str(r.ingress) || 'unknown', outcome, replyTs: str(r.replyTs) || null }];
  });
  const c = raw.counts;
  const counts = { answered: count(c.answered), uncertain: count(c.uncertain), busFailed: count(c.busFailed), unanswered: count(c.unanswered) };
  const journal = state(raw.sources.journal), sends = state(raw.sources.sends);
  const complete = journal === 'ok' && sends === 'ok';
  const total = count(c.total);
  const summary = `${total} requests · ${counts.answered} answered · ${counts.uncertain} uncertain · ${counts.busFailed} bus-failed · ${counts.unanswered} unanswered`;
  const header = !complete ? `evidence incomplete (journal=${journal} sends=${sends})`
    : total === 0 && rows.length === 0 ? 'No Slack request evidence' : summary;
  return { asOf: str(raw.asOf), rows, total, counts, truncated: raw.truncated === true, complete, header };
}
