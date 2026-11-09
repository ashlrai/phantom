import { useEffect } from 'react';
import type { NodesSnapshot } from '../../../core/nodes/view.js';
import { formatAge } from '../../../core/nodes/age.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { apiGet } from '../../data/client.js';
import { useQuery, useRefetch } from '../../data/hooks.js';
import type { QueryDef } from '../../data/queries.js';
import panel from './Panel.module.css';
import styles from './NodesPanel.module.css';

export const nodesQuery: QueryDef<NodesSnapshot> = {
  key: 'nodes', fetch: (signal) => apiGet<NodesSnapshot>('/api/nodes', signal),
};

/** Nodes that joined this fleet. Same projection as `phm nodes --json`; no credentials are ever in it. */
export function NodesPanel() {
  const query = useQuery(nodesQuery);
  const refetch = useRefetch(nodesQuery);
  useEffect(() => {
    const timer = window.setInterval(refetch, 15_000);
    return () => window.clearInterval(timer);
  }, [refetch]);
  const snap = query.data;
  return (
    <details className={panel.panel} open data-state-key="fleet-dashboard-nodes">
      <summary className={panel.panelHeader}>
        <span className={panel.panelTitle}>Nodes{snap ? ` (${snap.nodes.length})` : ''}</span>
        {snap ? <span className={styles.leaderNote}>{snap.leaderId ? `Leader: ${snap.leaderId}` : 'No live leader lease'}</span> : null}
      </summary>
      <div className={panel.panelBody}>
        {query.status === 'error' && !snap ? (
          <p role="alert">Nodes unavailable. Run <code>phm nodes</code> in a terminal to see why, then reload.</p>
        ) : !snap ? (
          <p role="status">Loading nodes...</p>
        ) : (
          <>
            <div className={styles.scroll}>
              <table className={styles.table}>
                <caption className={styles.caption}>Nodes, heartbeat age and live jobs</caption>
                <thead>
                  <tr>
                    <th scope="col">Node</th><th scope="col">Role</th><th scope="col">Status</th>
                    <th scope="col">Heartbeat</th><th scope="col">Live jobs</th><th scope="col">gh auth</th><th scope="col">Caps</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.nodes.map((n) => (
                    <tr key={n.id}>
                      <th scope="row">{n.id}{n.leader ? <span className={styles.leader} title="Holds the fleet lease"> ★ leader</span> : null}</th>
                      <td>{n.role}</td>
                      <td><StatusBadge status={n.status} /></td>
                      <td>{n.heartbeatAgeMs === null ? 'no heartbeat' : `${formatAge(n.heartbeatAgeMs)} ago`}</td>
                      <td>{n.liveJobs.length}</td>
                      <td>{n.ghAuth}</td>
                      <td>{n.caps.join(', ') || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {snap.problems.map((p) => (
              <p key={p.file} role="alert" className={styles.problem}>{p.file}: {p.problem}. Fix: {p.fix}</p>
            ))}
          </>
        )}
      </div>
    </details>
  );
}
