import { useState } from 'react';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { countdownLabel, formatRelative } from '../autonomy/format.js';
import { JobRefs } from '../fleet/JobRefs.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { opsFleetQuery } from '../ops/ops-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { decisionRows, decisionSummary, holdRows, stallNote, type Filter } from './fleet-decisions-model.js';
import styles from './fleet-decisions.module.css';

export function FleetDecisionsPane({ visible, host }: PaneProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const read = useQuery(opsFleetQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(opsFleetQuery);
  usePollWhileVisible(refetch, 15_000, { enabled: visible });
  if (read.data === null || (read.error instanceof ApiError && read.error.status === 404)) return <p className={styles.message}>Decisions not in this build</p>;
  if (read.data === undefined) return <p className={styles.message} role="status">{read.status === 'error' ? 'Decisions are unavailable.' : 'Reading decisions…'}</p>;
  const fleet = read.data, summary = decisionSummary(fleet), note = stallNote(summary, fleet.tickAt, Date.now());
  const decisions = decisionRows(fleet, filter), held = holdRows(fleet);
  const openJob = (job: string) => { requestWorkerLogJob(job); host.openPane('worker-log'); };
  return <section className={styles.root} aria-label="Router decisions">
    <p className={styles.header}>{summary.launched} launched · {summary.skipped} skipped · tick {formatRelative(fleet.tickAt)}</p>
    {fleet.holdProduction !== null && <p className={styles.notice}>Production is held: {fleet.holdProduction}</p>}
    {fleet.sources.journal !== 'healthy' && <p className={styles.notice}>Decision data may be incomplete.</p>}
    {read.status === 'error' && <p className={styles.notice} role="status">Decisions could not refresh. Showing the last reading.</p>}
    {note && <p className={styles.notice} role="status">{note}</p>}
    <div className={styles.filters} role="radiogroup" aria-label="Filter decisions">
      {(['all', 'launched', 'skipped'] as const).map(value => <button key={value} type="button" role="radio" aria-checked={filter === value} onClick={() => setFilter(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}
    </div>
    <ul className={styles.list} aria-label="Decisions">{decisions.map(d => <li key={d.key} className={styles.row}>
      <div><strong className={styles.badge}>{d.launched ? 'Launched' : 'Skipped'}</strong> {d.repo} · <JobRefs text={d.title} onOpenJob={openJob} /></div>
      <div>Target: {d.target} · {d.candidates} candidates · <time dateTime={d.at}>{formatRelative(d.at)}</time></div>
      <div><JobRefs text={d.reason} onOpenJob={openJob} /></div>
    </li>)}</ul>
    {decisions.length === 0 && <p className={styles.message}>No decisions to show.</p>}
    <section><h3 className={styles.heading}>Held</h3>
      <ul className={styles.list} aria-label="Held items">{held.map(h => <li key={h.key} className={styles.row}>
        <div>{h.repo} · <JobRefs text={h.title} onOpenJob={openJob} /></div><div>{h.holdKind} · <JobRefs text={h.reason} onOpenJob={openJob} /></div>
        <div>{h.nextEligibleAt ? <>lifts <time dateTime={h.nextEligibleAt}>{countdownLabel(Number.isFinite(Date.parse(h.nextEligibleAt)) ? Date.parse(h.nextEligibleAt) : null, Date.now())}</time></> : 'no lift time'}</div>
      </li>)}</ul>
      {held.length === 0 && <p className={styles.message}>No held items reported.</p>}
    </section>
  </section>;
}
