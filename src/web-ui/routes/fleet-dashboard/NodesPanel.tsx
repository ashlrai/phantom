import type { buildNodesSnapshot } from '../../../core/nodes/view.js';
import { formatAge } from '../../../core/nodes/age.js';
import { StatusBadge, type Tone } from '../../components/primitives/StatusBadge.js';
import { apiGet } from '../../data/client.js';
import { useQuery, useRefetch } from '../../data/hooks.js';
import type { QueryDef } from '../../data/queries.js';
import { usePollWhileVisible } from '../verse/shell/section-visibility.js';
import panel from './Panel.module.css';
import styles from './NodesPanel.module.css';

type NodesSnapshot = ReturnType<typeof buildNodesSnapshot>;

export const nodesQuery: QueryDef<NodesSnapshot> = {
  key: 'nodes', fetch: signal => apiGet<NodesSnapshot>('/api/nodes', signal),
};

// Node heartbeat states are not run lifecycle words, so the shared
// statusToTone map would render stale and down as neutral. Pin them here.
const NODE_TONE: Record<string, Tone> = { ready: 'success', stale: 'warning', down: 'danger', unknown: 'unknown' };

/**
 * Nodes that joined this fleet. Same projection as `ashlr fleet nodes --json`
 * (src/core/nodes/view.ts), which refuses an inventory holding a secret-shaped
 * value, so no credential reaches this table.
 */
export function NodesPanel() {
  const query = useQuery(nodesQuery);
  const refetch = useRefetch(nodesQuery);
  usePollWhileVisible(refetch, 15_000);
  const snap = query.data;
  return (
    <details className={panel.panel} open data-state-key="fleet-dashboard-nodes">
      <summary className={panel.panelHeader}>
        <span className={panel.panelTitle}>Nodes{snap ? ` (${snap.nodes.length})` : ''}</span>
        {snap ? <span className={styles.leaderNote}>{snap.leaderId ? `Leader: ${snap.leaderId}` : 'No live leader lease'}</span> : null}
      </summary>
      <div className={panel.panelBody}>
        {query.status === 'error' && !snap ? (
          <p role="alert">Nodes unavailable. Run <code>ashlr fleet nodes</code> in a terminal to see why, then reload.</p>
        ) : !snap ? (
          <p role="status">Loading nodes...</p>
        ) : (
          <>
            {snap.nodes.length > 0 ? (
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
                    {snap.nodes.map(n => (
                      <tr key={n.id}>
                        <th scope="row">{n.id}{n.leader ? <span className={styles.leader} title="Holds the fleet lease"> ★ leader</span> : null}</th>
                        <td>{n.role}</td>
                        <td><StatusBadge status={n.status} tone={NODE_TONE[n.status]} /></td>
                        <td>{n.heartbeatAgeMs === null ? 'no heartbeat' : `${formatAge(n.heartbeatAgeMs)} ago`}</td>
                        <td>{n.liveJobs.length}</td>
                        <td>{n.ghAuth}</td>
                        <td>{n.caps.join(', ') || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : snap.error ? null : <p className={panel.emptyState}>No nodes have joined. Run <code>phm node join</code> on a machine to add it.</p>}
            {snap.error ? (
              <p role="alert" className={styles.problem}>
                Node inventory: {snap.error}. Run <code>ashlr fleet nodes</code> to inspect {snap.sourcePath}.
              </p>
            ) : null}
          </>
        )}
      </div>
    </details>
  );
}
