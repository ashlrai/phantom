import { Meter } from '../../../components/primitives/Meter.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { ageText, apiSpendLine, asOfText, easternClock, laneAsOf, ledgerRows, runsOutText, sourceLabel, staleness } from './fleet-ledger-model.js';
import { fleetLedgerQuery } from './fleet-ledger-queries.js';
import usage from './usage.module.css';
import styles from './fleet-ledger.module.css';

export function FleetLedgerCard({ now }: { now: number }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const visible = sectionVisible && documentVisible;
  const query = useQuery(fleetLedgerQuery, { enabled: visible });
  const refetch = useRefetch(fleetLedgerQuery);
  usePollWhileVisible(refetch, 30_000);
  if (query.data === null) return <p className={usage.muted}>The resource ledger API has not landed in this build yet.</p>;
  const data = query.data;
  const soonest = data?.lanes.reduce<{ lane: string; at: number } | null>((result, row) => {
    const at = row.projectedExhaustion === null ? NaN : Date.parse(row.projectedExhaustion);
    return row.window !== 'none' && at > now && (!result || at < result.at) ? { lane: row.lane, at } : result;
  }, null);
  return (
    <section className={styles.card} aria-labelledby="fleet-resource-ledger">
      <div className={styles.heading}>
        <h3 id="fleet-resource-ledger">Fleet resource ledger</h3>
        {soonest ? <span className={styles.note}>soonest: {soonest.lane} ~{easternClock(soonest.at)}</span> : null}
        {data ? <span className={styles.note}>{asOfText(data, now)}</span> : null}
      </div>
      {query.status === 'error' ? <p className={styles.note}>Resource ledger unavailable; the last reading may be stale.</p> : null}
      {!data && query.status !== 'error' ? <p className={styles.note}>Loading resource ledger…</p> : null}
      {data?.sources.status === 'missing' ? <p className={styles.note}>dispatchd has not written queue/status.json yet.</p> : null}
      {data?.sources.jobs === 'missing' ? <p className={styles.note}>Job metrics are missing; lane failure signals are unavailable.</p> : null}
      {data?.sources.jobs === 'degraded' ? <p className={styles.note}>Job metrics are degraded; lane failure signals may be incomplete.</p> : null}
      {data?.sources.status === 'degraded' ? <p className={styles.note}>dispatchd status is degraded.</p> : null}
      {data && data.lanes.length > 0 ? <div className={usage.tableScroll}>
        <table className={styles.table}>
          <thead><tr><th scope="col">Lane</th><th scope="col">Used</th><th scope="col">Resets</th><th scope="col">Burn</th><th scope="col">Runs out</th><th scope="col">Running</th><th scope="col">Source</th></tr></thead>
          <tbody>{ledgerRows(data, now).map((row, index) => {
            const lane = data.lanes[index]!;
            const text = runsOutText(lane, now);
            const at = lane.projectedExhaustion === null ? NaN : Date.parse(lane.projectedExhaustion);
            const delta = at - now;
            const tone = (lane.usedPct !== null && lane.usedPct >= 100) || (Number.isFinite(delta) && delta < 2 * 3_600_000) ? 'danger' : delta < 8 * 3_600_000 ? 'warning' : 'neutral';
            const age = staleness(laneAsOf(lane, data.asOf), now);
            return <tr key={`${row.lane}-${index}`}>
            <th scope="row">{row.lane} {row.deadSignal && row.deadSignal.state !== 'ok' ? <StatusBadge status={row.deadSignal.state} tone={row.deadSignal.state === 'dead' ? 'danger' : 'warning'}>{row.deadSignal.state === 'dead' ? 'Dead' : 'Suspect'} · {row.deadSignal.emptyFailures} empty failures</StatusBadge> : null} {row.held ? <StatusBadge status="held" tone="warning">Held</StatusBadge> : null}{row.caption ? <div className={styles.note}>{row.caption}</div> : null}{text ? <div className={styles.note} data-tone={tone} style={{ color: tone === 'neutral' ? undefined : `var(--status-${tone}-fg)` }}>{text}</div> : null}</th>
            <td><span>{row.usage}</span>{row.usedPct !== null ? <Meter variant="line" value={row.usedPct} max={100} aria-label={`${row.lane} used`} /> : null}</td>
            <td>{row.resets ?? '—'}</td><td>{row.burn ?? '—'}</td><td>{row.runsOut ?? '—'}</td><td>{row.running ?? '—'}</td>
            <td className={styles.source} title={sourceLabel(row.source)}><span data-tone={age.state === 'stale' ? 'warn' : undefined} style={{ color: age.state === 'stale' ? 'var(--status-warning-fg)' : undefined }}>source: {sourceLabel(row.source)} · {age.text}{age.state === 'stale' ? ' · stale' : ''}</span></td>
          </tr>; })}</tbody>
        </table>
      </div> : null}
      {data?.apiSpend ? <>
        <p className={styles.note}>{apiSpendLine(data.apiSpend)}{data.sources.apiSpend !== 'healthy' ? ` (source ${data.sources.apiSpend})` : ''}</p>
        <p className={styles.note}>API spend ledger · last activity {ageText(data.apiSpend.lastAt, now)} · models: {data.apiSpend.models.length ? data.apiSpend.models.join(', ') : 'unknown'}</p>
      </> : data ? <p className={styles.note}>Gift pool spend {data.sources.apiSpend === 'healthy' ? 'unavailable' : data.sources.apiSpend}.</p> : null}
    </section>
  );
}
