import { useQuery, useRefetch } from '../../../data/hooks.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { claimDriftHeadline, parseClaimDrift, type ClaimDriftDisplayRow } from './claim-drift-model.js';
import { Tag } from '../../../components/primitives/Tag.js';
import { parseWorkTrace, unknownWorkChip, workStateChip, workTraceUrl, type WorkTrace, type WorkTraceItem } from '../fleet/work-trace-model.js';
import styles from './fleet-host.module.css';

const claimDriftQuery: QueryDef<unknown> = {
  key: 'verse-fleet-claim-drift',
  fetch: signal => apiGet<unknown>('/api/verse/fleet/runtime-identity/claim-drift', signal),
};

const MAX_ROWS = 8;

// One batched, read-only work-trace call for the rows on screen; keyed by the id set.
const idleTrace: QueryDef<WorkTrace | null> = { key: 'verse-fleet-claim-drift-trace:none', fetch: async () => null };
const workTraceQuery = (ids: readonly string[]): QueryDef<WorkTrace | null> => ids.length === 0 ? idleTrace : {
  key: `verse-fleet-claim-drift-trace:${ids.join('\n')}`,
  fetch: async signal => parseWorkTrace(await apiGet<unknown>(workTraceUrl(ids), signal)),
};

/** Never silently absent: loading, failure and a missing item all read "state unknown". Display only. */
function WorkChip({ item, failed, stale }: { item: WorkTraceItem | undefined; failed: boolean; stale: boolean }) {
  const chip = failed ? unknownWorkChip('Work state could not be read yet.') : workStateChip(item);
  return <span data-work-state={chip.label} data-work-tone={stale ? 'warn' : chip.tone} data-work-stale={stale || undefined}>
    <Tag size="sm" title={chip.title}>{stale ? `${chip.label} · stale` : chip.label}</Tag>
  </span>;
}

function rowOwner(row: ClaimDriftDisplayRow): string {
  return row.kind === 'owner mismatch' ? `${row.busOwner ?? '?'}→${row.coordOwner ?? '?'}` : row.owner;
}

export function ClaimDriftCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(claimDriftQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 30_000 });
  const refetch = useRefetch(claimDriftQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  const view = read.data === undefined ? null : parseClaimDrift(read.data);
  const headline = view ? claimDriftHeadline(view) : null;
  const failed = Boolean(read.error) || read.status === 'error';
  const stale = failed && view !== null;
  const lastSuccess = typeof read.updatedAt === 'number' ? new Date(read.updatedAt).toISOString() : null;
  const shown = view ? view.rows.slice(0, MAX_ROWS) : [];
  const ids = [...new Set(shown.map(r => r.id))];
  const trace = workTraceQuery(ids);
  const traceRead = useQuery(trace, { enabled: visible && sectionVisible && documentVisible && ids.length > 0, freshMs: 30_000 });
  const refetchTrace = useRefetch(trace);
  usePollWhileVisible(() => { if (ids.length > 0) refetchTrace(); }, 30_000, { enabled: visible && ids.length > 0, refreshOnShow: false });
  const traced = new Map((traceRead.data?.items ?? []).map(item => [item.id, item]));
  const traceFailed = Boolean(traceRead.error) || traceRead.status === 'error';
  const traceStale = traceFailed && traceRead.data != null;
  const traceLastSuccess = typeof traceRead.updatedAt === 'number' ? new Date(traceRead.updatedAt).toISOString() : null;
  return <section className={styles.section} aria-label="Claim store drift">
    <h3 className={styles.title}>Claim stores</h3>
    {failed && !view ? <p className={styles.line} data-tone="warn">Claim stores unknown: request failed</p>
      : read.data === undefined ? <p className={styles.muted} role="status">Reading claim stores…</p>
      : !view || !headline ? <p className={styles.line} data-tone="warn">Claim stores unknown: unreadable response</p>
      : <>
        {stale ? <p className={styles.muted} role="status">Refresh failed; showing the last claim-store report, which may be stale. Last successful update:{' '}
          {lastSuccess === null ? 'time unavailable' : <time dateTime={lastSuccess}>{lastSuccess}</time>}.</p> : null}
        <p className={styles.line} data-tone={stale ? 'warn' : headline.tone === 'ok' ? undefined : headline.tone === 'bad' ? 'bad' : 'warn'}>
          {stale ? `Stale evidence: ${headline.text}` : headline.text}
        </p>
        {traceStale ? <p className={styles.muted} role="status">Work-trace refresh failed; showing cached evidence, which may be stale. Last successful update:{' '}
          {traceLastSuccess === null ? 'time unavailable' : <time dateTime={traceLastSuccess}>{traceLastSuccess}</time>}.</p> : null}
        {view.rows.length > 0 ? <ul className={styles.peerList}>
          {shown.map((row, i) => {
            const item = traced.get(row.id);
            return <li className={styles.peerRow} key={`${i}:${row.kind}:${row.id}`}>
            <span className={styles.badge} data-tone="bad">{row.kind}</span>
            <span>{row.id}</span>
            <WorkChip item={item} failed={traceFailed && !traceStale} stale={traceStale && item !== undefined} />
            <span className={styles.muted}>{rowOwner(row)}</span>
            <span className={styles.muted}>lease until {row.leaseUntil}</span>
            {row.kind === 'owner mismatch' && item?.owner ? <span className={styles.muted}>bus trace owner {item.owner}</span> : null}
          </li>;
          })}
        </ul> : null}
        {view.rows.length > MAX_ROWS ? <p className={styles.muted}>+{view.rows.length - MAX_ROWS} more</p> : null}
      </>}
  </section>;
}
