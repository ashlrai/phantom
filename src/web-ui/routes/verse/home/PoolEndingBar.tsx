/** The bar on a pool tile's bottom edge: used so far (solid), what the measured burn uses before the reset (lighter), and the gap left unused at the reset.
 *  A pool that runs dry early fills to the end in amber; a pool with no usage reading is hatched, never empty. Read aloud as one meter. */
import type { EndingSummary, PoolEnding } from './pool-ending-model.js';
import styles from './pool-ending.module.css';

export function PoolEndingBar({ name, ending }: { name: string; ending: PoolEnding }) {
  return <div className={styles.track} role="meter" aria-label={`${name} used`} aria-valuemin={0} aria-valuemax={100}
    aria-valuenow={ending.used === null ? undefined : Math.round(ending.used)} aria-valuetext={ending.meter} data-ending={ending.kind}>
    {ending.used !== null && ending.used > 0 ? <span className={styles.used} style={{ width: `${ending.used}%` }} /> : null}
    {ending.more !== null && ending.more > 0 ? <span className={styles.more} data-more style={{ width: `${ending.more}%` }} /> : null}
  </div>;
}

/** The count sentence, and beside it what the three parts of a bar mean (only when some pool is projected). */
export function PoolEndingKey({ summary }: { summary: EndingSummary }) {
  return <p className={styles.key} data-ending-key>
    <span>{summary.text}</span>
    {summary.projected ? <span className={styles.parts}>
      <span><i className={styles.swatch} data-part="used" />used so far</span>
      <span><i className={styles.swatch} data-part="more" />more by its reset</span>
      <span><i className={styles.swatch} data-part="unused" />unused at its reset</span>
    </span> : null}
  </p>;
}
