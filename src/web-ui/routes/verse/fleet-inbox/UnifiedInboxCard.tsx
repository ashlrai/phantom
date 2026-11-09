import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { CopyPill } from '../apps/CopyPill.js';
import { UNIFIED_INBOX_COMMAND, UNIFIED_INBOX_PATH, itemLine, readUnifiedInboxView, sourceSummary } from './unified-inbox-model.js';
import styles from './fleet-inbox.module.css';

const unifiedInboxQuery: QueryDef<unknown> = { key: 'verse-fleet-comms-unified-inbox', fetch: s => apiGet(UNIFIED_INBOX_PATH, s) };
const MAX_SHOWN = 8;

export function UnifiedInboxCard({ visible }: { visible: boolean }) {
  const inbox = useQuery(unifiedInboxQuery, { enabled: visible });
  const refetch = useRefetch(unifiedInboxQuery);
  usePollWhileVisible(refetch, 15_000, { enabled: visible });
  // Pane tests stub useQuery by key and return undefined for keys they do not know.
  const view = !inbox || inbox.error ? null : readUnifiedInboxView(inbox.data);
  if (view === null) return null;
  if (view.unavailable) return <p className={styles.meta}>Unified inbox unavailable</p>;
  const now = Date.now();
  const shown = view.items.slice(0, MAX_SHOWN);
  const more = view.total - shown.length;
  const allHealthy = Object.values(view.sources).every(s => s !== null && s.state === 'healthy');
  return <section className={styles.cos} aria-label="Unified inbox">
    <h3 className={styles.day}>Waiting</h3>
    <p className={styles.meta}>{sourceSummary(view.sources)}</p>
    {shown.length === 0 && allHealthy && <p className={styles.meta}>Nothing waiting</p>}
    {shown.map(item => {
      const line = itemLine(item, now);
      return <div key={item.id} className={styles.unifiedItem} data-severity={item.severity}>
        <span className={styles.meta}>{line.label}</span>
        <span className={styles.unifiedTitle}>{item.title}</span>
        {line.age !== null && <span className={styles.meta}>{line.age}</span>}
        {item.blocking && <span className={styles.meta}>blocking</span>}
        {item.act[0] !== undefined && <CopyPill text={item.act[0]} what="the command for this item" />}
      </div>;
    })}
    {more > 0 && <p className={styles.meta}>+{more} more</p>}
    <p className={styles.meta}><CopyPill text={UNIFIED_INBOX_COMMAND} what="the full inbox command" /></p>
  </section>;
}
