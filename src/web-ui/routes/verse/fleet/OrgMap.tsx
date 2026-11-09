import type { FleetLiveSnapshotV1 } from '../../../../core/fleet/fleet-types.js';
import { fleetOrgMap } from '../../../../core/fleet/org-map.js';
import styles from './org-map.module.css';
import { AgentEdges } from './AgentEdges.js';

export function OrgMap({ live }: { live: FleetLiveSnapshotV1 | null }) {
  const map = fleetOrgMap(live);
  return <section className={styles.map} aria-labelledby="org-map-title">
    <h2 id="org-map-title">Fleet map</h2>
    <div className={styles.leader}>Leader <small>{map.leader.status ?? 'Unknown'}</small></div>
    {map.lanes === null ? <p>Fleet state unknown.</p> : map.lanes.length === 0 ? <p>No lanes reported.</p> :
      <div className={styles.lanes}>{map.lanes.map(lane => <div className={styles.lane} key={lane.id ?? 'unknown'}>
        <h3><span className={styles.logo} aria-hidden="true">{lane.provider?.[0] ?? '?'}</span> {lane.provider ?? 'Unknown lane'}</h3>
        {lane.jobs.length ? <ul>{lane.jobs.map(job => <li key={job.id}><strong>{job.title ?? job.id}</strong><br /><small>{job.repo ?? 'Unknown repo'} · {job.phase}</small></li>)}</ul> : <p>No running jobs reported.</p>}
      </div>)}</div>}
    <AgentEdges />
  </section>;
}
