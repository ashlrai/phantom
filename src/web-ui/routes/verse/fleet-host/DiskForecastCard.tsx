import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { diskForecastCard } from './disk-forecast-model.js';
import { diskForecastQuery } from './disk-forecast-query.js';
import styles from './fleet-host.module.css';

export function DiskForecastCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(diskForecastQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 0 });
  const refetch = useRefetch(diskForecastQuery);
  usePollWhileVisible(refetch, 60_000, { enabled: visible, refreshOnShow: false });
  if (!read.data) return null;
  const card = diskForecastCard(read.data);
  return <section className={styles.section} aria-label="Disk forecast">
    <h3 className={styles.title}>Disk forecast</h3>
    {read.status === 'error' ? <p className={styles.muted} role="status">Disk forecast could not refresh. Showing the last reading.</p> : null}
    <p className={styles.metric} data-tone={card.tone}>{card.line}</p>
    <p className={styles.muted}>{card.caption}</p>
  </section>;
}
