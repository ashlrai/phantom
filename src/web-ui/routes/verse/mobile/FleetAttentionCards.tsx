import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { homeRunsQuery } from './home-runs-query.js';
import { fleetAttention } from './needs-fleet-model.js';
import { Badge, ui } from './ui-parts.js';
import { cx } from './ui.js';
import styles from './screens/NeedsYouScreen.module.css';

export function FleetAttentionCards({ nowMs = Date.now() }: { nowMs?: number }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const query = useQuery(homeRunsQuery, { enabled: sectionVisible && documentVisible });
  const refetch = useRefetch(homeRunsQuery);
  usePollWhileVisible(refetch, 15_000);
  const cards = fleetAttention(query.data ?? null, nowMs);
  if (cards.length === 0) return null;
  return (
    <section aria-label="Fleet attention">
      <ul className={styles.list}>
        {cards.map((card) => (
          <li key={card.id}>
            <article className={cx(ui.card, styles.card)}>
              <div className={styles.head}><Badge tone={card.severity === 'high' ? 'danger' : 'warning'}>Fleet</Badge></div>
              <h2 className={styles.title}>{card.title}</h2>
              <p className={styles.detail}>{card.detail}</p>
              <p className={styles.consequence}>{card.next}</p>
            </article>
          </li>
        ))}
      </ul>
    </section>
  );
}
