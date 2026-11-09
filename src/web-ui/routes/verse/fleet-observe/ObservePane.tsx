/**
 * routes/verse/fleet-observe/ObservePane.tsx — the Observe cockpit: every
 * running session across all lanes, the merge ticker, quota gauges, the
 * agent-to-agent feed and incidents in one pane.
 *
 * Real data only: one fleet snapshot, the provider accounts and the durable
 * bus, polled while the pane is on top. Every region is a labelled landmark
 * and every control a named button, so an agent driving the app through the
 * accessibility tree (`phm desktopctl`) reads and operates it the same way a
 * person does.
 */
import { useMemo } from 'react';
import { SkeletonLine, Tag } from '../../../components/primitives/index.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { formatCount, formatDuration, formatRelative } from '../autonomy/format.js';
import { agentBusFeedQuery } from '../fleet-events/agent-bus-feed-query.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { fleetUsageRunsQuery } from '../fleet-usage/fleet-usage-queries.js';
import { formatReset, rowsFromAccounts } from '../fleet-usage/usage-pane-model.js';
import { liveAgeSeconds } from '../fleet/live-age.js';
import { ageText } from '../fleet/workers-card-model.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { usedPercentText } from '../percent-text.js';
import { verseAccountsQuery } from '../usage/usage-queries.js';
import { projectAccountsSnapshot } from '../usage/usage-contract.js';
import { VERSE_AGENT_ROSTER_PATH } from '../../../../core/verse/agent-roster-api.js';
import { ObserveFacts } from './ObserveFacts.js';
import { heldIncidents, readComms, readGauges, readLanes, readMerges, readRoster, readSessions } from './observe-model.js';
import styles from './fleet-observe.module.css';

const POLL_MS = 5_000;
const ROSTER_POLL_MS = 20_000;
const ACCOUNTS_POLL_MS = 60_000;

const agentRosterQuery: QueryDef<unknown> = {
  key: 'verse-fleet-agent-roster',
  fetch: (signal) => apiGet<unknown>(VERSE_AGENT_ROSTER_PATH, signal),
};

export function ObservePane({ visible, host }: PaneProps) {
  const runs = useQuery(fleetUsageRunsQuery, { enabled: visible, freshMs: 0 });
  const accounts = useQuery(verseAccountsQuery, { enabled: visible, freshMs: 0 });
  const bus = useQuery(agentBusFeedQuery, { enabled: visible, freshMs: 0 });
  const rosterQuery = useQuery(agentRosterQuery, { enabled: visible, freshMs: 0 });
  const refetchRuns = useRefetch(fleetUsageRunsQuery);
  const refetchAccounts = useRefetch(verseAccountsQuery);
  const refetchBus = useRefetch(agentBusFeedQuery);
  const refetchRoster = useRefetch(agentRosterQuery);
  usePollWhileVisible(refetchRuns, POLL_MS, { enabled: visible });
  usePollWhileVisible(refetchBus, POLL_MS, { enabled: visible });
  usePollWhileVisible(refetchRoster, ROSTER_POLL_MS, { enabled: visible });
  usePollWhileVisible(refetchAccounts, ACCOUNTS_POLL_MS, { enabled: visible });

  const snapshot = runs.data;
  const nowMs = Date.now();
  const sessions = useMemo(() => readSessions(snapshot), [snapshot]);
  const lanes = useMemo(() => readLanes(snapshot), [snapshot]);
  const merges = useMemo(() => readMerges(snapshot), [snapshot]);
  const gauges = useMemo(() => {
    const read = accounts.data;
    return readGauges(rowsFromAccounts(read?.available ? projectAccountsSnapshot(read.raw) : null));
  }, [accounts.data]);
  const { comms, incidents } = useMemo(() => readComms(bus.data), [bus.data]);
  const roster = useMemo(() => rosterQuery.data === undefined ? null : readRoster(rosterQuery.data), [rosterQuery.data]);
  const generatedAt = snapshot && typeof snapshot === 'object' && 'generatedAt' in snapshot && typeof snapshot.generatedAt === 'string' ? snapshot.generatedAt : null;
  const held = heldIncidents(lanes);

  if (snapshot === null) return <p className={styles.message}>Observe is not in this build</p>;
  if (snapshot === undefined) return <div className={styles.root} role="status">{runs.status === 'error' ? 'The fleet could not be read.' : <><span>Reading the fleet…</span><SkeletonLine /><SkeletonLine /></>}</div>;

  const running = sessions.filter((s) => s.status === 'running').length;
  const openJob = (job: string) => { requestWorkerLogJob(job); host?.openPane('worker-log'); };

  return <section className={styles.root} aria-label="Observe">
    <header className={styles.top}>
      <h2 className={styles.headline}>{running} running · {lanes.length} lanes · {merges.length} merged in the last hour</h2>
      {runs.status === 'error' ? <p className={styles.notice} role="status">Could not refresh. Showing the last reading.</p> : null}
    </header>

    <ObserveFacts visible={visible} />
    <section className={styles.region} aria-label="Sessions">
      <h3 className={styles.title}>Sessions</h3>
      {sessions.length === 0 ? <p className={styles.quiet}>No sessions running.</p> : <table className={styles.table}>
        <thead><tr><th>Job</th><th>Lane</th><th>Status</th><th className={styles.num}>Age</th><th className={styles.num}>ETA</th><th className={styles.num}>Lane tokens/h</th></tr></thead>
        <tbody>{sessions.map((s) => {
          const age = s.ageSeconds === null || generatedAt === null ? s.ageSeconds : liveAgeSeconds(s.ageSeconds, generatedAt, nowMs);
          return <tr key={`${s.lane}:${s.job}`} data-status={s.status} data-age-state={s.ageState}>
            <td><button type="button" className={styles.job} aria-label={`Open log for ${s.job}`} onClick={() => openJob(s.job)}>{s.job}</button><span className={styles.meta}>{s.repo}</span></td>
            <td><Tag title={s.tier}>{s.lane}</Tag></td>
            <td>{s.status}{s.ageState !== 'normal' ? ` · ${s.ageState === 'stuck' ? 'stuck?' : 'long'}` : ''}</td>
            <td className={styles.num}>{age === null ? '—' : ageText(age)}</td>
            <td className={styles.num} title="Typical job length for this lane, minus age">{s.etaMinutes === null ? '—' : `~${s.etaMinutes}m`}</td>
            <td className={styles.num}>{formatCount(s.laneTokensLastHour)}</td>
          </tr>;
        })}</tbody>
      </table>}
    </section>

    <section className={styles.region} aria-label="All agents">
      <h3 className={styles.title}>All agents</h3>
      {roster === null ? <p className={styles.quiet}>{rosterQuery.status === 'error' || rosterQuery.status === 'success' ? 'The agent roster could not be read.' : 'Reading the agent roster.'}</p> : <>
        {roster.rows.length === 0 ? <p className={styles.quiet}>No known sessions.</p> : <table className={styles.table}>
          <thead><tr><th>Provider</th><th>Session</th><th>State</th><th>Owner</th><th className={styles.num}>Claims</th><th>Blockers</th></tr></thead>
          <tbody>{roster.rows.map((row) => <tr key={`${row.provider}:${row.sessionId}`}>
            <td>{row.provider}</td>
            <td>{row.sessionId}{row.title ? <span className={styles.meta}>{row.title}</span> : null}</td>
            <td>{row.state}</td>
            <td>{row.ownership ?? 'unknown'}</td>
            <td className={styles.num}>{row.claims}</td>
            <td>{row.blockers || 'none'}</td>
          </tr>)}</tbody>
        </table>}
        <ul className={styles.list}>{roster.sources.filter((source) => source.availability === 'unknown').map((source) =>
          <li key={source.source} className={styles.row}><span className={styles.text}>{source.source}: unknown. {source.error ?? 'reason unknown'}</span></li>)}</ul>
      </>}
    </section>

    <section className={styles.region} aria-label="Quota">
      <h3 className={styles.title}>Quota</h3>
      {gauges.length === 0 ? <p className={styles.quiet}>No provider readings.</p> : <ul className={styles.list}>{gauges.map((g) =>
        <li key={g.id} className={styles.gauge} data-tone={g.tone}>
          <span className={styles.label}>{g.account} · {g.window}</span>
          <span className={styles.track} role="meter" aria-label={`${g.account} ${g.window} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={g.usedPercent ?? undefined} aria-valuetext={usedPercentText(g.usedPercent)}>
            <span className={styles.fill} style={{ width: `${Math.max(0, Math.min(100, g.usedPercent ?? 0))}%` }} />
          </span>
          <span className={styles.pct}>{usedPercentText(g.usedPercent)}</span>
          <span className={styles.meta}>{g.limitReached ? 'limit reached' : formatReset(g.resetsAt, nowMs)}</span>
        </li>)}</ul>}
    </section>

    <section className={styles.region} aria-label="Merge ticker">
      <h3 className={styles.title}>Merges</h3>
      {merges.length === 0 ? <p className={styles.quiet}>Nothing merged in the last hour.</p> : <ul className={styles.list}>{merges.slice(0, 8).map((m) =>
        <li key={m.id} className={styles.row}>
          <span className={styles.meta}>{m.mergedAt ? formatRelative(m.mergedAt, nowMs) : '—'}</span>
          {m.url ? <a href={m.url} target="_blank" rel="noopener noreferrer">{m.repo} #{m.number}</a> : <span>{m.repo} #{m.number}</span>}
          <span className={styles.text}>{m.title}</span>
        </li>)}</ul>}
    </section>

    <section className={styles.region} aria-label="Agent comms">
      <h3 className={styles.title}>Agent comms</h3>
      {comms.length === 0 ? <p className={styles.quiet}>{bus.data === null || bus.status === 'error' ? 'The bus is not readable.' : 'No agent traffic.'}</p> : <ul className={styles.list}>{comms.slice(0, 12).map((c) =>
        <li key={c.id} className={styles.row}><span className={styles.text}>{c.text}</span></li>)}</ul>}
    </section>

    <section className={styles.region} aria-label="Incidents">
      <h3 className={styles.title}>Incidents</h3>
      {incidents.length + held.length === 0 ? <p className={styles.quiet}>No open incidents.</p> : <ul className={styles.list}>
        {held.map((text) => <li key={text} className={styles.row} data-tone="danger"><span className={styles.text}>{text}</span></li>)}
        {incidents.slice(0, 8).map((i) => <li key={i.id} className={styles.row} data-tone="danger"><span className={styles.text}>{i.text}</span>
          {i.url ? <a href={i.url} target="_blank" rel="noopener noreferrer" aria-label={`GitHub run for ${i.text}`}>Run</a> : null}</li>)}
      </ul>}
    </section>
    {generatedAt ? <p className={styles.meta}>Snapshot {formatDuration(Math.max(0, nowMs - Date.parse(generatedAt)))} old</p> : null}
  </section>;
}
