/**
 * routes/verse/fleet-board/OrderStateStrip.tsx — "Your orders": one read-only
 * row per order (time · source · state · as-of · missing evidence · PR link).
 * No buttons, no writes.
 */
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
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
    body = (
      <ul className={styles.orderRows}>
        {data.rows.slice(0, MAX_ORDER_ROWS).map((row, i) => {
          const v = orderRowView(row);
          return (
            <li key={`${v.key}|${i}`} className={styles.orderRow}>
              <span className={styles.mono}>{v.time}</span>
              <span>{v.source}</span>
              <span className={styles.orderState} data-state={v.state}>{v.state}</span>
              <span>{v.asOfText}</span>
              <span>missing: {v.missingText}</span>
              {v.prUrl ? <a href={v.prUrl} target="_blank" rel="noreferrer noopener">{v.prLabel}</a> : null}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <section className={styles.orderStrip} aria-label="Your orders">
      <h3 className={styles.sectionTitle}>Your orders</h3>
      {body}
    </section>
  );
}
