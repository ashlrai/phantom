import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { memoryGuardCard } from './memory-guard-model.js';
import { memoryGuardQuery } from './memory-guard-query.js';
import styles from './fleet-host.module.css';

export function MemoryGuardCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(memoryGuardQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 0 });
  const refetch = useRefetch(memoryGuardQuery);
  usePollWhileVisible(refetch, 5_000, { enabled: visible, refreshOnShow: false });
  const card = memoryGuardCard(read.data?.memory);
  if (!card) return null;
  return <section className={styles.section} aria-label="Memory guard">
    <h3 className={styles.title}>Memory guard</h3>
    {read.status === 'error' ? <p className={styles.muted} role="status">Memory guard could not refresh. Showing the last reading.</p> : null}
    {card.staleText ? <p className={styles.banner} role="status">{card.staleText}</p> : null}
    <p className={styles.metric} data-tone={card.tone}>{card.lines[0]}</p>
    <ul>{card.lines.slice(1).map((line) => <li className={styles.line} key={line}>{line}</li>)}</ul>
    {read.data?.memory.resource_session ? <div>
      <p className={styles.muted}>Session observation: {read.data.memory.resource_session.state}
        {read.data.memory.resource_session.age_ms === null ? '' : read.data.memory.resource_session.age_ms < 0 ? ' · clock is ahead; measurements unavailable' : ` · ${Math.round(read.data.memory.resource_session.age_ms / 1000)}s old`}
        {' · '}pressure {read.data.memory.resource_session.pressure} · census {read.data.memory.resource_session.censusState} · sessions {read.data.memory.resource_session.sessionsState}</p>
      <p className={styles.muted}>Worktree allocated footprint: {read.data.memory.resource_session.disk.state === 'unknown' ? 'unknown' :
        `${(read.data.memory.resource_session.disk.allocatedBytes! / 1048576).toFixed(1)} MiB · ${read.data.memory.resource_session.disk.state} · ${Math.round(read.data.memory.resource_session.disk.ageSeconds!)}s old · ${read.data.memory.resource_session.disk.provenance}`}</p>
      <p className={styles.muted}>CPU is the OS-reported average (100% = one core); host share is normalized by logical cores. RSS sums resident pages, including shared pages. Per-process swap is unknown.</p>
      {read.data.memory.resource_session.sessions.length === 0 ? <p className={styles.muted}>{read.data.memory.resource_session.state === 'fresh' && read.data.memory.resource_session.sessionsState === 'known' ? 'Session measurements: none (verified empty)' : 'Session measurements: unknown'}</p> :
        <ul aria-label="Session measurements">{read.data.memory.resource_session.sessions.map((row) =>
          <li className={styles.line} key={row.jobId}>{row.jobId}: {row.state === 'unknown' ? 'unknown' :
            `${row.processCount} processes · ${(row.rssBytes! / 1048576).toFixed(1)} MiB RSS · ${row.cpuPercentOneCore!.toFixed(1)}% CPU (one-core) · ${row.cpuPercentHost === null ? 'unknown' : `${row.cpuPercentHost.toFixed(1)}%`} host`}</li>)}</ul>}
    </div> : null}
    {card.stoppedJobs === null ? <p className={styles.muted}>Stopped workers: unknown</p>
      : card.stoppedJobs.length === 0 ? <p className={styles.muted}>Stopped workers: none</p>
      : <ul aria-label="Stopped workers">{card.stoppedJobs.map((id) =>
        <li className={styles.line} data-tone="warn" key={id}>{id}</li>)}</ul>}
  </section>;
}
