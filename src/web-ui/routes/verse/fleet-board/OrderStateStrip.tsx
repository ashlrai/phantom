/**
 * routes/verse/fleet-board/OrderStateStrip.tsx — "Your orders": one read-only
 * row per order (time · source · state · as-of · missing evidence · PR link).
 * The strip writes nothing itself: "Follow up" on a RECEIVED, ASSIGNED or BLOCKED
 * row only opens the interject dialog with a prefill; the dialog owns the send.
 */
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { Button, SkeletonLine } from '../../../components/primitives/index.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { orderFollowUpEligible, orderFollowUpPrefill } from './order-follow-up.js';
import { MAX_ORDER_ROWS, orderRowView } from './order-state-model.js';
import { orderStateQuery } from './order-state-query.js';
import styles from './fleet-board.module.css';

export function OrderStateStrip({ visible = true }: { visible?: boolean }) {
  const orders = useQuery(orderStateQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(orderStateQuery);
  usePollWhileVisible(() => { refetch(); }, 15_000, { enabled: visible });

  const data = orders.data;
  let body;
  if (data === undefined && orders.status !== 'error') body = <SkeletonLine width="40%" />;
  else if (data === undefined || data.kind === 'unavailable') body = <p className={styles.orderNote}>Order states unavailable</p>;
  else if (data.rows.length === 0) body = <p className={styles.orderNote}>No orders in range</p>;
  else {
    const note = data.health?.notice ?? null;
    const unchecked = data.health?.liveChecked === false;
    body = (
      <>
      {note !== null ? <p className={styles.orderNote} role="status">{note}</p> : null}
      <ul className={styles.orderRows}>
        {data.rows.slice(0, MAX_ORDER_ROWS).map((row, i) => {
          const v = orderRowView(row);
          const followUp = orderFollowUpEligible(row) ? orderFollowUpPrefill(row) : null;
          return (
            <li key={`${v.key}|${i}`} className={styles.orderRow}>
              <span className={styles.mono}>{v.time}</span>
              <span>{v.source}</span>
              <span className={styles.orderState} data-state={v.state}>{v.state}</span>
              {v.blockerText !== null ? <span className={styles.orderNote}>{v.blockerText}</span> : null}
              <span>owner: {v.ownerText}</span>
              {unchecked && v.state === 'ASSIGNED' ? <span className={styles.orderNote}> (unchecked)</span> : null}
              <span>{v.asOfText}</span>
              <span>missing: {v.missingText}</span>
              {followUp !== null ? <Button size="sm" variant="subtle" aria-label={`Follow up on your ${v.time} order`} onClick={() => openInterjectDialog({ prefill: followUp })}>Follow up</Button> : null}
              {v.prUrl ? <a href={v.prUrl} target="_blank" rel="noreferrer noopener">{v.prLabel}</a> : null}
            </li>
          );
        })}
      </ul>
      </>
    );
  }
  return (
    <section className={styles.orderStrip} aria-label="Your orders">
      <h3 className={styles.sectionTitle}>Your orders</h3>
      {body}
    </section>
  );
}
