/**
 * The Merges pane's lane throughput: which lane shipped the last 24 hours' merges. One row per lane, most merged
 * first, with a bar of its count against the busiest lane and its merge rate beside it. A row opens that lane in the
 * Lanes pane, where its target, pause and hold live. Built only on the lane rows of the fleet runs read; the counts
 * are each lane's own. A lane with no recorded count gets a hatched bar and the word unknown, never an empty bar.
 */
import { providerFor } from '../../../../core/fleet/provider.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import type { Lane } from './fleet-merges-model.js';
import styles from './lane-throughput.module.css';

export interface LaneThroughputRow extends Lane {
  /** Bar width against the busiest lane. null when the lane's count is unknown. */
  fillPct: number | null;
  /** This lane's share of the merges the known lanes report. null when unknown or when nothing merged. */
  sharePct: number | null;
}
export interface LaneThroughputView { rows: LaneThroughputRow[]; total: number | null; known: number; unknown: number }

/** Rows keep the order they arrive in (the model sorts most merged first, unknown last). */
export function laneThroughput(lanes: readonly Lane[]): LaneThroughputView {
  const counts = lanes.flatMap(lane => lane.merged24h === null ? [] : [lane.merged24h]);
  const top = Math.max(0, ...counts);
  const total = counts.length === 0 ? null : counts.reduce((sum, n) => sum + n, 0);
  const rows = lanes.map(lane => ({
    ...lane,
    fillPct: lane.merged24h === null ? null : top > 0 ? (lane.merged24h / top) * 100 : 0,
    sharePct: lane.merged24h === null || !total ? null : Math.round((lane.merged24h / total) * 100),
  }));
  return { rows, total, known: counts.length, unknown: lanes.length - counts.length };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** One plain line over the bars. Lanes with no count are named as unknown, never added in as zero. */
export function laneThroughputHeadline(view: LaneThroughputView): string {
  const unknown = view.unknown > 0 ? `${plural(view.unknown, 'lane')} unknown` : null;
  if (view.total === null) return 'Merges unknown for every lane.';
  const known = view.total === 0 ? `Nothing merged across ${plural(view.known, 'lane')}` : `${view.total} merged across ${plural(view.known, 'lane')}`;
  return `${[known, unknown].filter(Boolean).join(' · ')}.`;
}

function rateText(row: LaneThroughputRow): string {
  if (row.mergeRate24h === null) return 'merge rate unknown';
  // No merges and a zero rate says nothing about the lane's jobs.
  if (row.merged24h === 0 && row.mergeRate24h === 0) return '—';
  return `${row.mergeRate24h.toFixed(1)}% merge rate`;
}

function barLabel(row: LaneThroughputRow, total: number | null): string {
  if (row.merged24h === null) return `${row.lane}: merges unknown`;
  return `${row.lane}: ${row.merged24h} merged in 24 hours${row.sharePct === null || total === null ? '' : `, ${row.sharePct}% of ${total}`}`;
}

export function LaneThroughput({ lanes, onOpenLane }: { lanes: readonly Lane[]; onOpenLane: (lane: string) => void }) {
  const view = laneThroughput(lanes);
  return <section aria-labelledby="fleet-merges-lane-throughput">
    <h3 id="fleet-merges-lane-throughput" className={styles.heading}>Lane throughput · 24 h</h3>
    {view.rows.length === 0 ? <p className={styles.message}>No lane throughput reported.</p> : <>
      <p className={styles.message}>{laneThroughputHeadline(view)}</p>
      <ul className={styles.list} aria-label="Lane throughput">{view.rows.map((row, index) => <li key={`${row.lane}:${index}`}>
        <button type="button" className={styles.lane} aria-label={`Open ${row.lane} in Lanes`} onClick={() => onOpenLane(row.lane)}>
          <span className={styles.top}>
            <span className={styles.name}>
              {providerFor(row.lane).name !== 'unknown' && <ProviderBadge of={row.lane} iconOnly size={14} />}
              <span>{row.lane}</span>
            </span>{' '}
            <span className={styles.facts} data-unknown={row.merged24h === null || undefined}>
              {row.merged24h === null ? 'merges unknown' : `${row.merged24h} merged`} · {rateText(row)}
            </span>
          </span>
          <span className={styles.track} data-unknown={row.fillPct === null || undefined} role="img" aria-label={barLabel(row, view.total)}>
            {row.fillPct === null ? null : <span className={styles.fill} style={{ width: `${row.fillPct}%` }} />}
          </span>
        </button>
      </li>)}</ul>
      <p className={styles.message}>Bar: merged in 24 hours against the busiest lane. Select a lane to open it in Lanes.</p>
    </>}
  </section>;
}
