import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { dropQueueCard } from './drop-queue-model.js';
import { dropQueueQuery } from './drop-queue-queries.js';
import { dropFateQuery } from './drop-fate-query.js';
import { fateRows } from './drop-fate-model.js';
import styles from './fleet-host.module.css';

export function DropQueueCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(dropQueueQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 0 });
  const refetch = useRefetch(dropQueueQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  const fates = useQuery(dropFateQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 0 });
  const refetchFates = useRefetch(dropFateQuery);
  usePollWhileVisible(refetchFates, 30_000, { enabled: visible, refreshOnShow: false });
  const recent = fateRows(fates.data, Date.now());
  const card = dropQueueCard(read.data, Date.now());
  if (!card) return null;
  return <section className={styles.section} aria-label="Drop queue">
    <h3 className={styles.title}>Drop queue</h3>
    {read.status === 'error' ? <p className={styles.muted} role="status">Drop queue could not refresh. Showing the last reading.</p> : null}
    <p className={styles.metric} data-tone={card.tone}>{card.headline}</p>
    {card.verdict ? <p className={styles.line} role="status">{card.verdict}</p> : null}
    {card.rows.length ? <ul>{card.rows.map((row) => <li className={styles.line} key={row.id}>RQ-PHX-{row.id} · {row.laneTier} · {row.title} · {row.age}</li>)}</ul> : null}
    {recent ? <div aria-label="Recent fates">
      <h4>Recent fates</h4>
      <p className={styles.muted}>{recent.summary}</p>
      <ul>{recent.rows.map(row => <li key={row.id} className={styles.line} data-tone={row.tone}>{row.text}</li>)}</ul>
    </div> : null}
  </section>;
}
