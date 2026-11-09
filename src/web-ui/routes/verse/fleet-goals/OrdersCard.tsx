import type { OrdersViewV1 } from '../../../../core/verse/fleet-orders-view.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { buildOrdersModel } from './orders-model.js';

const query: QueryDef<OrdersViewV1> = { key: 'fleet-orders', fetch: signal => apiGet('/api/verse/fleet/runs/orders', signal) };

export function OrdersCard({ visible }: { visible: boolean }) {
  const read = useQuery(query, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const model = read.data ? buildOrdersModel(read.data) : null;
  return <section aria-label="Orders"><h3>Orders</h3>
    {!model ? <p>{read.status === 'error' ? 'Orders are unavailable right now.' : 'Reading orders…'}</p>
      : model.state === 'unavailable' ? <p>Orders are unavailable right now.</p>
      : model.state === 'empty' ? <p>No orders are tracked yet.</p>
      : <>
        <p>{model.headline}</p>
        <ul>{model.rows.map(row => <li key={row.id}>
          {row.quiet ? <strong>Gone quiet: </strong> : null}{row.title} — {row.status}
          {row.rq ? ` · ${row.rq}` : ''}{row.prs ? ` · ${row.prs}` : ''}
        </li>)}</ul>
      </>}
  </section>;
}
