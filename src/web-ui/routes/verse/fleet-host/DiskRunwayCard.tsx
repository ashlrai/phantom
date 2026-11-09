import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { diskRunwayDetail, diskRunwayLine } from './disk-runway-model.js';
import { diskRunwayQuery } from './disk-runway-query.js';
import styles from './fleet-host.module.css';

export function DiskRunwayCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(diskRunwayQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 30_000 });
  const refetch = useRefetch(diskRunwayQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  if (read.data === null) return null;
  const line = read.data && read.status !== 'error' ? diskRunwayLine(read.data) : { text: 'Disk runway: no reading.', tone: 'muted' };
  const detail = read.data && read.status !== 'error' ? diskRunwayDetail(read.data) : null;
  return <section className={styles.section} aria-label="Disk runway">
    <h3 className={styles.title}>Disk runway</h3>
    <p className={line.tone === 'muted' ? styles.muted : styles.line} data-tone={line.tone} role="status">{line.text}</p>
    {detail ? <p className={styles.muted}>{detail}</p> : null}
  </section>;
}
