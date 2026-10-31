import { useEffect, useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import { openDockPane } from '../dock/dock-store.js';
import { JobRefs } from '../fleet/JobRefs.js';
import fleetStyles from '../fleet/fleet.module.css';
import { JOB_ID_RE } from '../fleet-job-log/worker-log-model.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { formatRelative } from '../verse-model.js';
import { filterNotes, filterPasses, groupRejects, ingestTone, passFilterLabel, passIngestCounts, passSchedule, passSummary, passWroteText } from './leader-journal-model.js';
import { leaderJournalQuery } from './leader-journal-queries.js';
import styles from './leader-journal.module.css';

function openLog(id: string) {
  if (!JOB_ID_RE.test(id)) return;
  requestWorkerLogJob(id);
  openDockPane('worker-log');
}

export function LeaderJournalPane({ visible }: PaneProps) {
  const [query, setQuery] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  useEffect(() => {
    if (visible && sectionVisible && documentVisible) setNowMs(Date.now());
  }, [visible, sectionVisible, documentVisible]);
  const read = useQuery(leaderJournalQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(leaderJournalQuery);
  const refresh = useRefresh(leaderJournalQuery);
  usePollWhileVisible(() => { setNowMs(Date.now()); refetch(); }, 30_000, { enabled: visible, refreshOnShow: false });
  const data = read.data;
  const passes = data ? [...data.passes].sort((a, b) => {
    const aTime = Date.parse(a.at);
    const bTime = Date.parse(b.at);
    if (!Number.isFinite(aTime)) return Number.isFinite(bTime) ? 1 : b.at.localeCompare(a.at);
    if (!Number.isFinite(bTime)) return -1;
    return bTime - aTime || b.at.localeCompare(a.at);
  }) : [];
  const ingestCounts = passIngestCounts(passes, data?.ingested ?? [], nowMs);
  const schedule = data ? passSchedule(passes, nowMs) : null;
  const searching = query.trim().length > 0;
  const filtered = filterPasses(passes, query);
  const notes = filterNotes(data?.notes ?? [], query);
  const rejects = data ? Object.entries(groupRejects(data.ingest)) : [];

  return <div className={styles.pane} aria-label="Leader journal">
    <header className={styles.header}>
      <div>
        {data ? <p className={styles.headline}>{passes.length} {passes.length === 1 ? 'pass' : 'passes'} · last {passes[0] ? formatRelative(passes[0].at, nowMs) || 'unknown' : 'none'}{passes[0] ? ` · last pass ${passWroteText(ingestCounts.get(passes[0].at) ?? 0).text}` : null}</p> : null}
        {schedule ? <span role="status"><StatusBadge status={schedule.tone} tone={schedule.tone === 'ok' ? 'success' : schedule.tone}>{schedule.text}</StatusBadge></span> : null}
        {data && data.rejectedLastHour !== null && data.rejectedLastHour > 0 ? <StatusBadge status="rejected">{data.rejectedLastHour} rejected in the last hour</StatusBadge> : null}
      </div>
      <input type="search" aria-label="Search journal" value={query} onChange={(event) => setQuery(event.target.value)} />
      <Button size="sm" variant="ghost" onClick={refresh}>Refresh</Button>
    </header>
    {read.status === 'error' ? <p className={styles.note} role="alert">{read.error instanceof Error ? read.error.message : String(read.error)}</p>
      : data === null ? <p className={styles.note}>The leader journal API has not landed in this build yet.</p>
        : data === undefined ? <div className={styles.section} aria-label="Loading leader journal" aria-busy="true"><SkeletonLine /><SkeletonLine /></div>
          : <>
            <section className={styles.section} aria-labelledby="journal-notes">
              <h3 id="journal-notes">Leader notes</h3>
              {data.sources.orchestration !== 'healthy' ? <p className={styles.note}>Leader notes source missing.</p> : null}
              {notes.length === 0 ? <p className={styles.note}>{searching ? 'No notes match' : 'No leader notes yet.'}</p> : notes.map((note, index) => <details className={styles.pass} key={`${note.at}-${index}`} open={searching || index === 0}>
                <summary>{note.at}{note.bullets[0] ? <span> · {note.bullets[0]}</span> : null}</summary>
                <ul>{note.bullets.map((bullet, bulletIndex) => <li key={bulletIndex}><JobRefs text={bullet} onOpenJob={openLog} /></li>)}</ul>
              </details>)}
            </section>
            <section className={styles.section} aria-labelledby="journal-passes">
              <h3 id="journal-passes">Passes</h3>
              {data.sources.planLog !== 'healthy' ? <p className={styles.note}>Plan log source {data.sources.planLog}.</p> : null}
              {searching ? <p className={styles.note}>{passFilterLabel(filtered.length, passes.length) || `${filtered.length} of ${passes.length} passes`}</p> : null}
              {filtered.length === 0 ? <p className={styles.note}>{searching ? 'No passes match' : 'No leader passes yet.'}</p> : filtered.map(({ pass, matchedBullets }, index) => {
                const wrote = passWroteText(ingestCounts.get(pass.at) ?? 0);
                return <details className={styles.pass} key={`${pass.at}-${index}`} open={searching || index === 0}>
                <summary><time dateTime={pass.at}>{pass.at}</time>{passSummary(pass) ? <span> · {passSummary(pass)}</span> : null} <span data-tone={wrote.tone}><StatusBadge status={wrote.tone} tone={wrote.tone}>{wrote.text}</StatusBadge></span></summary>
                {pass.sections.map((section, sectionIndex) => <div key={`${section.title}-${sectionIndex}`}>
                  <h4>{section.title}</h4>
                  <ul>{section.bullets.map((bullet, bulletIndex) => <li key={bulletIndex} className={matchedBullets.has(bullet) ? styles.match : undefined}><JobRefs text={bullet} onOpenJob={openLog} /></li>)}</ul>
                </div>)}
              </details>; })}
            </section>
            <section className={styles.section} aria-labelledby="journal-drop">
              <h3 id="journal-drop">Drop funnel</h3>
              {data.sources.ingested !== 'healthy' ? <p className={styles.note}>Ingested jobs source {data.sources.ingested}.</p> : null}
              {data.sources.ingestLog !== 'healthy' ? <p className={styles.note}>Ingest log source {data.sources.ingestLog}.</p> : null}
              <p className={styles.note}>{rejects.length ? `Rejections: ${rejects.map(([reason, count]) => `${reason} (${count})`).join(' · ')}` : 'No rejections recorded.'}</p>
              {data.ingested.length ? <div className={styles.tableWrap}><table className={styles.table}>
                <caption>Ingested jobs</caption>
                <thead><tr><th scope="col">Time</th><th scope="col">ID</th><th scope="col">Lane · tier</th><th scope="col">Leader</th></tr></thead>
                <tbody>{data.ingested.map((row, index) => <tr key={`${row.id}-${row.at}-${index}`}><td><time dateTime={row.at}>{row.at}</time></td><td title={row.title}><button type="button" className={fleetStyles.refButton} aria-label={`Open log for ${row.id}`} onClick={() => openLog(row.id)}>{row.id}</button>{row.title ? <> · <JobRefs text={row.title} onOpenJob={openLog} /></> : null}</td><td>{row.lane} · {row.tier}</td><td>{row.leader}</td></tr>)}</tbody>
              </table></div> : <p className={styles.note}>No ingested jobs recorded.</p>}
              {data.ingest.length ? <ul className={styles.ingest}>{data.ingest.map((row, index) => <li key={`${row.file}-${index}`} data-tone={ingestTone(row)}><span>{row.verb} · {row.file}</span>{row.reason !== null ? <span> · {row.reason}</span> : null}</li>)}</ul> : <p className={styles.note}>No ingest events recorded.</p>}
            </section>
          </>}
  </div>;
}
