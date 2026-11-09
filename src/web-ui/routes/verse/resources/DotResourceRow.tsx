import { apiGet } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { COMMS_STATUS_PATH, readCommsStatus } from '../fleet-inbox/comms-status-model.js';
import { DOT_NO_READING, dotResourceRow } from './dot-resource-row.js';
import styles from '../SidebarResources.module.css';

// Same key and endpoint as the Comms status card, so the two share one cache entry.
const commsStatusQuery: QueryDef<unknown> = { key: 'verse-fleet-comms-status', fetch: s => apiGet(COMMS_STATUS_PATH, s) };

/** One read-only row: Dot runs Astra 6 on its own usage, apart from plan usage. */
export function DotResourceRow() {
  const reading = useQuery(commsStatusQuery, { freshMs: 30_000 });
  const status = !reading || reading.error ? null : readCommsStatus(reading.data);
  const row = dotResourceRow(status, Date.now());
  const median = row.medianReplyMinutes === null ? DOT_NO_READING : `${row.medianReplyMinutes} min`;
  return (
    <div className={styles.dotRow} data-state={row.state} title={`Median reply time: ${median}. ${row.source}.`}>
      <span className={styles.dotLabel}>{row.label}</span>
      <span className={styles.note}>{row.model} · own usage</span>
      <span className={styles.note}>
        {row.state === 'unknown' ? DOT_NO_READING : `Last reply ${row.lastReplyAgo}`}
        {row.waitingCount !== null && row.waitingCount > 0 ? ` · ${row.waitingCount} waiting` : ''}
      </span>
    </div>
  );
}
