import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { requestLaneFocus } from './lane-focus-request.js';
import { launchStallQuery } from './launch-stall-queries.js';
import styles from './fleet-lanes.module.css';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Says why launches are blocked (disk guard, load gate, cap, stale dispatcher),
 * when the dispatcher has stopped launching queued work and which lanes hold
 * old jobs with nothing running. The reason shows even when the stall detector
 * has not fired: in disk reuse-only mode repair jobs keep launching while the
 * rest wait. Renders nothing while loading, on error, when the route has not
 * landed (404) or when nothing is stuck. Lane names and
 * job ids are untrusted: rendered as plain text only.
 */
export function LaunchStallBanner({ enabled }: { enabled: boolean }) {
  const read = useQuery(launchStallQuery, { enabled });
  const refetch = useRefetch(launchStallQuery);
  // Same cadence as stray slots: a stall is minutes long, 30 s is fresh enough.
  usePollWhileVisible(refetch, 30_000, { enabled, refreshOnShow: false });
  const view = read.data;
  if (!view) return null;
  const { stall, lanes } = view;
  const why = view.why && view.why.code !== 'none' ? view.why : null;
  const logUnreadable = view.source === 'unavailable' && stall === null;
  if (!why && !stall?.stalled && lanes.length === 0 && !logUnreadable) return null;
  return <div className={styles.section} role="status" aria-label="Launch stall">
    {why ? <p className={styles.headline}>{why.line}</p> : null}
    {why?.detail.map((line) => <p className={styles.muted} key={line}>{line}</p>)}
    {stall?.stalled && stall.minutes !== null && stall.lastQ !== null
      ? <p className={styles.headline}>No job has launched for {Math.round(stall.minutes)} min. {plural(stall.lastQ, 'job is', 'jobs are')} queued.</p>
      : null}
    {logUnreadable ? <p className={styles.muted}>Phantom can&apos;t read the dispatcher log on this computer.</p> : null}
    {lanes.map((group) => <p className={styles.muted} key={group.lane}>
      <button type="button" className={styles.jobButton} aria-label={`Show lane ${group.lane}`} onClick={() => requestLaneFocus(group.lane)}>
        {group.lane}: {plural(group.jobs.length, 'job', 'jobs')} waiting, oldest {Math.round(group.jobs[0]!.ageMinutes)} min
      </button>
    </p>)}
  </div>;
}
