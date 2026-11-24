import { useEffect } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { fleetActivityQuery, fleetLanesQuery, verifiedCompletionQuery } from '../../../data/queries.js';
import { BrandMark } from '../../../components/primitives/BrandMark.js';
import styles from './LiveFleetBoard.module.css';

/** Polls the bounded local projections while visible; readings retain their own observation times. */
export function LiveFleetBoard() {
  const lanes = useQuery(fleetLanesQuery, { freshMs: 0 });
  const activity = useQuery(fleetActivityQuery, { freshMs: 0 });
  const verified = useQuery(verifiedCompletionQuery, { freshMs: 0 });
  const refreshLanes = useRefetch(fleetLanesQuery);
  const refreshActivity = useRefetch(fleetActivityQuery);
  const refreshVerified = useRefetch(verifiedCompletionQuery);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      refreshLanes();
      refreshActivity();
      refreshVerified();
    };
    const timer = window.setInterval(refresh, 4000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [refreshLanes, refreshActivity, refreshVerified]);

  return (
    <section className={styles.board} aria-labelledby="live-fleet-title">
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>FLEET TELEMETRY</p><h2 id="live-fleet-title">Resource & activity</h2></div>
        <span className={styles.live}>Refreshes every 4s while visible</span>
      </header>
      <div className={styles.grid}>
        <div className={styles.panel} title="GET /api/fleet/lanes · lanes / sources">
          <h3>Lane resources</h3>
          <p className={styles.caption}>Quota remaining · source observation time shown per lane</p>
          {lanes.status === 'error' ? <p role="alert">Lane refresh failed{lanes.data ? ' · showing last reading' : ''}.</p> : null}
          {!lanes.data ? <p>{lanes.status === 'error' ? 'Lane resources unknown.' : 'Loading lane resources…'}</p> : lanes.data.lanes.length === 0 ? <p>No lanes observed.</p> : (
            <ul className={styles.lanes}>{lanes.data.lanes.map(lane => {
              const pct = lane.credit.state === 'observed' && lane.credit.remainingPct !== null && Number.isFinite(lane.credit.remainingPct)
                ? Math.max(0, Math.min(100, lane.credit.remainingPct)) : null;
              return <li key={lane.lane} className={styles.lane}>
                <div className={styles.row}><strong><BrandMark brand={lane.lane} size={19} />{lane.lane}</strong><span>{pct === null ? 'Quota unknown' : `${Math.round(pct * 10) / 10}% remaining`}</span></div>
                {pct === null ? <div className={styles.unknown}>No percentage reading</div> : <div className={styles.track} role="meter" aria-label={`${lane.lane} quota remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><div className={styles.fill} style={{ width: `${pct}%` }} /></div>}
                <div className={styles.meta}><span>Live {lane.liveJobs ?? 'unknown'} · Queue {lane.queueDepth ?? 'unknown'}</span><span>Observed {lane.credit.observedAt ?? 'unknown'}{lane.credit.state === 'reset-pending' ? ' · reset pending' : ''}</span></div>
              </li>;
            })}</ul>
          )}
          {lanes.data ? <p className={styles.caption}>Lane data: {lanes.data.generatedAt} · queue {lanes.data.sources.queue.state} · usage {lanes.data.sources.usage.state} · budgets {lanes.data.sources.budgets.state}</p> : null}
        </div>
        <div className={styles.panel} title="GET /api/fleet-activity · recentActions / recentMerges">
          <h3>Agent activity</h3>
          <p className={styles.caption}>Most recent recorded actions · up to 8</p>
          {activity.status === 'error' ? <p role="alert">Activity refresh failed{activity.data ? ' · showing last reading' : ''}.</p> : null}
          {!activity.data ? <p>{activity.status === 'error' ? 'Activity unknown.' : 'Loading activity…'}</p> : <>
            <p className={styles.caption}>Actions source: {activity.data.recentActionsSource?.sourceState ?? 'unknown'} · observed {activity.data.ts}</p>
            {activity.data.recentActions.length === 0 ? <p>No recent actions reported.</p> : <ol className={styles.feed}>{activity.data.recentActions.slice(0, 8).map((action, i) => <li key={`${action.ts}-${i}`}><span className={styles.dot} /><div><strong>{action.proseDigest ?? action.summary ?? action.action}</strong><p>{action.repo ?? 'Unknown repo'} · {action.outcome} · <time dateTime={action.ts}>{action.ts}</time></p></div></li>)}</ol>}
            <h3 className={styles.mergeTitle}>Recent merges</h3>
            <p className={styles.caption}>Source: {activity.data.recentMergesSourceQuality?.sourceState ?? 'unknown'} · up to 5 recorded</p>
            {activity.data.recentMerges.length === 0 ? <p>No recent merges reported.</p> : <ul className={styles.merges}>{activity.data.recentMerges.slice(0, 5).map((merge, i) => <li key={`${merge.ts}-${i}`}><strong>{merge.repo ?? 'Unknown repo'}</strong><span>{merge.engine ?? 'unknown engine'} · <time dateTime={merge.ts}>{merge.ts}</time></span></li>)}</ul>}
          </>}
        </div>
        <div className={styles.panel} title="GET /api/fleet/verified-completion · eligible / verified / failed / pending / rate / duplicates">
          <h3>Verified completion</h3>
          <p className={styles.caption}>Completed tasks passing an independent outcome check{verified.data && Number.isFinite(verified.data.windowMs) ? ` · ${Math.round(verified.data.windowMs / 3_600_000)}h window` : ''}</p>
          {verified.status === 'error' ? <p role="alert">Verification refresh failed{verified.data ? ' · showing last reading' : ''}.</p> : null}
          {!verified.data ? <p>{verified.status === 'error' ? 'Verification unknown.' : 'Loading verification…'}</p> : (() => {
            const vc = verified.data;
            const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
            const eligible = num(vc.eligible);
            const verifiedN = num(vc.verified);
            const failedN = num(vc.failed);
            const pendingN = num(vc.pending);
            const rate = num(vc.rate);
            const falseN = num(vc.falseCompletions);
            const multi = num(vc.duplicates?.multiPrJobs);
            const shared = num(vc.duplicates?.sharedPrUrls);
            const dupN = multi === null || shared === null ? null : multi + shared;
            const unauthN = num(vc.unauthorizedActions);
            const unpubN = num(vc.completedUnpublished);
            const degraded = vc.sourceState !== 'healthy';
            return <>
              {degraded ? <p className={styles.caption}>Source {vc.sourceState ?? 'unknown'}{vc.truncated ? ' · ledger tail clipped' : ''} — counts may be incomplete.</p> : null}
              {eligible === 0 ? <p>No completion claims in window.</p> : <p className={styles.row}><strong>{rate === null ? '—' : `${Math.round(rate * 100)}%`}</strong><span>{verifiedN ?? 'unknown'} verified · {failedN ?? 'unknown'} failed · {pendingN ?? 'unknown'} pending of {eligible ?? 'unknown'} claims</span></p>}
              <p className={styles.caption}>False completions {falseN ?? 'unknown'} · duplicates {dupN ?? 'unknown'} · unauthorized {unauthN ?? 'unknown'}{unpubN ? ` · unpublished ${unpubN}` : ''}</p>
            </>;
          })()}
        </div>
      </div>
    </section>
  );
}
