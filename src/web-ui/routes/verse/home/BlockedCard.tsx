/**
 * Home's Blocked card: what is stopping work right now, without opening Lanes or the old live view. One headline,
 * then why launches are paused, each repo hold with its reason and when it lifts, each lane whose jobs wait with
 * nothing running, and the parked count. Built only on reads other screens already make: the live fleet snapshot
 * (`/api/verse/fleet/live`) and the Lanes pane's launch-stall view. Read-only. A reading that could not be made is
 * named as unknown; it never reads as "nothing blocked".
 */
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { requestLaneFocus } from '../fleet-lanes/lane-focus-request.js';
import { isLaunchStallViewV1, launchStallQuery } from '../fleet-lanes/launch-stall-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { blockedView, holdUntil, liveOf } from './blocked-model.js';
import styles from './blocked.module.css';
import home from './home.module.css';

export const BLOCKED_LIVE_PATH = '/api/verse/fleet/live';
export const blockedLiveQuery: QueryDef<FleetLiveSnapshotV1> = { key: 'home-blocked-live', fetch: signal => apiGet(BLOCKED_LIVE_PATH, signal) };
/** Where the card's rows and its one action lead: the pane that steers lanes. */
export const BLOCKED_PANE_ID = 'fleet-lanes';
// A hold or a stall lasts minutes; the Lanes banner reads the stall on the same cadence.
const POLL_MS = 30_000;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** `open` opens a dock pane by id (Home's own opener); a lane row asks Lanes to show that lane first. */
export function BlockedCard({ visible = true, open }: { visible?: boolean; open: (paneId: string) => void }) {
  const liveRead = useQuery(blockedLiveQuery, { enabled: visible, freshMs: 0 });
  const stallRead = useQuery(launchStallQuery, { enabled: visible, freshMs: 0 });
  const refreshLive = useRefetch(blockedLiveQuery);
  const refreshStall = useRefetch(launchStallQuery);
  usePollWhileVisible(refreshLive, POLL_MS, { enabled: visible });
  usePollWhileVisible(refreshStall, POLL_MS, { enabled: visible, refreshOnShow: false });
  const live = liveOf(liveRead.data);
  const stall = isLaunchStallViewV1(stallRead.data) ? stallRead.data : null;
  const liveFailed = Boolean(liveRead.error) || liveRead.status === 'error';
  const stallFailed = Boolean(stallRead.error) || stallRead.status === 'error';
  // Both reads must settle first: half an answer could say "nothing is blocked" a moment before the other half disagrees.
  if ((liveRead.data === undefined && !liveFailed) || (stallRead.data === undefined && !stallFailed)) return null;
  // Any other payload (an older server) hides the card rather than claim a clear fleet.
  if (!live && !stall && !liveFailed && !stallFailed) return null;
  // The launch-stall read answers null when this build has no such route; only then is its absence not an unknown.
  const view = blockedView(live, stall, stallRead.data === null && !stallFailed);
  const stale = (liveFailed && live !== null) || (stallFailed && stall !== null);
  return <section className={home.card} aria-label="Blocked">
    <h3>Blocked</h3>
    {stale ? <p role="status" data-warn>Could not refresh. Showing the last reading, which may be stale.</p> : null}
    <p className={styles.headline} data-state={view.blocked ? 'blocked' : view.unknown.length ? 'unknown' : 'clear'}>{view.headline}</p>
    {(view.launch || view.stall) && <div className={styles.group} role="group" aria-label="Launches">
      {view.launch ? <p>{view.launch.line}</p> : null}
      {view.launch?.detail.map(line => <p key={line} className={styles.fact}>{line}</p>)}
      {view.stall ? <p>No job has launched for {view.stall.minutes} min. {view.stall.queued === 1 ? '1 job is' : `${view.stall.queued} jobs are`} queued.</p> : null}
    </div>}
    {view.holds.length > 0 && <ul className={styles.rows} aria-label="Repo holds">
      {view.holds.map((hold, index) => <li key={`${hold.repo} ${index}`} className={styles.row}>
        <span className={styles.top}><strong className={styles.name}>{hold.repo}</strong><span className={styles.when}>{holdUntil(hold.until)}</span></span>
        <span className={styles.said}>{hold.reason}</span>
      </li>)}
    </ul>}
    {view.lanes.length > 0 && <ul className={styles.rows} aria-label="Lanes with waiting jobs">
      {view.lanes.map(lane => <li key={lane.lane}>
        {/* Lane names come from the queue on disk: plain text only. */}
        <button type="button" className={styles.row} aria-label={`Show lane ${lane.lane}`} onClick={() => { requestLaneFocus(lane.lane); open(BLOCKED_PANE_ID); }}>
          <span className={styles.top}><strong className={styles.name}>{lane.lane}</strong><span className={styles.when}>oldest {lane.oldestMinutes} min</span></span>
          <span className={styles.said}>{plural(lane.waiting, 'job')} waiting with nothing running.</span>
        </button>
      </li>)}
    </ul>}
    {view.parked !== null && view.parked > 0 ? <p>Parked jobs: {view.parked}</p> : null}
    {view.unknown.map(line => <p key={line} data-unknown>{line}</p>)}
    <button type="button" className={home.action} onClick={() => open(BLOCKED_PANE_ID)}>Open Lanes</button>
  </section>;
}
