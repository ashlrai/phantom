import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { workBoardQuery } from '../fleet-board/work-board-section.js';
import { joinSlackWork, type SlackWorkCell } from './slack-trace-work-join.js';
import { slackTraceQuery } from './slack-trace-query.js';
import type { SlackTraceView } from './slack-trace-model.js';
import { StatusEvidenceButton } from '../coordination/StatusEvidenceButton.js';
import styles from './fleet-channels.module.css';

/** Read-only: each recent Slack request's ingress receipt and reply outcome. */
export function SlackTraceCard({ visible, nowMs }: { visible: boolean; nowMs: number }) {
  const read = useQuery(slackTraceQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(slackTraceQuery);
  usePollWhileVisible(() => { refetch(); }, 15_000, { enabled: visible });
  const board = useQuery(workBoardQuery, { enabled: visible, freshMs: 0 });
  const refetchBoard = useRefetch(workBoardQuery);
  usePollWhileVisible(() => { refetchBoard(); }, 15_000, { enabled: visible });
  if (read.data === null) return null; // build without the route
  if (read.data === undefined) {
    return <p className={styles.message} role="status">{read.status === 'error' ? 'Slack request trace is unavailable.' : 'Reading Slack request trace…'}</p>;
  }
  return <SlackTraceBody view={read.data} nowMs={nowMs} board={board.data ?? null} />;
}

const OWNED = ['ASSIGNED', 'RUNNING', 'VERIFIED'];

function WorkCell({ cell }: { cell: SlackWorkCell }) {
  if (cell.kind === 'item') {
    const owner = cell.owner ?? (OWNED.includes(cell.state) ? 'owner missing' : 'unassigned');
    return <><span className={styles.healthBadge} title={cell.id}>{cell.state}</span>{` · ${owner}`}</>;
  }
  if (cell.kind === 'ambiguous') return <>{`ambiguous (${cell.count} items)`}</>;
  return <>{cell.kind === 'none' ? 'no work item' : 'unknown'}</>;
}

/** `board` (work-board response) is optional; without it the Work column is omitted. */
export function SlackTraceBody({ view, nowMs, board }: { view: SlackTraceView; nowMs: number; board?: unknown }) {
  const withWork = board !== undefined;
  const when = (iso: string) => Number.isFinite(Date.parse(iso)) ? formatRelative(iso, nowMs) : iso;
  return <section className={styles.root} aria-label="Slack request trace" data-testid="slack-trace">
    <strong>Slack request trace</strong>
    <StatusEvidenceButton />
    <p className={styles.header}>{view.header}{view.asOf && <> · as of {when(view.asOf)}</>}</p>
    {!view.complete && view.total > 0 && <p className={styles.notice} role="status">Counts may be undercounted: {view.total} requests seen.</p>}
    {view.truncated && <p className={styles.message}>Showing the newest {view.rows.length} requests.</p>}
    {view.rows.length > 0 && <table aria-label="Slack request rows">
      <thead><tr><th>Received</th><th>Thread</th><th>Ingress</th><th>Outcome</th><th>Reply</th>{withWork && <th>Work</th>}</tr></thead>
      <tbody>{view.rows.map((row, i) => <tr key={i}>
        <td><time dateTime={row.at}>{when(row.at)}</time></td>
        <td>{row.threadTs}</td><td>{row.ingress}</td>
        <td><span className={styles.healthBadge}>{row.outcome}</span></td>
        <td>{row.replyTs ?? '—'}</td>
        {withWork && <td><WorkCell cell={joinSlackWork(row.threadTs, row.channelId, board)} /></td>}
      </tr>)}</tbody>
    </table>}
  </section>;
}
