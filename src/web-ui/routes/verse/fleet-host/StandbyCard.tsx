import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { standbySentence } from './standby-card-model.js';
import { standbyCardQuery } from './standby-card-query.js';
import styles from './fleet-host.module.css';

export function StandbyCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(standbyCardQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 30_000 });
  const refetch = useRefetch(standbyCardQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  if (read.data === null) return null;
  const line = read.data && read.status !== 'error' ? standbySentence(read.data) : { text: 'Second computer: no reading.', tone: 'muted' };
  return <section className={styles.section} aria-label="Second computer">
    <p className={line.tone === 'muted' ? styles.muted : styles.line} data-tone={line.tone} role="status">{line.text}</p>
  </section>;
}
