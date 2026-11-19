/**
 * The Queue pane's depth chart: one bar per lane of its ready jobs against its live slots, deepest first, under one
 * bar for the whole queue. Each track runs 0x to 4x the slots with ticks at the 1x and 3x bounds the depth line names,
 * so a thin or deep pile shows without reading a number. The words beside each bar carry the same reading; colour and
 * length only repeat it. A lane with no slot reading gets a hatched track, and a held or zero-target lane gets none,
 * so a missing number never looks like an empty queue. Select a lane to open it in Lanes.
 *
 * Read-only. It shares the Queue pane's cached reads (queue, fleet snapshot, lane holds) and leaves polling to the pane.
 */
import { useQuery } from '../../../data/hooks.js';
import { fleetSupplyQuery } from '../fleet-supply/fleet-supply-queries.js';
import { laneSupply } from '../fleet-supply/supply-model.js';
import { opsQueueQuery } from '../ops/ops-queue-queries.js';
import { DEPTH_SCALE_MAX, DEPTH_TICKS, laneDepthRows, wholeDepthRow, type DepthBarModel, type DepthRow } from './depth-bar-model.js';
import { laneHoldsQuery } from './queue-holds-model.js';
import styles from './queue-depth.module.css';

/** The bar alone. Its row already says the reading in words, so the drawing is hidden from assistive technology. */
function Bar({ bar }: { bar: DepthBarModel }) {
  const drawn = bar.state === 'measured' || bar.state === 'unknown';
  return <span className={styles.bar} aria-hidden="true">
    {drawn && <span className={styles.track}>{bar.state === 'measured' && <span className={styles.fill} style={{ width: `${bar.fillPercent}%` }} />}</span>}
    {bar.state === 'measured' && DEPTH_TICKS.map(tick => <span key={tick} className={styles.tick} style={{ insetInlineStart: `${(tick / DEPTH_SCALE_MAX) * 100}%` }} />)}
  </span>;
}

function Cells({ row }: { row: DepthRow }) {
  return <>
    <span className={styles.lane}>{row.lane}</span>
    <Bar bar={row.bar} />
    <span className={styles.caption}>{row.ready} ready · {row.bar.caption}</span>
  </>;
}

const marks = (bar: DepthBarModel) => ({ 'data-state': bar.state, 'data-bounds': bar.bounds ?? undefined, 'data-over': bar.over || undefined });

export function QueueDepthChart({ visible, onOpenLane }: { visible: boolean; onOpenLane: (lane: string) => void }) {
  const queue = useQuery(opsQueueQuery, { enabled: visible });
  const supply = useQuery(fleetSupplyQuery, { enabled: visible });
  const holds = useQuery(laneHoldsQuery, { enabled: visible });
  const data = queue.data;
  // Before the first read, on a build without the queue, or with no lanes, the pane's own message stands alone.
  if (!data || data.byLane.length === 0) return null;
  const lanes = laneSupply(supply.data);
  const whole = wholeDepthRow(data.ready, lanes);
  return <section className={styles.root} aria-label="Depth by lane">
    <h3 className={styles.heading}>Depth by lane</h3>
    <p className={styles.key}>Ready jobs against live slots, from 0x to {DEPTH_SCALE_MAX}x. The ticks mark {DEPTH_TICKS[0]}x and {DEPTH_TICKS[1]}x.</p>
    {/* A failed refresh keeps the last slot reading on screen; it must not read as current. */}
    {supply.status === 'error' && lanes.length > 0 && <p className={styles.stale} role="status">Live slots could not refresh. The bars use the last reading.</p>}
    <div className={`${styles.row} ${styles.whole}`} {...marks(whole.bar)}><Cells row={whole} /></div>
    <ul className={styles.rows}>{laneDepthRows(data.byLane, lanes, holds.data).map(row => <li key={row.lane} {...marks(row.bar)}>
      <button type="button" className={styles.row} aria-label={`Open ${row.lane} in Lanes: ${row.ready} ready, ${row.bar.caption}`} onClick={() => onOpenLane(row.lane)}><Cells row={row} /></button>
    </li>)}</ul>
  </section>;
}
