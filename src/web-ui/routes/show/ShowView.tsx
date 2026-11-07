import { useEffect, useMemo, useState } from 'react';
import { useQuery, useRefetch } from '../../data/hooks.js';
import { controlLogsObservationQuery, fleetActivityQuery, fleetStatusQuery, inboxQuery, runsQuery } from '../../data/queries.js';
import { buildJournalEntries } from '../journal/journal-model.js';
import { EpistemicBadge } from '../../components/primitives/Epistemic.js';
import styles from './ShowView.module.css';

const REFRESH_MS = 15_000;
const ADVANCE_MS = 8_000;

export function ShowView() {
  const activity = useQuery(fleetActivityQuery);
  const fleet = useQuery(fleetStatusQuery);
  const logs = useQuery(controlLogsObservationQuery);
  const runs = useQuery(runsQuery);
  const inbox = useQuery(inboxQuery);
  const refreshActivity = useRefetch(fleetActivityQuery);
  const refreshFleet = useRefetch(fleetStatusQuery);
  const refreshLogs = useRefetch(controlLogsObservationQuery);
  const refreshRuns = useRefetch(runsQuery);
  const refreshInbox = useRefetch(inboxQuery);
  const [playing, setPlaying] = useState(true);
  const [position, setPosition] = useState(0);
  const entries = useMemo(() => buildJournalEntries({ logs: logs.data, fleetActivity: activity.data, runs: runs.data, inbox: inbox.data }), [logs.data, activity.data, runs.data, inbox.data]);
  const merges = entries.filter(entry => entry.source === 'merge');
  const current = entries[position % (entries.length || 1)];

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'hidden') {
        refreshActivity(); refreshFleet(); refreshLogs(); refreshRuns(); refreshInbox();
      }
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [refreshActivity, refreshFleet, refreshLogs, refreshRuns, refreshInbox]);
  useEffect(() => {
    if (!playing || entries.length < 2) return;
    const id = setInterval(() => setPosition(value => value + 1), ADVANCE_MS);
    return () => clearInterval(id);
  }, [playing, entries.length]);

  const errors = [activity, fleet, logs, runs, inbox].filter(query => query.status === 'error').length;
  return <div className={styles.view}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>THE FLEET · SHOW MODE</p><h1>Watch the work unfold.</h1><p>Real activity from the fleet, as it happens.</p></div>
      <button type="button" onClick={() => setPlaying(!playing)}>{playing ? 'Pause story' : 'Play story'}</button>
    </header>
    {errors > 0 && <p className={styles.warning} role="alert">{errors} data source{errors === 1 ? '' : 's'} unavailable. Some activity may be missing or stale.</p>}
    <section className={styles.metrics} aria-label="Fleet metrics">
      <div><span>In progress</span><strong>{runs.data ? runs.data.filter(run => run.status === 'running').length : '—'}</strong><small>recent runs</small></div>
      <div><span>In the queue</span><strong>{fleet.data?.queue.backlogItems ?? '—'}</strong><small>backlog items</small></div>
      <div><span>Awaiting review</span><strong>{inbox.data?.pending ?? '—'}</strong><small>pending proposals</small></div>
      <div><span>Recent merges</span><strong>{fleet.data?.merges.recent ?? '—'}</strong><small>fleet status</small></div>
    </section>
    <p className={styles.blockers}>Repair route blocked: <strong>{fleet.data?.queue.repairRouteBlockedItems ?? 'unknown'}</strong> · Repair control blocked: <strong>{fleet.data?.queue.repairControlBlockedItems ?? 'unknown'}</strong></p>
    <div className={styles.columns}>
      <section className={styles.stage} aria-label="Fleet story">
        <div className={styles.sectionHeading}><span>THE STORY</span><span>{playing ? 'AUTO-ADVANCING' : 'PAUSED'}</span></div>
        {current ? <div className={styles.story}>
          <p className={styles.kicker}>{current.source.replace('-', ' ')} · {current.statusLabel}</p>
          <h2>{current.title}</h2><p>{current.detail}</p>
          <div className={styles.storyMeta}><time>{current.ts}</time><EpistemicBadge quality={current.sourceQuality} /></div>
        </div> : <p className={styles.empty}>{[activity, logs, runs, inbox].some(q => q.status === 'loading') ? 'Loading fleet activity…' : 'No recent activity available.'}</p>}
        <div className={styles.controls}><span>{entries.length ? `${position % entries.length + 1} / ${entries.length}` : '—'}</span><button type="button" disabled={entries.length < 2} onClick={() => setPosition(value => value + 1)}>Next event →</button></div>
      </section>
      <section className={styles.ticker} aria-label="Merge ticker"><div className={styles.sectionHeading}><span>MERGE TICKER</span><span>RECENT</span></div>
        {merges.length ? <ul>{merges.map(merge => <li key={merge.id}><span className={styles.spark}>✦</span><div><strong>{merge.repo ?? 'Unknown repo'}</strong><p>{merge.detail}</p><time>{merge.ts}</time><EpistemicBadge quality={merge.sourceQuality} /></div></li>)}</ul> : <p className={styles.empty}>{activity.status === 'loading' ? 'Loading merges…' : activity.status === 'error' ? 'Merge activity unavailable.' : 'No recent merges reported.'}</p>}
      </section>
    </div>
    <p className={styles.caption}>Recent activity only: fleet merges, ticks and agent actions, daemon logs, runs and pending proposals. Sources refresh every 15 seconds while visible.</p>
  </div>;
}
