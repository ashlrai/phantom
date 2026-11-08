/**
 * routes/control/board/LanesTable.tsx — one row per lane the last Leader
 * tick counted: READY, parked and running depth, merges in the last hour,
 * and the oldest READY wait. Every cell is a recorded reading: a lane the
 * tick could not measure prints 'unknown', never 0.
 */
import type { FleetBoardLane } from '../../../data/api-types.js';
import styles from './LanesTable.module.css';

function cell(value: number | null): string {
  return value === null ? 'unknown' : String(value);
}

/** Whole seconds to a compact wait ("45s", "3m", "2h", "1d"); unknown stays unknown. */
export function formatWait(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'unknown';
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function LanesTable({ lanes }: { lanes: FleetBoardLane[] }) {
  if (lanes.length === 0) {
    return <p className={styles.empty}>No lanes observed by the last recorded tick.</p>;
  }
  const ordered = [...lanes].sort((a, b) => a.lane.localeCompare(b.lane));
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Lane</th>
            <th scope="col">Ready</th>
            <th scope="col">Parked</th>
            <th scope="col">Running</th>
            <th scope="col">Merges/h</th>
            <th scope="col">Oldest wait</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((lane) => (
            <tr key={lane.lane} data-focus-key={`lane-${lane.lane}`} tabIndex={-1}>
              <td className={styles.mono}>{lane.lane}</td>
              <td className={styles.numeric}>{cell(lane.ready)}</td>
              <td className={styles.numeric}>{cell(lane.parked)}</td>
              <td className={styles.numeric}>{cell(lane.running)}</td>
              <td className={styles.numeric}>{cell(lane.mergesLastHour)}</td>
              <td className={styles.numeric}>{formatWait(lane.oldestWaitSeconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
