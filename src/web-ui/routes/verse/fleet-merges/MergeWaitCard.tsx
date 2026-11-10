import { useQuery, useRefetch } from '../../../data/hooks.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { Card, CardNote } from '../command/Surface.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { formatWait, mergeWaitView, type MergeWaitView, type RetryRow } from './merge-wait-model.js';

const mergeWaitQuery: QueryDef<MergeWaitView> = {
  key: 'verse-fleet-merge-latency-24h',
  fetch: async signal => {
    const view = mergeWaitView(await apiGet<unknown>('/api/verse/fleet/merge-latency?hours=24', signal));
    if (!view) throw new Error('Invalid merge latency response');
    return view;
  },
};

function RetryList({ title, rows }: { title: string; rows: RetryRow[] }) {
  if (rows.length === 0) return null;
  return (
    <>
      <p>{title}</p>
      <ul>
        {rows.map(row => (
          <li key={row.key}>
            {row.href ? <a href={row.href} target="_blank" rel="noreferrer noopener">{row.label}</a> : row.label}
            {row.detail ? `: ${row.detail}` : ''}
          </li>
        ))}
      </ul>
    </>
  );
}

export function MergeWaitCard({ visible }: { visible: boolean }) {
  const read = useQuery(mergeWaitQuery, { enabled: visible, freshMs: 60_000 });
  const refetch = useRefetch(mergeWaitQuery);
  usePollWhileVisible(refetch, 60_000, { enabled: visible });
  const view = read.data;
  return (
    <Card title="Where PRs wait" caption="Last 24 hours">
      {!view ? (
        read.status === 'error'
          ? <CardNote tone="danger">Merge wait times are unavailable.</CardNote>
          : <CardNote>Reading merge wait times…</CardNote>
      ) : view.ledger === 'missing' ? (
        <CardNote>No merge observations yet. <code>{'phm fleet merge-latency --record <event JSON>'}</code> records them.</CardNote>
      ) : (
        <>
          <table>
            <tbody>
              {view.stages.map(s => (
                <tr key={s.key}>
                  <th scope="row">{s.label}</th>
                  <td>median {formatWait(s.medianS)}</td>
                  <td>slowest {formatWait(s.slowestS)}</td>
                  <td>{s.known} of {s.total} known</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>{view.verdict ?? 'No single stage is the longest wait yet.'}</p>
          <RetryList title="Dropped auto-merges the fleet will retry" rows={view.retryable} />
          <RetryList title="Dropped auto-merges waiting for a person" rows={view.needsPerson} />
        </>
      )}
    </Card>
  );
}
