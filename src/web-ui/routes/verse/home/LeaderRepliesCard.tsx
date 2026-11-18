/**
 * Home's "From your leader" card, on the desktop and the phone: the newest
 * things the leader told Mason, in the leader's own words. Built only on the
 * `phm leader replies --json` report (leader.replies.v1). Read-only: nothing
 * is sent, and the text is untrusted, so it renders plain.
 */
import type { LeaderRepliesV1 } from '../../../../core/fleet/mason-outbox.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './home.module.css';

export const LEADER_REPLIES_PATH = '/api/verse/fleet/runs/leader-replies';
/** One cached read per size: three on desktop Home, the newest one on the phone. */
export const leaderRepliesQuery = (limit: number): QueryDef<LeaderRepliesV1> => ({ key: `leader-replies-${limit}`, fetch: signal => apiGet(`${LEADER_REPLIES_PATH}?limit=${limit}`, signal) });
export const LEADER_REPLIES_EMPTY = 'No replies yet.';

/** Only a well-formed leader.replies.v1 payload is a report; anything else (an older server, an error body) hides the card. */
function reportOf(data: unknown): LeaderRepliesV1 | null {
  if (data === null || typeof data !== 'object') return null;
  const report = data as Partial<LeaderRepliesV1>;
  return report.schema === 'leader.replies.v1' && Array.isArray(report.replies) ? report as LeaderRepliesV1 : null;
}

/** The leader writes Eastern wall time; an instant shows in the reader's own zone; anything else is unknown. */
export function replyWhen(at: string): string {
  if (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(at)) return `${at} ET`;
  const instant = Date.parse(at);
  return Number.isFinite(instant) ? new Date(instant).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Time unknown';
}

export function LeaderRepliesCard({ visible = true, limit = 3 }: { visible?: boolean; limit?: number }) {
  const query = leaderRepliesQuery(limit);
  const read = useQuery(query, { enabled: visible });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const report = reportOf(read.data);
  if (!report) return null;
  return <section className={styles.card} aria-label="From your leader">
    <h3>From your leader</h3>
    {report.replies.length > 0 && <ul>
      {report.replies.slice(0, limit).map(reply => <li key={`${reply.at} ${reply.text}`} className={styles.reply}>
        <span className={styles.replyWhen} {...(reply.at === 'unknown' ? { 'data-unknown': true } : {})}>{replyWhen(reply.at)}</span>
        <p>{reply.text}</p>
      </li>)}
    </ul>}
    {report.sourceState !== 'healthy'
      ? <p data-unknown>Unknown: {report.reason ?? 'the plan log could not be read.'}</p>
      : report.replies.length === 0 ? <p role="status">{LEADER_REPLIES_EMPTY}</p> : null}
  </section>;
}
