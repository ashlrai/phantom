import { CopyPill } from '../apps/CopyPill.js';
import { cutoverHeadline, type CutoverState, type CutoverView } from './comms-cutover-model.js';
import styles from './fleet-inbox.module.css';

const RANK: Record<CutoverState, number> = { blocked: 0, unverified: 1, unsupported: 2, ready: 2 };

/** Read-only checklist: one row per capability, blocked first, a copyable next step on rows that are not ready. */
export function CommsCutoverList({ view }: { view: CutoverView }) {
  const rows = [...view.rows].sort((a, b) => RANK[a.state] - RANK[b.state]);
  return <div aria-label="Off Grok Bot cutover">
    <p className={styles.meta}>{cutoverHeadline(view)}</p>
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {rows.map(row => <li key={row.id} className={styles.unifiedItem} data-state={row.state}>
        <span className={styles.unifiedTitle}>{row.label}: {row.stateWord} <small className={styles.meta}>{row.reason}</small></span>
        {row.state !== 'ready' && <CopyPill text={row.nextStep} what={`the next step for ${row.label}`} />}
      </li>)}
    </ul>
  </div>;
}
