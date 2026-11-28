/**
 * routes/verse/fleet-lanes/LaneWork.tsx: when each lane worked. At the foot of a Lanes board card, the jobs launched
 * on that lane across the last 24 hours or 7 days as one row of bars, a mark under each bar that had a PR merged, and
 * the counts in words. It is the Models board's work line (models/ModelWork.tsx) drawn from the per-lane report, so
 * the two boards read the same way: every row is drawn against the busiest bar on the board, and pointing at a bar
 * (or Left / Right / Home / End on a focused row) holds that stretch of time on every lane card at once.
 *
 * The read is GET /api/verse/fleet/runs/throughput?by=lane, the JSON `phm throughput --by lane --json` prints, on the
 * cache entry Home's Merged PRs card and the Throughput pane already share. A lane the report has no group for did
 * nothing that was recorded (an empty line); a report that could not be read leaves every lane unknown (hatched).
 */
import { useState } from 'react';
import type { ThroughputReport } from '../../../../core/fleet/throughput.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { THROUGHPUT_QUERIES } from '../fleet-throughput/throughput-query.js';
import { throughputOf } from '../home/delivery-card-model.js';
import { ModelWorkLine, WorkSummary } from '../models/ModelWork.js';
import { WORK_WINDOWS, workBoard, type WorkBoard, type WorkWindow } from '../models/model-work-model.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './lane-work.module.css';

export interface LaneWorkState {
  board: WorkBoard;
  hours: WorkWindow;
  setHours: (next: WorkWindow) => void;
  /** The start of the one bar every lane card reads out; null when none is held. */
  cursor: string | null;
  setCursor: (start: string | null) => void;
  /** When the report on screen was read, if a refresh has failed since; null while it is current. */
  staleSince: string | null;
}

/** Only a per-lane throughput.v1 payload is a reading: any other body (an older server, an error page) is not "no work". */
export function laneReport(data: unknown): ThroughputReport | null {
  const report = throughputOf(data);
  return report && report.by === 'lane' ? report : null;
}

/** `read` gates the request (the pane is on screen and has its lanes); `poll` keeps it fresh once a minute while the pane is visible. */
export function useLaneWork(lanes: readonly string[], { read, poll }: { read: boolean; poll: boolean }): LaneWorkState {
  const [hours, setHoursState] = useState<WorkWindow>('24');
  const [cursor, setCursor] = useState<string | null>(null);
  const query = THROUGHPUT_QUERIES[hours];
  const result = useQuery(query, { enabled: read, freshMs: 60_000 });
  usePollWhileVisible(useRefetch(query), 60_000, { enabled: poll, refreshOnShow: false });
  const report = laneReport(result.data);
  // An answer that is not a report is as unread as a failed request; only no answer yet is "reading".
  const failed = result.status === 'error' || (report === null && result.data !== undefined);
  return {
    board: workBoard({ report, failed, hours: Number(hours), ids: lanes, by: 'lane' }),
    hours, cursor, setCursor,
    // The cursor is a bar of one window, so switching lets go.
    setHours: next => { setHoursState(next); setCursor(null); },
    staleSince: report && result.status === 'error' ? report.as_of : null,
  };
}

const timeOf = (stamp: string): string => {
  const at = new Date(stamp);
  return Number.isNaN(at.getTime()) ? 'an unknown time' : at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

/** Above the lane cards: the window switch, the fleet's sentence for the window (or the held bar), the key, and lanes the report names that have no card. */
export function LaneWorkHead({ work }: { work: LaneWorkState }) {
  const { board } = work;
  return <div className={styles.head} data-lane-work={board.state}>
    <div className={styles.top}>
      <span className={styles.label}>Work by the hour</span>
      <Segmented size="sm" aria-label="Work window" value={work.hours} onChange={work.setHours} options={WORK_WINDOWS} />
    </div>
    {/* Not a live region: the pane's one status is its own read and the result of an action on a lane. */}
    <WorkSummary board={board} cursor={work.cursor} announce={false} />
    {/* A failed refresh keeps the last bars on screen; they must not read as current. */}
    {work.staleSince ? <p className={styles.note} data-stale>The hourly record could not refresh. Showing the reading from {timeOf(work.staleSince)}.</p> : null}
    {board.strangers.length > 0 ? <ul className={styles.strangers} aria-label="Recorded under a lane with no card">
      {board.strangers.map(stranger => <li key={stranger.name}>
        <ProviderBadge of={stranger.name} iconOnly size={12} /><strong>{stranger.name}</strong><span>{stranger.words}, and no card on this board</span>
      </li>)}
    </ul> : null}
  </div>;
}

/** One lane card's work line. Nothing is drawn for a lane the board was not asked about. */
export function LaneWorkLine({ lane, work }: { lane: string; work: LaneWorkState }) {
  const did = work.board.works.get(lane);
  return did ? <ModelWorkLine work={did} board={work.board} cursor={work.cursor} onCursor={work.setCursor} /> : null;
}
