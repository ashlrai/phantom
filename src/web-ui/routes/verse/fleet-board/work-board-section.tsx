/**
 * routes/verse/fleet-board/work-board-section.tsx — the shared coordination
 * work board inside the existing Fleet Board pane (RQ-PHX-WORKBOARDPANE318).
 *
 * Reads GET /api/fleet/work-board (the `ashlr fleet work-board --json` shape).
 * Independent of leader-board.json: it renders even when the Leader board is
 * missing. Honest states only — an unreadable inbox or an undeployed route is
 * a printed note, never an empty table or a row of fake zeros. All data is
 * rendered as plain text.
 */
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './fleet-board.module.css';

type WorkState = 'RECEIVED' | 'ASSIGNED' | 'RUNNING' | 'BLOCKED' | 'VERIFIED';

interface WorkBoardItemView {
  id: string;
  channel: string;
  channelRef: string | null;
  receivedAt: string;
  state: WorkState;
  /** Absent on older servers; only a non-empty string counts (see textOrNull). */
  owner?: string | null;
  claimReceipt?: string | null;
  asOf: string;
  source: string;
  missing: string[];
}

interface WorkBoardResponse {
  items: WorkBoardItemView[];
  inbox: 'ok' | 'unavailable';
  truncated: boolean;
  asOf: string;
}

const STATES: readonly WorkState[] = ['RECEIVED', 'ASSIGNED', 'RUNNING', 'BLOCKED', 'VERIFIED'];
const LIMIT = 20;

export const workBoardQuery: QueryDef<WorkBoardResponse> = {
  key: 'fleet-work-board',
  fetch: (signal) => apiGet<WorkBoardResponse>(`/api/fleet/work-board?limit=${LIMIT}`, signal),
};

const OWNED_STATES: readonly WorkState[] = ['ASSIGNED', 'RUNNING', 'VERIFIED'];
const RECEIPT_SHORT = 24;

/** Only a non-empty string is a value; anything else (missing, number, object) is null. */
function textOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function ownerLabel(item: WorkBoardItemView): string {
  const owner = textOrNull(item.owner);
  if (owner !== null) return owner;
  // Nov12 contract: a state that implies an owner but has none must be visible.
  return OWNED_STATES.includes(item.state) ? 'owner missing' : 'unassigned';
}

function formatItemAge(receivedAt: string, now: number): string {
  const t = Date.parse(receivedAt);
  if (!Number.isFinite(t)) return 'unknown';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function WorkBoardSection({ visible }: { visible: boolean }) {
  const query = useQuery(workBoardQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(workBoardQuery);
  usePollWhileVisible(refetch, 15_000, { enabled: visible });

  const data = query.data;
  let body;
  if (data === undefined || (data.inbox !== 'unavailable' && !Array.isArray(data.items))) {
    // No usable payload (route missing, network error, or a body that is not a work board).
    body = query.status === 'error' || data !== undefined
      ? <p className={styles.note}>Work board not available on this Phantom build.</p>
      : <p className={styles.note}>Loading work items…</p>;
  } else if (data.inbox === 'unavailable') {
    body = <p className={styles.note}>Work board unreadable: the bus inbox could not be read.</p>;
  } else {
    const now = Date.now();
    body = (
      <>
        <ul className={styles.workCounts}>
          {STATES.map((state) => (
            <li key={state} className={styles.workCount}>
              <span>{state}</span>
              <span className={styles.numeric}>{data.items.filter((i) => i.state === state).length}</span>
            </li>
          ))}
        </ul>
        {data.items.length > 0 ? (
          <p className={styles.note}>
            {data.items.filter((i) => textOrNull(i.owner) !== null).length} of {data.items.length} items have a named owner
          </p>
        ) : null}
        {data.items.length > 0 ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">State</th><th scope="col">Id</th>
                <th scope="col">Owner</th><th scope="col">Claim</th><th scope="col">Channel</th>
                <th scope="col">Ref</th><th scope="col">Age</th><th scope="col">Missing</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => {
                const receipt = textOrNull(item.claimReceipt);
                return (
                <tr key={item.id}>
                  <td><span className={styles.workChip} data-state={item.state}>{item.state}</span></td>
                  <td className={styles.mono} title={item.id}>{item.id.slice(0, 12)}</td>
                  <td>{ownerLabel(item)}</td>
                  <td className={styles.mono} title={receipt ?? undefined}>{receipt === null ? 'none' : receipt.slice(0, RECEIPT_SHORT)}</td>
                  <td>{item.channel}</td>
                  <td className={styles.mono}>{item.channelRef ?? 'none'}</td>
                  <td className={styles.numeric}>{formatItemAge(item.receivedAt, now)}</td>
                  <td>{item.state === 'VERIFIED' ? '' : item.missing.join(', ')}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
        {data.truncated ? <p className={styles.note}>showing newest {LIMIT}</p> : null}
      </>
    );
  }

  return (
    <section className={styles.section} aria-labelledby="fb-work">
      <h3 id="fb-work" className={styles.sectionTitle}>Work items</h3>
      {body}
    </section>
  );
}
