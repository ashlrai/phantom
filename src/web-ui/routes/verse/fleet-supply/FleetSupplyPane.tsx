import { useMemo } from 'react';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { openDockPane } from '../dock/dock-store.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { exhaustionByLane, soonestExhaustion } from './supply-exhaustion-model.js';
import { supplyLedgerQuery } from './supply-ledger-query.js';
import { fleetSupplyQuery } from './fleet-supply-queries.js';
import { heldUntilText } from './held-until-text.js';
import { asRecord, HORIZON_SECONDS, laneSupply, supplyHeadline, totalShortfall, TYPICAL_RUN_SECONDS } from './supply-model.js';
import styles from './fleet-supply.module.css';

export function FleetSupplyPane({ visible }: PaneProps) {
  const read = useQuery(fleetSupplyQuery, { enabled: visible, freshMs: 0 });
  const ledgerQuery = useMemo(() => supplyLedgerQuery(), []);
  const ledger = useQuery(ledgerQuery, { enabled: visible, freshMs: 0 });
  const refetchLedger = useRefetch(ledgerQuery);
  const refetch = useRefetch(fleetSupplyQuery);
  usePollWhileVisible(refetch, 10_000, { enabled: visible });
  usePollWhileVisible(refetchLedger, 10_000, { enabled: visible });
  if (read.data === null || (read.error instanceof ApiError && read.error.status === 404)) {
    return <p className={styles.message}>Live runs not in this build</p>;
  }
  if (read.data === undefined) return <p className={styles.message} role="status">{read.status === 'error' ? 'Live runs are unavailable.' : 'Reading live runs…'}</p>;
  const data = asRecord(read.data);
  const rows = laneSupply(data);
  const shortfall = totalShortfall(rows);
  const exhaustion = exhaustionByLane(ledger.data, Date.now());
  const visibleExhaustion = new Map(rows.flatMap(row => {
    const entry = exhaustion.get(row.lane);
    return entry ? [[row.lane, entry] as const] : [];
  }));
  const soonest = soonestExhaustion(visibleExhaustion);
  const unreadable = asRecord(data.sources).runsDir !== 'healthy' || data.drop === null;
  const claudeLane = typeof data.claudeLane === 'string' && /down/i.test(data.claudeLane) ? data.claudeLane : null;
  return <section className={styles.root} aria-label="Fleet supply">
    <h2 className={styles.headline}>{supplyHeadline(rows)}{shortfall > 0 && ` · Shortfall ${shortfall} slots`}{soonest && ` · ${soonest}`}</h2>
    {unreadable && <p className={styles.message} role="status">Drop folder unreadable: pending counts unknown</p>}
    {claudeLane && <p className={styles.message}>{claudeLane}</p>}
    {ledger.status === 'error' && <p className={styles.message} role="status">Resource ledger could not refresh{ledger.data ? '. Showing the last reading.' : '.'}</p>}
    {read.status === 'error' && <p className={styles.message} role="status">Live runs could not refresh. Showing the last reading.</p>}
    <div className={styles.scroll}>
      <table className={styles.table} aria-label="Job supply per lane">
        <thead><tr><th scope="col">Lane</th><th scope="col">Running/target</th><th scope="col">Free now</th><th scope="col">Freeing ≤{HORIZON_SECONDS / 60} m</th><th scope="col">Waiting</th><th scope="col">Shortfall</th></tr></thead>
        <tbody>{rows.map((row, index) => <tr key={`${row.lane}-${index}`}>
          <th scope="row"><button type="button" className={styles.linkButton} onClick={() => openDockPane('fleet-lanes')} aria-label={`Open Lanes pane (${row.lane})`}>{row.lane}</button>{row.held && <span className={styles.held} title={row.heldReason ?? undefined}>{heldUntilText(row.heldReason, Date.now())}</span>}{exhaustion.has(row.lane) && <button type="button" className={`${styles.linkButton} ${styles.exhaustion}`} onClick={() => openDockPane('fleet-usage')} data-tone={exhaustion.get(row.lane)?.tone}>{exhaustion.get(row.lane)?.text}</button>}</th>
          <td>{row.running}/{row.target}</td><td>{row.freeNow}</td><td>{row.freeingSoon}</td>
          <td>{row.pendingFiles + row.queued}</td><td>{row.shortfall > 0 ? <strong>{row.shortfall}</strong> : row.shortfall}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {rows.length === 0 && <p className={styles.message}>No lane readings yet.</p>}
    <p className={styles.footer}>Next {HORIZON_SECONDS / 60} min · assumes ~{TYPICAL_RUN_SECONDS / 60} min per job. Waiting = pending files + queued jobs.</p>
  </section>;
}
