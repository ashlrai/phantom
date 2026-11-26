/**
 * routes/verse/shell/CompactNavStrip.tsx — the narrow-window top strip: Home, Leader,
 * Feed, Needs you (with its count) and Fleet, one tap each; Leader and Feed
 * carry unread chips: Feed derives its badge from shared queries. Plain buttons, so Tab reaches them and Enter/Space activate; the current one carries
 * aria-current.
 */
import { lazy, Suspense } from 'react';
import type { HomeChoice } from './home-view.js';
import styles from './CompactNavStrip.module.css';
import { unreadLabel, type UnreadCounts } from './unread-counts.js';

/** The badge derives the whole feed from ten queries; it loads after first paint. */
const FeedNavBadge = lazy(() => import('../feed/FeedNavBadge.js').then((m) => ({ default: m.FeedNavBadge })));

export type CompactNavId = HomeChoice | 'needs-you' | 'fleet';

const ITEMS: readonly { id: CompactNavId; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'leader', label: 'Leader' },
  { id: 'feed', label: 'Feed' },
  { id: 'ideas', label: 'Ideas' },
  { id: 'goals', label: 'Goals' },
  { id: 'library', label: 'Library' },
  { id: 'needs-you', label: 'Needs you' },
  { id: 'fleet', label: 'Fleet' },
];

export interface CompactNavStripProps {
  /** The item whose view is showing; null when none of the views is. */
  active: CompactNavId | null;
  needsYouCount: number | null;
  /** Leader lines since last seen; Feed owns its shared-query unread count. */
  unread?: UnreadCounts;
  onSelect: (id: CompactNavId) => void;
}

export function CompactNavStrip({ active, needsYouCount, unread, onSelect }: CompactNavStripProps) {
  return (
    <nav className={styles.strip} aria-label="Home views">
      {ITEMS.map((item) => {
        const count = item.id === 'needs-you' && needsYouCount ? needsYouCount : null;
        const fresh = item.id === 'leader' && active !== item.id ? unread?.leader ?? 0 : 0;
        return (
          <button key={item.id} type="button" className={styles.item}
            aria-current={active === item.id ? 'page' : undefined} onClick={() => onSelect(item.id)}>
            {item.label}
            {item.id === 'feed' ? <Suspense fallback={null}><FeedNavBadge /></Suspense> : null}
            {count !== null ? <span className={styles.count} aria-label={`${count} waiting`}>{count}</span> : null}
            {fresh ? <span className={styles.count} aria-label={`${fresh} new`}>{unreadLabel(fresh)}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
