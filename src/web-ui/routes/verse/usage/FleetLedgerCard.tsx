import { Meter } from '../../../components/primitives/Meter.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { ageText, apiSpendLine, asOfText, ledgerRows } from './fleet-ledger-model.js';
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
  return (
    <section className={styles.card} aria-labelledby="fleet-resource-ledger">
      <div className={styles.heading}>
        <h3 id="fleet-resource-ledger">Fleet resource ledger</h3>
        {data ? <span className={styles.note}>{asOfText(data, now)}</span> : null}
      </div>
      {query.status === 'error' ? <p className={styles.note}>Resource ledger unavailable; the last reading may be stale.</p> : null}
      {!data && query.status !== 'error' ? <p className={styles.note}>Loading resource ledger…</p> : null}
      {data?.sources.status === 'missing' ? <p className={styles.note}>dispatchd has not written queue/status.json yet.</p> : null}
      {data?.sources.status === 'degraded' ? <p className={styles.note}>dispatchd status is degraded.</p> : null}
      {data && data.lanes.length > 0 ? <div className={usage.tableScroll}>
        <table className={styles.table}>
          <thead><tr><th scope="col">Lane</th><th scope="col">Used</th><th scope="col">Resets</th><th scope="col">Burn</th><th scope="col">Runs out</th><th scope="col">Running</th><th scope="col">Source</th></tr></thead>
          <tbody>{ledgerRows(data, now).map((row, index) => <tr key={`${row.lane}-${index}`}>
            <th scope="row">{row.lane} {row.held ? <StatusBadge status="held" tone="warning">Held</StatusBadge> : null}{row.caption ? <div className={styles.note}>{row.caption}</div> : null}</th>
            <td><span>{row.usage}</span>{row.usedPct !== null ? <Meter variant="line" value={row.usedPct} max={100} aria-label={`${row.lane} used`} /> : null}</td>
            <td>{row.resets ?? '—'}</td><td>{row.burn ?? '—'}</td><td>{row.runsOut ?? '—'}</td><td>{row.running ?? '—'}</td>
            <td className={styles.source} title={row.source ?? undefined}>{row.source ?? '—'}</td>
          </tr>)}</tbody>
        </table>
      </div> : null}
      {data?.apiSpend ? <>
        <p className={styles.note}>{apiSpendLine(data.apiSpend)}{data.sources.apiSpend !== 'healthy' ? ` (source ${data.sources.apiSpend})` : ''}</p>
        <p className={styles.note}>API spend ledger · last activity {ageText(data.apiSpend.lastAt, now)} · models: {data.apiSpend.models.length ? data.apiSpend.models.join(', ') : 'unknown'}</p>
      </> : data ? <p className={styles.note}>Gift pool spend {data.sources.apiSpend === 'healthy' ? 'unavailable' : data.sources.apiSpend}.</p> : null}
    </section>
  );
}
