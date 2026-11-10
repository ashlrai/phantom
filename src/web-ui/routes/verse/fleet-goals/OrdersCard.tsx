import { useState } from 'react';
import type { OrderRow, OrdersViewV1 } from '../../../../core/verse/fleet-orders-view.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost, readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { ORDER_ACTION_LABEL, buildOrdersModel, type OrderAction } from './orders-model.js';

const query: QueryDef<OrdersViewV1> = { key: 'fleet-orders', fetch: signal => apiGet('/api/verse/fleet/runs/orders', signal) };
const STATUS_PATH = '/api/verse/fleet/runs/orders/status';

async function postOrderStatus(id: string, status: OrderAction): Promise<OrderRow> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  const row = await apiPost<OrderRow>(STATUS_PATH, { id, status }, token);
  touchMutationHold();
  return row;
}

function failureText(error: unknown): string {
  if (error instanceof VerseControlLockedError) return error.message;
  return error instanceof Error && !('status' in error) ? error.message : readFailureReason(error);
}

function OrderItem({ row, refresh }: { row: ReturnType<typeof buildOrdersModel>['rows'][number]; refresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: OrderAction) => {
    setBusy(true);
    setError(null);
    try {
      await postOrderStatus(row.id, action);
      refresh();
    } catch (e) {
      setError(failureText(e));
    } finally {
      setBusy(false);
    }
  };
  return <li>
    {row.quiet ? <strong>Gone quiet: </strong> : null}{row.title} — {row.status}
    {row.rq ? ` · ${row.rq}` : ''}{row.prs ? ` · ${row.prs}` : ''}
    {row.actions.map(action => <button key={action} type="button" disabled={busy}
      aria-label={`${ORDER_ACTION_LABEL[action]}: ${row.title}`} onClick={() => { void act(action); }}>
      {ORDER_ACTION_LABEL[action]}</button>)}
    {error ? <span role="alert"> {error}</span> : null}
  </li>;
}

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
        <ul>{model.rows.map(row => <OrderItem key={row.id} row={row} refresh={refresh} />)}</ul>
      </>}
  </section>;
}
