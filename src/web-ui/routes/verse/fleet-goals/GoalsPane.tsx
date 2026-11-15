import type { GoalsView } from '../../../../core/fleet/goals.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { OrdersCard } from './OrdersCard.js';

const query: QueryDef<GoalsView> = { key: 'fleet-goals', fetch: signal => apiGet('/api/verse/fleet/runs/goals', signal) };
export function GoalsPane({ visible }: PaneProps) {
  const read = useQuery(query, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const data = read.data;
  return <section aria-label="Goals"><h2>Goals</h2>
    {!data ? <p>{read.status === 'error' ? 'Goals are unavailable.' : 'Reading goals…'}</p> : !data.available ? <p>Dispatcher status is unknown.</p> : <>
      <p>Jobs launched in the last 24 hours. Last updated: {data.observedAt ?? 'unknown'}.</p>
      <OrdersCard visible={visible} />
      <h3>By lane</h3>
      {data.lanes.length === 0 ? <p>No lane measurements reported.</p> : <table><thead><tr><th>Lane</th><th>Merges per hour</th><th>Median open to merge (seconds)</th><th>Empty rate</th></tr></thead><tbody>{data.lanes.map(row => <tr key={row.lane}><td>{row.lane}</td><td>{row.mergesPerHour === null ? 'unknown' : row.mergesPerHour.toFixed(2)}</td><td>{row.medianOpenToMergeSeconds ?? 'unknown'}</td><td>{row.emptyRate === null ? 'unknown' : `${(row.emptyRate * 100).toFixed(1)}%`}</td></tr>)}</tbody></table>}
      <h3>Resources</h3>
      {data.pools.length === 0 ? <p>No resource measurements reported.</p> : <table><thead><tr><th>Pool</th><th>Used</th><th>Reset</th></tr></thead><tbody>{data.pools.map(row => <tr key={row.pool}><td>{row.pool}</td><td>{row.usedPercent === null ? 'unknown' : `${row.usedPercent}%`}</td><td>{row.resetAt ?? 'unknown'}</td></tr>)}</tbody></table>}
    </>}
  </section>;
}
