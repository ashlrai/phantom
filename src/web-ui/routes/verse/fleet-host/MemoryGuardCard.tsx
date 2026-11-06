import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { memoryGuardCard } from './memory-guard-model.js';
import { memoryGuardQuery } from './memory-guard-query.js';
import styles from './fleet-host.module.css';

export function MemoryGuardCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(memoryGuardQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 0 });
  const refetch = useRefetch(memoryGuardQuery);
  usePollWhileVisible(refetch, 5_000, { enabled: visible, refreshOnShow: false });
  const card = memoryGuardCard(read.data?.memory);
  if (!card) return null;
  return <section className={styles.section} aria-label="Memory guard">
    <h3 className={styles.title}>Memory guard</h3>
    {read.status === 'error' ? <p className={styles.muted} role="status">Memory guard could not refresh. Showing the last reading.</p> : null}
    {card.staleText ? <p className={styles.banner} role="status">{card.staleText}</p> : null}
    <p className={styles.metric} data-tone={card.tone}>{card.lines[0]}</p>
    <ul>{card.lines.slice(1).map((line) => <li className={styles.line} key={line}>{line}</li>)}</ul>
    {card.stoppedJobs === null ? <p className={styles.muted}>Stopped workers: unknown</p>
      : card.stoppedJobs.length === 0 ? <p className={styles.muted}>Stopped workers: none</p>
      : <ul aria-label="Stopped workers">{card.stoppedJobs.map((id) =>
        <li className={styles.line} data-tone="warn" key={id}>{id}</li>)}</ul>}
  </section>;
}
