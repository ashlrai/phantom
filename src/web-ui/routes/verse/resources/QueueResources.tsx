import type { AppResources } from '../../../../core/resources/app-resources.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { openResources } from './resources-store.js';
import styles from './ResourcesBar.module.css';

const query = { key: 'app-resources', fetch: (signal?: AbortSignal) => apiGet<AppResources>('/api/app/resources', signal) };
export function QueueResourceRows({ value, expanded = true }: { value?: AppResources; expanded?: boolean }) {
  return <div className={styles.bar} data-expanded={expanded || undefined} role="group" aria-label="Router resources">
    {value?.resources.map(row => {
      const usage = row.remainingPercent === null ? 'unknown' : `${row.remainingPercent}% left`;
      const detail = `${row.pool}: ${usage} · reset ${row.resetAt ?? 'unknown'} · live jobs ${row.liveJobs ?? 'unknown'}`;
      return <button key={row.pool} type="button" className={styles.row} title={detail} aria-label={detail} onClick={openResources}>
        {expanded ? <><span className={styles.name}>{row.pool}</span><span className={styles.value}>{usage} · live {row.liveJobs ?? 'unknown'}</span></> : <span className={styles.name}>{usage}</span>}
      </button>;
    })}
  </div>;
}
export function QueueResources({ expanded = true }: { expanded?: boolean }) {
  const read = useQuery(query, { freshMs: 30_000 });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 30_000);
  return read.error ? <p>Router usage unknown</p> : <QueueResourceRows value={read.data} expanded={expanded} />;
}
