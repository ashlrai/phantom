import { useState } from 'react';
import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import { fleetOrgMap, type FleetMapNode } from '../../../../core/fleet/org-map.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { JobDetailSheet } from './JobDetailSheet.js';
import { fleetOrgMapQuery } from './org-map-query.js';
import styles from './org-map.module.css';

export function OrgMap({ live }: { live: FleetLiveSnapshotV1 | null }) {
  const visible = useSectionVisible(), documentVisible = useDocumentVisible();
  const read = useQuery(fleetOrgMapQuery, { enabled: visible && documentVisible, freshMs: 0 });
  const refresh = useRefetch(fleetOrgMapQuery);
  usePollWhileVisible(refresh, 15_000);
  const [selected, select] = useState<FleetMapNode | null>(null);
  const map = read.data ?? fleetOrgMap(live);
  const nodes = new Map(map.nodes.map(node => [node.id, node]));
  const lanes = map.nodes.filter(node => node.kind === 'lane');
  const messages = map.edges.filter(edge => edge.kind === 'message');
  const badge = (node: FleetMapNode) => <small className={styles.logo}><ProviderBadge of={node.provider} /></small>;
  return <section className={styles.map} aria-labelledby="org-map-title">
    <h2 id="org-map-title">Fleet map</h2>
    <p>Leader, lanes and jobs, each with the provider behind it. Select a job to open its details.</p>
    {read.status === 'error' ? <p role="status">Map refresh failed. Showing the last available view; it may be stale.</p> : !read.data ? <p role="status">Loading the full map. Showing available fleet records.</p> : null}
    {map.sources.fleet === 'unknown' && <p>Fleet state unknown.</p>}
    <p>Sessions: {map.sources.sessions}. Messages: {map.sources.messages}. Updated: {map.generatedAt ?? 'unknown'}.</p>
    {map.truncated && <p role="status">Partial view: some records are outside this snapshot.</p>}
    {map.nodes.filter(node => node.kind === 'leader').map(node => <div className={styles.leader} key={node.id}><strong>{node.label}</strong>{badge(node)}<small>{node.status}</small></div>)}
    <div className={styles.lanes}>{lanes.map(lane => {
      const jobs = map.edges.filter(edge => edge.kind === 'reports-to' && edge.to === lane.id).map(edge => nodes.get(edge.from)).filter((node): node is FleetMapNode => node?.kind === 'job');
      return <section className={styles.lane} key={lane.id} aria-label={lane.label}>
        <h3>{lane.label}</h3>{badge(lane)}<small>{lane.status}</small>
        {jobs.length ? <ul>{jobs.map(job => <li key={job.id}><button type="button" className={styles.job} onClick={() => select(job)} aria-label={`Open job ${job.jobId}`}>
          <strong>{job.jobId}</strong><span>{job.label}</span>{badge(job)}<span>{job.model ?? 'unknown'}</span>
          <small>{job.repo ?? 'unknown'} · {job.status} · {job.ageSeconds == null ? 'age unknown' : `${Math.floor(job.ageSeconds / 60)}m old`}</small>
        </button></li>)}</ul> : <p>No jobs reported.</p>}
      </section>;
    })}</div>
    <div className={styles.support} aria-label="Guardian and channels">{map.nodes.filter(node => node.kind === 'guardian' || node.kind === 'channel').map(node => <div key={node.id}><strong>{node.label}</strong>{badge(node)}<small>{node.status}</small></div>)}</div>
    <section aria-label="Agent messages"><h3>Messages in the last {map.messageWindowMinutes} minutes</h3>
      {map.sources.messages !== 'available' ? <p>Agent messages unknown.</p> : messages.length ? <ul className={styles.messages}>{messages.map(edge => <li key={edge.id}>
        <ProviderBadge of={edge.provider} iconOnly /> {nodes.get(edge.from)?.label ?? 'unknown'} <span aria-label="sent to">→</span> {nodes.get(edge.to)?.label ?? 'unknown'}: {edge.count ?? 'unknown'} messages
      </li>)}</ul> : <p>No messages reported in this window.</p>}
      {map.unmappedMessages != null && map.unmappedMessages > 0 && <p>{map.unmappedMessages} messages could not be matched to this map.</p>}
    </section>
    {selected?.jobId && <JobDetailSheet job={selected.jobId} repo={selected.repo} onClose={() => select(null)} />}
  </section>;
}
