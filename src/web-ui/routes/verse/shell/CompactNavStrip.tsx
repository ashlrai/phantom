/**
 * routes/verse/shell/CompactNavStrip.tsx — the narrow-window top strip: Leader,
 * Feed, Needs you (with its count) and Fleet, one tap each. Plain buttons, so
 * Tab reaches them and Enter/Space activate; the current one carries
 * aria-current.
 */
import styles from './CompactNavStrip.module.css';

export type CompactNavId = 'leader' | 'feed' | 'needs-you' | 'fleet';

const ITEMS: readonly { id: CompactNavId; label: string }[] = [
  { id: 'leader', label: 'Leader' },
  { id: 'feed', label: 'Feed' },
  { id: 'needs-you', label: 'Needs you' },
  { id: 'fleet', label: 'Fleet' },
];

export interface CompactNavStripProps {
  /** The item whose view is showing; null when none of the four is. */
  active: CompactNavId | null;
  needsYouCount: number | null;
  onSelect: (id: CompactNavId) => void;
}

export function CompactNavStrip({ active, needsYouCount, onSelect }: CompactNavStripProps) {
  return (
    <nav className={styles.strip} aria-label="Home views">
      {ITEMS.map((item) => {
        const count = item.id === 'needs-you' && needsYouCount ? needsYouCount : null;
        return (
          <button key={item.id} type="button" className={styles.item}
            aria-current={active === item.id ? 'page' : undefined} onClick={() => onSelect(item.id)}>
            {item.label}
            {count !== null ? <span className={styles.count} aria-label={`${count} waiting`}>{count}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
