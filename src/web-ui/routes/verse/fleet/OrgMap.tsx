import { useState } from 'react';
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import { fleetOrgMap } from '../../../../core/fleet/org-map.js';
import { fleetOrgTree, orgAgo, orgLaneCounts, orgLaneUsage, orgLive, type OrgTreeJob } from '../../../../core/fleet/org-tree.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { JobDetailSheet } from './JobDetailSheet.js';
import { fleetOrgMapQuery } from './org-map-query.js';
import styles from './org-map.module.css';

/** Green when something happened in the last 5 minutes, hollow when quiet, "?" when no time is known. */
function LiveDot({ live }: { live: boolean | null }) {
  const label = live ? 'Active in the last 5 minutes' : live === false ? 'Quiet for over 5 minutes' : 'Activity unknown';
  return <span className={styles.dot} data-live={live === null ? 'unknown' : String(live)} role="img" aria-label={label} title={label}>{live === null ? '?' : ''}</span>;
}

/** The organization on one screen: leader, a card per lane, a chip per job. Same tree as `phm org`. */
export function OrgMap({ live, now = Date.now() }: { live: FleetLiveSnapshotV1 | null; now?: number }) {
  const visible = useSectionVisible(), documentVisible = useDocumentVisible();
  const read = useQuery(fleetOrgMapQuery, { enabled: visible && documentVisible, freshMs: 0 });
  const refresh = useRefetch(fleetOrgMapQuery);
  usePollWhileVisible(refresh, 15_000);
  const [selected, select] = useState<OrgTreeJob | null>(null);
  const map = read.data ?? fleetOrgMap(live);
  const tree = map.tree ?? fleetOrgTree(map, { engineLanes: live?.lanes });
  const { dispatcher } = tree.leader;
  const anyLive = (jobs: OrgTreeJob[]) => jobs.length ? jobs.some(job => orgLive(job.lastActivityAt, now)) || (jobs.every(job => job.lastActivityAt) ? false : null) : null;
  return <section className={styles.map} aria-labelledby="org-map-title">
    <h2 id="org-map-title">Fleet map</h2>
    <p>The leader, each lane and its running jobs. Select a job to open its details.</p>
    {read.status === 'error' ? <p role="status">Map refresh failed. Showing the last available view; it may be stale.</p> : !read.data ? <p role="status">Loading the full map. Showing available fleet records.</p> : null}
    {map.sources.fleet === 'unknown' && <p>Fleet state unknown.</p>}
    {map.truncated && <p role="status">Partial view: some records are outside this snapshot.</p>}
    <div className={styles.leader}><strong>{tree.leader.label}</strong>
      <small>{tree.leader.status === 'unknown' ? 'Status unknown' : tree.leader.status}</small>
      <small>Dispatcher {dispatcher.paused === null ? 'state unknown' : dispatcher.paused ? 'paused' : 'running'}, last tick {orgAgo(dispatcher.lastTick, now)}</small>
    </div>
    <div className={styles.lanes}>{tree.lanes.map(lane => <section className={styles.lane} key={lane.lane} aria-label={lane.lane}>
      <h3><ProviderBadge of={lane.provider} iconOnly size={18} /> {lane.lane} {lane.jobs.length > 0 && <LiveDot live={anyLive(lane.jobs)} />}</h3>
      <small>{orgLaneCounts(lane)}</small>
      <small>{orgLaneUsage(lane, now)}</small>
      {lane.jobs.length ? <ul>{lane.jobs.map(job => <li key={job.id}><button type="button" className={styles.job} onClick={() => select(job)} aria-label={`Open job ${job.id}`}>
        <strong><LiveDot live={orgLive(job.lastActivityAt, now)} /> {job.id}</strong>
        <span><ProviderBadge of={job.provider} iconOnly /> {job.model ?? 'model unknown'} · {job.repo ?? 'repo unknown'}</span>
        <small>{job.status} · started {orgAgo(job.startedAt, now)} · last event {job.lastEvent ? `${job.lastEvent.kind} ${orgAgo(job.lastEvent.at, now)}` : 'unknown'}</small>
      </button></li>)}</ul> : <p className={styles.idle}>{tree.jobsKnown ? 'idle' : 'jobs unknown'}</p>}
    </section>)}</div>
    <div className={styles.support} aria-label="Guardian and channels">{map.nodes.filter(node => node.kind === 'guardian' || node.kind === 'channel').map(node => <div key={node.id}><strong>{node.label}</strong><small>{node.status}</small></div>)}</div>
    <section aria-label="Agent messages"><h3>Messages in the last {tree.messageWindowMinutes} minutes</h3>
      {tree.messages === null ? <p>Agent messages unknown.</p> : tree.messages.length ? <ul className={styles.messages}>{tree.messages.map(row => <li key={`${row.from}>${row.to}`}>
        <ProviderBadge of={row.from} iconOnly /> {row.from} <span aria-label="sent to" className={styles.line} /> {row.to}: {row.count ?? 'unknown'} messages
      </li>)}</ul> : <p>No messages reported in this window.</p>}
      {tree.unmappedMessages != null && tree.unmappedMessages > 0 && <p>{tree.unmappedMessages} messages could not be matched to this map.</p>}
    </section>
    <p><small>Sessions: {map.sources.sessions}. Messages: {map.sources.messages}. Lane counts: {tree.sources.lanes}. Usage: {tree.sources.usage}. Updated {orgAgo(tree.generatedAt, now)}.</small></p>
    {selected && <JobDetailSheet job={selected.id} repo={selected.repo} onClose={() => select(null)} />}
  </section>;
}
