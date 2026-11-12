/**
 * routes/control/board/TierDepth.tsx — READY queue depth by router tier:
 * one proportional bar plus a chip per tier. Tier order follows the
 * router's own order (frontier, work, mid, fast — docs/QUEUE.md); any
 * recorded tier outside that list sorts after alphabetically, 'unknown'
 * always last and drawn in the neutral "Other" ink — colour follows the
 * tier, never its position (seriesColor's own rule).
 *
 * Honesty: `depth` is null when the recording tick could not read
 * ready.tsv — that renders a designed 'unknown' line, never an empty bar
 * implying zero.
 */
import { CHART_NEUTRAL, seriesColor } from '../../../components/charts/colors.js';
import styles from './TierDepth.module.css';

/** Router tier order (queuegen's `tier=` contract); unknown recorded tiers sort after. */
const TIER_ORDER: readonly string[] = ['frontier', 'work', 'mid', 'fast'];
/** Fixed identity slots for the known tiers — a re-order never repaints a tier. */
const TIER_SLOT: Readonly<Partial<Record<string, number>>> = { frontier: 0, work: 1, mid: 2, fast: 3 };

interface TierRow {
  tier: string;
  count: number;
  color: string;
}

export function orderTierDepth(depth: Record<string, number>): TierRow[] {
  const names = Object.keys(depth);
  const known = TIER_ORDER.filter((t) => names.includes(t));
  const extra = names.filter((t) => !TIER_ORDER.includes(t) && t !== 'unknown').sort((a, b) => a.localeCompare(b));
  const ordered = [...known, ...extra, ...(names.includes('unknown') ? ['unknown'] : [])];
  return ordered.map((tier, i) => ({
    tier,
    count: depth[tier] ?? 0,
    // Known tiers hold their fixed slots; recorded extras take slots 4+ by
    // name order (seriesColor folds past slot 5 into the neutral "Other").
    color: tier === 'unknown' ? CHART_NEUTRAL : seriesColor(TIER_SLOT[tier] ?? 4 + (i - known.length)),
  }));
}

export function TierDepth({ depth }: { depth: Record<string, number> | null }) {
  if (depth === null) {
    return <p className={styles.unknown}>Queue depth by tier: unknown — the recording tick could not read ready.tsv.</p>;
  }
  const rows = orderTierDepth(depth);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  if (rows.length === 0 || total === 0) {
    return <p className={styles.empty}>No READY rows recorded — the queue is empty.</p>;
  }
  return (
    <div className={styles.wrap}>
      <div
        className={styles.bar}
        role="img"
        aria-label={`Queue depth by tier: ${rows.map((r) => `${r.tier} ${r.count}`).join(', ')}.`}
      >
        {rows.map((row) =>
          row.count > 0 ? (
            <span
              key={row.tier}
              className={styles.segment}
              style={{ width: `${(row.count / total) * 100}%`, background: row.color }}
              title={`${row.tier}: ${row.count} ready`}
            />
          ) : null,
        )}
      </div>
      <ul className={styles.chips}>
        {rows.map((row) => (
          <li key={row.tier} className={styles.chip}>
            <span className={styles.dot} style={{ background: row.color }} aria-hidden="true" />
            <span className={styles.tier}>{row.tier}</span>
            <span className={styles.count}>{row.count}</span>
          </li>
        ))}
        <li className={`${styles.chip} ${styles.totalChip}`}>
          <span className={styles.tier}>total</span>
          <span className={styles.count}>{total}</span>
        </li>
      </ul>
    </div>
  );
}
