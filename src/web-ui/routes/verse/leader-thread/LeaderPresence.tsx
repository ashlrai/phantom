/**
 * The line under the Leader reply box: is the Leader reading, and when will it read what Mason just wrote. A
 * hairline fills across the pass interval, so the wait is visible before the words are read; it turns amber
 * when the pass is late and red when passes have stopped. Read-only. It rides the pane's own fleet runs read
 * (same cache key, the pane keeps it fresh), so it adds no request of its own.
 */
import { VERSE_FLEET_RUNS_PATH } from '../../../../core/verse/fleet-runs-types.js';
import { apiGet } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { useNow } from '../autonomy/use-ticker.js';
import { openDockPane } from '../dock/dock-store.js';
import { leaderPresence } from './leader-presence-model.js';
import styles from './leader-presence.module.css';

/** The pane's 'verse-fleet-runs' key, so both read one cache entry. */
const fleetRunsQuery: QueryDef<unknown> = { key: 'verse-fleet-runs', fetch: signal => apiGet<unknown>(VERSE_FLEET_RUNS_PATH, signal) };

export function LeaderPresence({ visible }: { visible: boolean }) {
  const runs = useQuery(fleetRunsQuery, { enabled: visible, freshMs: 5_000 });
  const now = useNow(10_000);
  // A failed refresh keeps the last good read; only a read that never answered is unknown.
  const view = leaderPresence(runs.data, runs.error !== undefined && runs.data === undefined, now);
  const behind = view.state === 'late' || view.state === 'stalled';
  return <section className={styles.presence} aria-label="Leader presence" data-state={view.state} aria-busy={view.state === 'reading' || undefined}>
    <div className={styles.meter} aria-hidden="true">
      {view.progress !== null ? <span className={styles.fill} style={{ inlineSize: `${Math.round(view.progress * 100)}%` }} /> : null}
    </div>
    <p className={styles.line}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.headline} title={view.lastPassIso ? `Last pass ${new Date(view.lastPassIso).toLocaleString('en-US')}` : undefined}>{view.headline}</span>
      {view.detail ? <span className={styles.detail} data-waiting={view.waiting ? 'true' : undefined}>{view.detail}</span> : null}
      {behind ? <button type="button" className={styles.open} onClick={() => openDockPane('leader-journal')}>Open the journal</button> : null}
    </p>
  </section>;
}
