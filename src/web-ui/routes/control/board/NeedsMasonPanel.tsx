/**
 * routes/control/board/NeedsMasonPanel.tsx — the items the fleet is
 * blocked on Mason for (NEEDS-MASON.md, already scrubbed when recorded).
 * The source-state line is honest about 'missing' (no file yet) and
 * 'unavailable' (unreadable) — neither renders as an empty list implying
 * nothing is needed.
 */
import type { FleetBoardV1 } from '../../../data/api-types.js';
import styles from './NeedsMasonPanel.module.css';

type NeedsMason = FleetBoardV1['needsMason'];

export function NeedsMasonPanel({ needsMason }: { needsMason: NeedsMason }) {
  if (needsMason.status === 'missing') {
    return <p className={styles.note}>NEEDS-MASON.md not found — nothing has been recorded as needing Mason.</p>;
  }
  if (needsMason.status === 'unavailable') {
    return <p className={styles.note}>The needs-Mason file could not be read — open items may exist.</p>;
  }
  if (needsMason.items.length === 0) {
    return <p className={styles.empty}>Nothing needs Mason right now.</p>;
  }
  return (
    <ul className={styles.items}>
      {needsMason.items.map((item) => (
        <li key={item.id} className={styles.item} data-focus-key={`needs-${item.id}`} tabIndex={-1}>
          <span className={styles.id}>{item.id}</span>
          <span className={styles.text}>{item.text}</span>
        </li>
      ))}
    </ul>
  );
}
