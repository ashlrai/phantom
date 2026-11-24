import { useQuery } from '../../../data/hooks.js';
import { workBoardQuery } from '../fleet-board/work-board-section.js';
import { returnsQuery } from '../fleet-board/returns-query.js';
import { formatRelative } from '../autonomy/format.js';
import styles from '../fleet-channels/fleet-channels.module.css';
import { slackItemLadder, type LadderClaim, type LadderReturn, type LadderRow, type LadderThread } from './slack-item-ladder.js';

export const LADDER_MAX_ROWS = 20;
const rec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => typeof v === 'string' && v.trim() !== '' ? v : null;
/** Last segment of `T/C/ts` or `slack:T:C:ts`. */
const threadOf = (ref: string): string => ref.slice(Math.max(ref.lastIndexOf('/'), ref.lastIndexOf(':')) + 1);

/** Slack items from the work-board read; `null` when the board is unreadable. */
export function boardInputs(board: unknown): { threads: LadderThread[]; claims: LadderClaim[] } | null {
  if (!rec(board) || board['inbox'] !== 'ok' || !Array.isArray(board['items'])) return null;
  const threads: LadderThread[] = []; const claims: LadderClaim[] = [];
  for (const it of board['items'] as unknown[]) {
    if (!rec(it) || it['channel'] !== 'slack') continue;
    const ref = text(it['channelRef']); const at = text(it['receivedAt']);
    if (!ref || !at) continue;
    const threadKey = threadOf(ref);
    threads.push({ threadKey, label: threadKey, at });
    // The board's own RUNNING verdict is the only live-evidence time this read carries.
    claims.push({ threadKey, owner: text(it['owner']), claimId: text(it['claimReceipt']), at: text(it['asOf']),
      liveAt: it['state'] === 'RUNNING' ? text(it['asOf']) : null });
  }
  return { threads, claims };
}

/** Compact one-row-per-thread ladder inside the Slack thread notices card. */
export function SlackItemLadder({ nowMs }: { nowMs: number }) {
  const board = useQuery(workBoardQuery, { enabled: true, freshMs: 0 });
  const returns = useQuery(returnsQuery, { enabled: true, freshMs: 0 });
  const inputs = boardInputs(board.data);
  const ret: LadderReturn[] = returns.data?.state === 'known' ? returns.data.rows : [];
  const rows = inputs ? slackItemLadder(inputs.threads, inputs.claims, ret, new Date(nowMs)) : null;
  return <SlackItemLadderTable rows={rows} nowMs={nowMs} returnsKnown={returns.data?.state === 'known'} />;
}

export function SlackItemLadderTable({ rows, nowMs, returnsKnown = true }: { rows: LadderRow[] | null; nowMs: number; returnsKnown?: boolean }) {
  if (rows === null) return <p className={styles.notice} role="status">Slack work items: unknown (work board unreadable)</p>;
  if (rows.length === 0) return <p className={styles.notice} role="status">No Slack work items.</p>;
  const shown = rows.slice(0, LADDER_MAX_ROWS);
  return <div data-testid="slack-item-ladder">
    <table aria-label="Slack work items">
      <thead><tr><th>Thread</th><th>State</th><th>Owner</th><th>Evidence</th><th>As of</th></tr></thead>
      <tbody>{shown.map(r => <tr key={r.threadLabel}>
        <td>{r.threadLabel}</td>
        <td><span className={styles.healthBadge}>{r.state}</span></td>
        <td>{r.owner}</td><td>{r.evidence}</td>
        <td><time dateTime={r.asOf}>{formatRelative(r.asOf, nowMs)}</time>{r.stale ? ' stale' : ''}</td>
      </tr>)}</tbody>
    </table>
    {rows.length > shown.length && <p className={styles.message}>+{rows.length - shown.length} more</p>}
    {!returnsKnown && <p className={styles.message}>Returns: unknown, so no row is shown as VERIFIED.</p>}
  </div>;
}
