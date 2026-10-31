import { Button } from '../../../components/primitives/Button.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { useQuery, useRefetch, useRefresh } from '../../../data/hooks.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { formatRelative } from '../verse-model.js';
import { groupRejects, ingestTone, passSummary } from './leader-journal-model.js';
import { leaderJournalQuery } from './leader-journal-queries.js';
import styles from './leader-journal.module.css';

export function LeaderJournalPane({ visible }: PaneProps) {
  const read = useQuery(leaderJournalQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(leaderJournalQuery);
  const refresh = useRefresh(leaderJournalQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  const data = read.data;
  const passes = data ? [...data.passes].sort((a, b) => (Date.parse(b.at) - Date.parse(a.at)) || b.at.localeCompare(a.at)) : [];
  const rejects = data ? Object.entries(groupRejects(data.ingest)) : [];

  return <div className={styles.pane} aria-label="Leader journal">
    <header className={styles.header}>
      <div>
        {data ? <p className={styles.headline}>{passes.length} {passes.length === 1 ? 'pass' : 'passes'} · last {passes[0] ? formatRelative(passes[0].at) || 'unknown' : 'none'}</p> : null}
        {data && data.rejectedLastHour !== null && data.rejectedLastHour > 0 ? <StatusBadge status="rejected">{data.rejectedLastHour} rejected in the last hour</StatusBadge> : null}
      </div>
      <Button size="sm" variant="ghost" onClick={refresh}>Refresh</Button>
    </header>
    {read.status === 'error' ? <p className={styles.note} role="alert">{read.error instanceof Error ? read.error.message : String(read.error)}</p>
      : data === null ? <p className={styles.note}>The leader journal API has not landed in this build yet.</p>
        : data === undefined ? <div className={styles.section} aria-label="Loading leader journal" aria-busy="true"><SkeletonLine /><SkeletonLine /></div>
          : <>
            <section className={styles.section} aria-labelledby="journal-passes">
              <h3 id="journal-passes">Passes</h3>
              {data.sources.planLog !== 'healthy' ? <p className={styles.note}>Plan log source {data.sources.planLog}.</p> : null}
              {passes.length === 0 ? <p className={styles.note}>No leader passes yet.</p> : passes.map((pass, index) => <details className={styles.pass} key={`${pass.at}-${index}`} open={index === 0}>
                <summary><time dateTime={pass.at}>{pass.at}</time>{passSummary(pass) ? <span> · {passSummary(pass)}</span> : null}</summary>
                {pass.sections.map((section, sectionIndex) => <div key={`${section.title}-${sectionIndex}`}>
                  <h4>{section.title}</h4>
                  <ul>{section.bullets.map((bullet, bulletIndex) => <li key={bulletIndex}>{bullet}</li>)}</ul>
                </div>)}
              </details>)}
            </section>
            <section className={styles.section} aria-labelledby="journal-drop">
              <h3 id="journal-drop">Drop funnel</h3>
              {data.sources.ingested !== 'healthy' ? <p className={styles.note}>Ingested jobs source {data.sources.ingested}.</p> : null}
              {data.sources.ingestLog !== 'healthy' ? <p className={styles.note}>Ingest log source {data.sources.ingestLog}.</p> : null}
              <p className={styles.note}>{rejects.length ? `Rejections: ${rejects.map(([reason, count]) => `${reason} (${count})`).join(' · ')}` : 'No rejections recorded.'}</p>
              {data.ingested.length ? <div className={styles.tableWrap}><table className={styles.table}>
                <caption>Ingested jobs</caption>
                <thead><tr><th scope="col">Time</th><th scope="col">ID</th><th scope="col">Lane · tier</th><th scope="col">Leader</th></tr></thead>
                <tbody>{data.ingested.map((row, index) => <tr key={`${row.id}-${row.at}-${index}`}><td><time dateTime={row.at}>{row.at}</time></td><td title={row.title}>{row.id}</td><td>{row.lane} · {row.tier}</td><td>{row.leader}</td></tr>)}</tbody>
              </table></div> : <p className={styles.note}>No ingested jobs recorded.</p>}
              {data.ingest.length ? <ul className={styles.ingest}>{data.ingest.map((row, index) => <li key={`${row.file}-${index}`} data-tone={ingestTone(row)}><span>{row.verb} · {row.file}</span>{row.reason !== null ? <span> · {row.reason}</span> : null}</li>)}</ul> : <p className={styles.note}>No ingest events recorded.</p>}
            </section>
          </>}
  </div>;
}
