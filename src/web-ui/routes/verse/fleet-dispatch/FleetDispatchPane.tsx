import { useCallback, useState } from 'react';
import { Button, SkeletonLine, StatusBadge } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { NoFleetNotice } from '../fleet/NoFleetNotice.js';
import { isNoFleet } from '../fleet/no-fleet.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { readDispatch } from './fleet-dispatch-model.js';
import { fleetDispatchQuery } from './fleet-dispatch-queries.js';
import styles from './fleet-dispatch.module.css';

export function FleetDispatchPane({ visible, host, roots }: PaneProps) {
  const read = useQuery(fleetDispatchQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(fleetDispatchQuery);
  const [, setTick] = useState(0);
  const poll = useCallback(() => { setTick(tick => tick + 1); return refetch(); }, [refetch]);
  usePollWhileVisible(poll, 10_000, { enabled: visible });
  const nowMs = Date.now();
  const data = readDispatch(read.data, nowMs);
  if (read.data === null || (read.error instanceof ApiError && read.error.status === 404)) return <p className={styles.message}>Live runs not in this build</p>;
  if (read.data === undefined) return <div className={styles.root} role="status">{read.status === 'error' ? 'Live runs are unavailable.' : <><span>Reading live runs…</span><SkeletonLine /><SkeletonLine /></>}</div>;
  if (!data) return <p className={styles.message} role="status">Live runs are unavailable.</p>;
  return <section className={styles.root} aria-label="Dispatch">
    <p className={styles.header}>{data.supply.freeSlots} free slots · {data.supply.queued} queued · {data.supply.text}</p>
    {isNoFleet(data.sourceState) ? <NoFleetNotice /> : data.sourceState !== 'healthy' && <p className={styles.notice} role="status">Dispatch data may be incomplete.</p>}
    {read.status === 'error' && <p className={styles.notice} role="status">Live runs could not refresh. Showing the last reading.</p>}
    {data.incidents.map(item => <div key={item.id} className={styles.notice} role="alert"><strong>{item.title}</strong> {item.detail} {item.fix}</div>)}
    <ul className={styles.list} aria-label="Lane verdicts">{data.verdicts.map(item => <li key={item.lane} className={styles.row}>
      <div className={styles.verdict}><strong><button type="button" className={styles.laneButton} aria-label={`Open ${item.lane} in Lanes`} onClick={() => host.openPane('fleet-lanes')}>{item.lane}</button></strong><StatusBadge status={item.kind} tone={item.tone === 'ok' ? 'success' : item.tone === 'warn' ? 'warning' : item.tone} /><span>{item.headline}</span></div>
      {item.action && <p className={styles.action}>{item.action}{item.action.startsWith('Run ') && <> <Button size="sm" onClick={() => host.openTerminal({ ...(roots[0] ? { root: roots[0] } : {}), paste: item.action!.slice(4) })}>Paste in Terminal</Button></>}</p>}
    </li>)}</ul>
  </section>;
}
