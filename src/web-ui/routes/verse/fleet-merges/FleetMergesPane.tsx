import { useEffect, useMemo, useState } from 'react';
import { Button, SkeletonLine } from '../../../components/primitives/index.js';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { safeHref } from '../cloud/cloud-model.js';
import { JOB_ID_RE } from '../fleet-job-log/worker-log-model.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { readMerges } from './fleet-merges-model.js';
import { fleetMergesQuery } from './fleet-merges-queries.js';
import { mergesMarkdown } from './merges-markdown.js';
import { ReleaseStrip } from './ReleaseStrip.js';
import styles from './fleet-merges.module.css';

export function FleetMergesPane({ visible, host }: PaneProps) {
  const read = useQuery(fleetMergesQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(fleetMergesQuery);
  usePollWhileVisible(refetch, 10_000, { enabled: visible });
  const data = useMemo(() => readMerges(read.data), [read.data]);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (notice !== 'Copied') return;
    const timer = setTimeout(() => setNotice(''), 2_000);
    return () => clearTimeout(timer);
  }, [notice]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(mergesMarkdown(data, Date.now())); setNotice('Copied'); }
    catch { setNotice('Copy failed'); }
  };

  if (read.data === null || (read.error instanceof ApiError && read.error.status === 404)) return <section className={styles.root} aria-label="Merges"><ReleaseStrip visible={visible} /><p className={styles.message}>Live runs not in this build</p></section>;
  if (read.data === undefined) return <section className={styles.root} aria-label="Merges"><ReleaseStrip visible={visible} /><div role="status">{read.status === 'error' ? 'Live runs are unavailable.' : <><span>Reading live runs…</span><SkeletonLine /><SkeletonLine /></>}</div></section>;
  return <section className={styles.root} aria-label="Merges">
    <ReleaseStrip visible={visible} />
    <div className={styles.headerActions}><p className={styles.header}>{data.count ?? '—'} merged in the last hour · {data.pending.length} publishes waiting</p>
      <Button size="sm" variant="subtle" aria-label="Copy merges as Markdown" disabled={!data.merged.length && !data.pending.length} onClick={() => void copy()}>Copy as Markdown</Button><span role="status">{notice}</span></div>
    {data.sourceState !== 'healthy' && <p className={styles.notice} role="status">Merge data may be incomplete.</p>}
    {read.status === 'error' && <p className={styles.notice} role="status">Live runs could not refresh. Showing the last reading.</p>}
    <section><h3 className={styles.heading}>Merged in the last hour</h3>
      {data.merged.length === 0 ? <p className={styles.message}>No merged PRs reported.</p> : <ul className={styles.list} aria-label="Merged PRs">{data.merged.map((item, index) => {
        const href = safeHref(item.href, 'github.com');
        return <li key={`${item.repo}:${item.number}:${index}`} className={styles.row}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{item.repo} #{item.number}</a> : <span>{item.repo} #{item.number}</span>} <span>{item.title}</span></li>;
      })}</ul>}
    </section>
    <section><h3 className={styles.heading}>Publishes waiting</h3>
      {data.pending.length === 0 ? <p className={styles.message}>No publishes waiting.</p> : <ul className={styles.list} aria-label="Publishes waiting">{data.pending.map((item, index) => {
        const href = safeHref(item.href, 'github.com'), valid = Number.isFinite(Date.parse(item.at));
        return <li key={`${item.job}:${item.at}:${index}`} className={styles.row}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{item.job}</a> : <span>{item.job}</span>} <span>· {item.lane ?? '—'} · <time dateTime={valid ? item.at : undefined} title={valid ? new Date(item.at).toLocaleString() : undefined}>{formatRelative(item.at)}</time></span>{JOB_ID_RE.test(item.job) && <Button size="sm" variant="subtle" aria-label={`Open log for ${item.job}`} onClick={() => { requestWorkerLogJob(item.job); host.openPane('worker-log'); }}>Open log</Button>}</li>;
      })}</ul>}
    </section>
    <section><h3 className={styles.heading}>Lane throughput · 24 h</h3>
      {data.lanes.length === 0 ? <p className={styles.message}>No lane throughput reported.</p> : <ul className={styles.list} aria-label="Lane throughput">{data.lanes.map((item, index) => <li key={`${item.lane}:${index}`} className={styles.row}><span>{item.lane}</span>{' '}<span>{item.merged24h ?? '—'} merged · {item.mergeRate24h === null ? '—' : `${item.mergeRate24h.toFixed(1)}%`}</span></li>)}</ul>}
    </section>
  </section>;
}
