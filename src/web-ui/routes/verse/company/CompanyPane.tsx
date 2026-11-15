import { useId, type ReactNode } from 'react';
import { fleetLanesQuery, fleetSessionsQuery, queueStatsQuery, type QueryDef } from '../../../data/queries.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { nodesQuery } from '../../fleet-dashboard/NodesPanel.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { openDockPane } from '../dock/dock-store.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { missionQuery } from '../fleet-mission/mission-queries.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { readMerges } from '../fleet-observe/observe-model.js';
import { channelHealthQuery } from '../fleet-channels/channel-health-query.js';
import { narrowChannelHealth } from '../fleet-channels/channel-health-model.js';
import { workBoardQuery } from '../fleet-board/work-board-section.js';
import { agentBusStatusQuery } from '../fleet-bus/agent-bus-queries.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { hourOutcomes, lanePresence, queueFlow, recordedAt, shown, usedFraction } from './company-model.js';
import styles from './company.module.css';

const flowQuery = queueStatsQuery(3600);

/** Each source owns its loading, empty and error states; a failed read cannot hide its neighbours. */
function Panel<T>({ title, query, enabled, children }: {
  title: string; query: QueryDef<T>; enabled: boolean; children: (data: NonNullable<T>) => ReactNode;
}) {
  const id = useId();
  const read = useQuery(query, { enabled });
  const refresh = useRefetch(query);
  usePollWhileVisible(refresh, 15_000, { enabled });
  const data = read.data;
  const at = data && typeof data === 'object' && 'generatedAt' in data ? data.generatedAt
    : data && typeof data === 'object' && 'asOf' in data ? data.asOf : null;
  return <section className={styles.panel} aria-labelledby={id}>
    <header><h3 id={id}>{title}</h3><button type="button" disabled={!enabled} onClick={refresh} aria-label={`Refresh ${title}`}>Refresh</button></header>
    {read.status === 'error' && <p role="alert">{title} unavailable.{data != null ? ' Showing the last reading; it may be stale.' : ' Retry with Refresh.'}</p>}
    {data === undefined ? read.status !== 'error' && <div role="status">Loading {title}…<SkeletonLine /></div>
      : data === null ? <p>No {title.toLowerCase()} reading available on this server.</p>
        : <><small>{recordedAt(at)}</small>{children(data)}</>}
  </section>;
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

export function CompanyPane({ visible, host }: PaneProps) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const enabled = visible && sectionVisible && documentVisible;
  const sessions = useQuery(fleetSessionsQuery, { enabled });
  const open = (pane: string) => { if (host) host.openPane(pane); else openDockPane(pane); };
  const jobLink = (job: string) => <button type="button" onClick={() => { requestWorkerLogJob(job); open('worker-log'); }}>{job}</button>;

  return <div className={styles.company}>
    <header className={styles.heading}><div><span className={styles.eyebrow}>Phantom · Company</span><h2>One company. Shared progress.</h2></div>
      <nav aria-label="Company details">{[['fleet-mission', 'Mission'], ['fleet-queue', 'Queue'], ['fleet-observe', 'Sessions'], ['fleet-merges', 'PRs'], ['fleet-bus', 'Agent bus']].map(([pane, label]) =>
        <button type="button" key={pane} onClick={() => open(pane!)}>{label}</button>)}</nav>
    </header>

    <Panel title="Leader line" query={missionQuery} enabled={enabled}>{data => <>
      <p className={styles.verdict} data-health={data.overview.health}>{data.overview.headline || 'Fleet health unknown.'}</p>
      <p>Recorded health: {data.overview.health}. {data.overview.attention}</p>
      <h4>Shared goal</h4><p>{data.plan.title || 'No shared plan recorded.'}</p>
      {data.plan.points.length > 0 && <ul>{data.plan.points.map((point, i) => <li key={i}>{point}</li>)}</ul>}
      <h4>Chief-of-staff brief</h4><p>Not available yet. The recorded mission above remains available while the chief-of-staff brief feed is pending.</p>
    </>}</Panel>

    <div className={styles.grid}>
      <Panel title="Queue flow" query={flowQuery} enabled={enabled}>{data => {
        const flow = queueFlow(data);
        return flow ? <dl className={styles.metrics}><Metric label="READY depth" value={shown(flow.depth)} /><Metric label="Drain / hour" value={flow.drain.toFixed(1)} /></dl>
          : <p>No READY station observations. Queue depth and drain rate are unknown.</p>;
      }}</Panel>
      <Panel title="Jobs" query={fleetSessionsQuery} enabled={enabled}>{data => {
        if (data.schema !== 'fleet.sessions.v1' || !Array.isArray(data.sessions) || !Array.isArray(data.recent) || !data.sources || !data.counts) return <p>Session data unavailable: unsupported response.</p>;
        const outcomes = hourOutcomes(data);
        const partial = outcomes.partial ? '≥ ' : '';
        return <>
          <p>Source: {data.sourceState}{data.truncated ? ' · partial snapshot' : ''}</p>
          <dl className={styles.metrics}>
            <Metric label="Running now" value={data.sourceState === 'healthy' ? `${partial}${shown(data.counts.running)}` : 'unknown'} />
            <Metric label="Finished · last hour" value={`${outcomes.finished === null ? '' : partial}${shown(outcomes.finished)}`} />
            <Metric label="Failed · last hour" value={`${outcomes.failed === null ? '' : partial}${shown(outcomes.failed)}`} />
          </dl>
          {data.sessions.length === 0 ? <p>{data.sourceState === 'healthy' ? 'No active sessions.' : 'Active sessions unknown.'}</p> :
            <details><summary>Sessions by lane ({data.sessions.length})</summary><ul>{data.sessions.map(row => <li key={row.job}>{jobLink(row.job)} · {row.lane ?? 'lane unknown'} · {row.model ?? 'model unknown'} · {row.status}</li>)}</ul></details>}
        </>;
      }}</Panel>
      <Panel title="PR merge velocity" query={opsRunsQuery} enabled={enabled}>{data => <>
        <dl className={styles.metrics}><Metric label="Merged · last hour" value={data.sources.merges === 'healthy' ? shown(data.mergesLastHour.count) : 'unknown'} /></dl>
        <p>Merge source: {data.sources.merges}</p>
        {readMerges(data).length === 0 ? <p>No recorded PR links in this window.</p> : <ul>{readMerges(data).map(pr => <li key={pr.id}>
          {pr.url ? <a href={pr.url} target="_blank" rel="noreferrer">{pr.id}</a> : pr.id} {pr.title}
        </li>)}</ul>}
      </>}</Panel>
      <Panel title="Nodes & heartbeats" query={nodesQuery} enabled={enabled}>{data => {
        if (data.schema !== 'phantom.nodes.v1' || !Array.isArray(data.nodes)) return <p>Node inventory unavailable: unsupported response.</p>;
        return <>{data.error ? <p role="alert">Node inventory unavailable.</p> : data.nodes.length === 0 ? <p>No nodes enrolled. Muse heartbeat unknown until enrolled.</p> :
          <ul>{data.nodes.map(node => <li key={node.id}><strong>{node.id}</strong> · {node.role} · {node.status}
            <p>Heartbeat: {recordedAt(node.heartbeatAt)} · {node.liveJobs.length} live jobs</p>
            {node.liveJobs.map(job => <span key={job}>{jobLink(job)} </span>)}
          </li>)}</ul>}</>;
      }}</Panel>
    </div>

    <Panel title="Agent roster & quota" query={fleetLanesQuery} enabled={enabled}>{data => {
      if (data.schema !== 'fleet.lanes.v1' || !Array.isArray(data.lanes)) return <p>Lane roster unavailable: unsupported response.</p>;
      return <><p>Lane view · Specialist callsigns and memory freshness are not published by this server.</p>
        {sessions.status === 'error' && <p role="alert">Current jobs and last outcomes unavailable; any retained session details may be stale.</p>}
        {!data.lanes.length ? <p>No lanes recorded.</p> : <div className={styles.roster}>{data.lanes.map(lane => {
          const fraction = usedFraction(lane);
          const active = sessions.data?.sessions?.filter(row => row.lane === lane.lane) ?? [];
          const latest = [...(sessions.data?.recent ?? [])].filter(row => row.lane === lane.lane && row.finishedAt)
            .sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!))[0];
          return <article className={styles.card} key={lane.lane} aria-label={lane.lane}>
            <h4>{lane.lane}</h4><p className={styles.presence}>{lanePresence(lane)} · {shown(lane.liveJobs)} live</p>
            <p>{lane.hold?.reason}</p>
            <dl><Metric label="Current jobs" value={active.length ? active.map(row => <div key={row.job}>{jobLink(row.job)} · {row.model ?? 'model unknown'} · {row.status}</div>) : 'No session details recorded'} />
              <Metric label="Last outcome" value={latest ? <>{jobLink(latest.job)} · {latest.outcome ?? 'unknown'} · {recordedAt(latest.finishedAt)}</> : 'unknown'} />
              <Metric label="Memory freshness" value="unknown" />
              <Metric label="Quota used" value={fraction === null ? 'unknown' : `${(fraction * 100).toFixed(1)}% · used_frac ${fraction.toFixed(3)}`} />
              <Metric label="Reset window" value={lane.credit.resetAt ?? 'unknown'} />
            </dl>
            {fraction !== null && <meter min={0} max={1} value={fraction} aria-label={`${lane.lane} quota used`} />}
            <small>{lane.credit.state} · {recordedAt(lane.credit.observedAt)}</small>
          </article>;
        })}</div>}</>;
    }}</Panel>

    <div className={styles.grid}>
      <Panel title="Slack presence" query={channelHealthQuery} enabled={enabled}>{data => {
        const health = narrowChannelHealth(data);
        const slack = health.available ? health.channels.find(row => row.channel === 'slack') : null;
        return slack ? <><p>Slack {slack.state} · host {slack.runtimeHost ?? 'unknown'}</p><p>Last reply: {recordedAt(slack.lastReplyAt)}</p>
          <p>{slack.missing.join(' · ')}</p><p>Bridge health does not establish individual agent membership.</p></> : <p>Slack presence unknown. No bridge health observation.</p>;
      }}</Panel>
      <Panel title="Agent bus" query={agentBusStatusQuery} enabled={enabled}>{data => <>
        <p>Source: {data.source}</p><dl className={styles.metrics}><Metric label="Unexpired messages" value={data.source === 'available' ? shown(data.liveCount) : 'unknown'} /><Metric label="Unread agent messages" value="unknown" /></dl>
        <p>Read cursors are not exposed; retained messages are not unread counts.</p>
      </>}</Panel>
    </div>
    <Panel title="Agent channel map" query={workBoardQuery} enabled={enabled}>{data => {
      if (!Array.isArray(data.items) || data.inbox !== 'ok') return <p>Agent channel assignments unavailable.</p>;
      return <><p>Recorded assignments · live reachability and full Slack membership unknown.{data.truncated ? ' Partial map.' : ''}</p>
        {data.items.length === 0 ? <p>No agent channel assignments recorded.</p> : <ul>{data.items.map(item => <li key={item.id}>
          <strong>{item.owner || 'unassigned'}</strong> · {item.state === 'RUNNING' ? 'working' : item.state === 'BLOCKED' ? 'blocked' : 'status unknown'}
          <p>{item.channel} → {item.channelRef ?? 'channel unknown'} · {item.id} · {item.state}</p>
          <details><summary>Assignment details for {item.owner || 'unassigned'}</summary><p>{recordedAt(item.asOf)} · claim {item.claimReceipt ?? 'unknown'}</p><button type="button" onClick={() => open('fleet-board')}>Open work board</button></details>
        </li>)}</ul>}
        <p>Channel creations awaiting proposal: unknown · no proposal feed available.</p>
      </>;
    }}</Panel>
  </div>;
}
