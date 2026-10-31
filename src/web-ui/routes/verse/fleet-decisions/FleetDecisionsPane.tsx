import { useState } from 'react';
import { ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { countdownLabel, formatRelative } from '../autonomy/format.js';
import { JobRefs } from '../fleet/JobRefs.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { opsFleetQuery } from '../ops/ops-queries.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { decisionPr, decisionRows, decisionSummary, holdRows, normalizeQuery, repeatedSkips, searchRows, stallNote, type Filter } from './fleet-decisions-model.js';
import styles from './fleet-decisions.module.css';

export function FleetDecisionsPane({ visible, host }: PaneProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const read = useQuery(opsFleetQuery, { enabled: visible, freshMs: 0 });
  const snapshot = useQuery(opsRunsQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(opsFleetQuery);
  const refetchSnapshot = useRefetch(opsRunsQuery);
  usePollWhileVisible(refetch, 15_000, { enabled: visible });
  usePollWhileVisible(refetchSnapshot, 15_000, { enabled: visible });
  if (read.data === null || (read.error instanceof ApiError && read.error.status === 404)) return <p className={styles.message}>Decisions not in this build</p>;
  if (read.data === undefined) return <p className={styles.message} role="status">{read.status === 'error' ? 'Decisions are unavailable.' : 'Reading decisions…'}</p>;
  const fleet = read.data, summary = decisionSummary(fleet), repeats = repeatedSkips(fleet), note = stallNote(summary, fleet.tickAt, Date.now(), repeats.length);
  const normalized = normalizeQuery(query);
  const filtered = decisionRows(fleet, filter);
  const decisions = searchRows(filtered, normalized), held = searchRows(holdRows(fleet), normalized);
  const openJob = (job: string) => { requestWorkerLogJob(job); host.openPane('worker-log'); };
  return <section className={styles.root} aria-label="Router decisions">
    <p className={styles.header}>{summary.launched} launched · {summary.skipped} skipped · tick {formatRelative(fleet.tickAt)}</p>
    {fleet.holdProduction !== null && <p className={styles.notice}>Production is held: {fleet.holdProduction}</p>}
    {fleet.sources.journal !== 'healthy' && <p className={styles.notice}>Decision data may be incomplete.</p>}
    {read.status === 'error' && <p className={styles.notice} role="status">Decisions could not refresh. Showing the last reading.</p>}
    {note && <p className={styles.notice} role="status">{note}</p>}
    <div className={styles.filters}>
      <div className={styles.filters} role="radiogroup" aria-label="Filter decisions">
        {(['all', 'launched', 'skipped'] as const).map(value => <button key={value} type="button" role="radio" aria-checked={filter === value} onClick={() => setFilter(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}
      </div>
      <input type="search" aria-label="Search decisions" placeholder="job id, repo or reason" value={query} onChange={event => setQuery(event.target.value)} />
      {normalized !== '' && <span>{decisions.length} of {filtered.length}</span>}
    </div>
    {repeats.length > 0 && <section aria-label="Repeated skips"><h3 className={styles.heading}>Repeated skips</h3>
      <ul className={styles.list}>{repeats.map(r => <li key={r.itemId} className={styles.row}>
        <div><JobRefs text={r.title} onOpenJob={openJob} /></div>
        <div>skipped {r.runs} ticks in a row since <time dateTime={r.since}>{formatRelative(r.since)}</time></div>
        <div><JobRefs text={r.reason} onOpenJob={openJob} /></div>
      </li>)}</ul>
    </section>}
    <ul className={styles.list} aria-label="Decisions">{decisions.map(d => { const pr = d.launched ? decisionPr(d.title, snapshot.data ?? undefined) : null; return <li key={d.key} className={styles.row}>
      <div><strong className={styles.badge}>{d.launched ? 'Launched' : 'Skipped'}</strong> {d.repo} · <JobRefs text={d.title} onOpenJob={openJob} /></div>
      <div>Target: {d.target} · {d.candidates} candidates · <time dateTime={d.at}>{formatRelative(d.at)}</time></div>
      <div><JobRefs text={d.reason} onOpenJob={openJob} /></div>
      {pr && (pr.href ? <a data-testid="decision-pr" href={pr.href} target="_blank" rel="noreferrer">{pr.label}</a> : <span data-testid="decision-pr">{pr.label}</span>)}
    </li>; })}</ul>
    {decisions.length === 0 && <p className={styles.message}>{normalized === '' ? 'No decisions to show.' : <>No decisions match "{normalized}". <button type="button" onClick={() => setQuery('')}>Clear search</button></>}</p>}
    <section><h3 className={styles.heading}>Held</h3>
      <ul className={styles.list} aria-label="Held items">{held.map(h => <li key={h.key} className={styles.row}>
        <div>{h.repo} · <JobRefs text={h.title} onOpenJob={openJob} /></div><div>{h.holdKind} · <JobRefs text={h.reason} onOpenJob={openJob} /></div>
        <div>{h.nextEligibleAt ? <>lifts <time dateTime={h.nextEligibleAt}>{countdownLabel(Number.isFinite(Date.parse(h.nextEligibleAt)) ? Date.parse(h.nextEligibleAt) : null, Date.now())}</time></> : 'no lift time'}</div>
      </li>)}</ul>
      {held.length === 0 && <p className={styles.message}>{normalized === '' ? 'No held items reported.' : <>No held items match "{normalized}". <button type="button" onClick={() => setQuery('')}>Clear search</button></>}</p>}
    </section>
  </section>;
}
