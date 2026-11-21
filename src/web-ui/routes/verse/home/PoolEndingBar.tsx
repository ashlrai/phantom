/** The bar on a pool tile's bottom edge: the design system's WindowBar at edge size, fed the tile's own ending. Used so far is solid, what the
 *  measured burn uses before the reset is lighter, and the gap after them is left unused at the reset. A pool that runs dry early fills to the
 *  end in amber; a pool with no usage reading is hatched, never empty. Read aloud as one meter. */
import { WindowBar, WindowBarSwatch } from '../../../components/primitives/WindowBar.js';
import type { EndingSummary, PoolEnding } from './pool-ending-model.js';
import styles from './pool-ending.module.css';

export function PoolEndingBar({ name, ending }: { name: string; ending: PoolEnding }) {
  return <WindowBar size="edge" label={`${name} used`} valueText={ending.meter} valueNow={ending.used} used={ending.used} more={ending.more} ending={ending.kind} />;
}

/** The count sentence, and beside it what the three parts of a bar mean (only when some pool is projected). */
export function PoolEndingKey({ summary }: { summary: EndingSummary }) {
  return <p className={styles.key} data-ending-key>
    <span>{summary.text}</span>
    {summary.projected ? <span className={styles.parts}>
      <span><WindowBarSwatch part="used" />used so far</span>
      <span><WindowBarSwatch part="more" />more by its reset</span>
      <span><WindowBarSwatch part="unused" />unused at its reset</span>
    </span> : null}
  </p>;
}
