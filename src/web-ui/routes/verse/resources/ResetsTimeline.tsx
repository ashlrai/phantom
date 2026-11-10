import { resetsTimeline, type ResetReading } from './resets-timeline.js';
import styles from './ResourcesDrawer.module.css';

export function ResetsTimeline({ readings, nowMs }: { readings: ResetReading[]; nowMs: number }) {
  const { rows, noReading } = resetsTimeline(readings, nowMs);
  if (readings.length === 0) return null;
  return (
    <section className={styles.group} aria-label="Resets">
      <h4 className={styles.groupTitle}>Resets</h4>
      <ul className={styles.cards}>
        {rows.map((row, index) => (
          <li key={`${row.label}-${index}`}>
            {row.label} · resets <time dateTime={row.resetAt}>{new Date(row.resetAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</time>
            {' '}(in {Math.ceil(row.hoursLeft)}h) · {row.percentLeft === null ? 'left: unknown' : `${row.percentLeft}% left`}
            {row.useIt ? ' · use it' : null}
          </li>
        ))}
      </ul>
      {noReading.length ? <p className={styles.subtle}>No reset reading: {noReading.join(', ')}</p> : null}
    </section>
  );
}
