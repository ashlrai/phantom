import { Funnel } from '../../../components/charts/Funnel.js';
import type { ChartStatus } from '../../../components/charts/ChartFrame.js';
import { Button } from '../../../components/primitives/Button.js';
import { RefreshIndicator } from '../../../components/primitives/RefreshIndicator.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { ApiError, readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { funnelCaveat, funnelStages, joinPublishes, mergeRateText, readFunnelInput } from './publish-funnel-model.js';
import { publishFunnelQuery } from './publish-funnel-queries.js';
import styles from './publish-funnel.module.css';

export function PublishFunnel() {
  const visible = useSectionVisible();
  const read = useQuery(publishFunnelQuery, { enabled: visible });
  const refetch = useRefetch(publishFunnelQuery);
  const refresh = useRefresh(publishFunnelQuery);
  const missing = read.error instanceof ApiError && read.error.status === 404;
  usePollWhileVisible(refetch, 15_000, { enabled: !missing, refreshOnShow: false });
  const input = readFunnelInput(read.data);
  const status: ChartStatus = input ? { kind: 'ready' }
    : read.status === 'error' ? { kind: 'unknown', reason: readFailureReason(read.error) }
      : read.status === 'success' ? { kind: 'unknown', reason: 'The publish data has an unexpected format.' }
        : { kind: 'loading' };
  if (missing) return <p className={styles.note}>Publish funnel is not in this build yet.</p>;
  const rows = input ? joinPublishes(input) : [];
  return <section className={styles.section} aria-label="Publish funnel">
    <div className={styles.actions}>
      {read.status === 'refreshing' ? <RefreshIndicator /> : null}
      <Button size="sm" onClick={refresh} disabled={read.status === 'loading'}>Refresh</Button>
    </div>
    <Funnel title="Publish → merge, last hour" status={status} stages={input ? funnelStages(input) : []}
      caveat={input ? funnelCaveat(input) ?? undefined : undefined}
      ariaLabel={input ? mergeRateText(input.publishesLastHour.length, input.mergesLastHour.count) : undefined} />
    {input ? rows.length === 0 ? <p className={styles.note}>Nothing published in the last hour.</p> :
      <table className={styles.table}>
        <thead><tr><th scope="col">Job</th><th scope="col">Lane</th><th scope="col">Published</th><th scope="col">PR</th><th scope="col">State</th></tr></thead>
        <tbody>{rows.map((row, i) => <tr key={`${row.job}-${row.at}-${i}`}>
          <td data-label="Job"><code>{row.job}</code></td><td data-label="Lane">{row.lane ?? '—'}</td>
          <td data-label="Published" title={row.at}>{formatRelative(row.at)}</td>
          <td data-label="PR">{row.url?.startsWith('https://github.com/')
            ? <a href={row.url} target="_blank" rel="noreferrer">{row.number === null ? 'Open PR' : `#${row.number}`}</a> : '—'}</td>
          <td data-label="State"><StatusBadge status={row.state} /></td>
        </tr>)}</tbody>
      </table> : null}
  </section>;
}
