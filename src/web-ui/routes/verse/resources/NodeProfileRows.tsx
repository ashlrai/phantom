/**
 * Resource-bar rows for fleet nodes that match a declared profile (drive/nodes/profiles.ts).
 * Reads the existing GET /api/nodes snapshot; no new route. A profile host that never joined
 * or stopped heartbeating shows as offline instead of disappearing.
 */
import type { NodeRow } from '../../../../core/nodes/view.js';
import { formatAge } from '../../../../core/nodes/age.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { nodesQuery } from '../../fleet-dashboard/NodesPanel.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { setVerseSection } from '../verse-ui-store.js';
import styles from './NodeProfileRows.module.css';

const POLL_MS = 30_000;

/** Pure: the rows the bar shows (exported for tests). */
export function profileNodeRows(nodes: readonly NodeRow[] | undefined): NodeRow[] {
  return (nodes ?? []).filter((n): n is NodeRow & { profile: NonNullable<NodeRow['profile']> } => !!n.profile);
}

export function nodeRowSummary(n: NodeRow): string {
  const p = n.profile;
  const cap = p ? `${p.ramGb} GB, max ${p.maxCliAgents} agents${p.localModels ? '' : ', no local models'}` : '';
  const beat = n.heartbeatAgeMs === null ? 'no heartbeat' : `heartbeat ${formatAge(n.heartbeatAgeMs)} ago`;
  return `${n.id} ${n.status}${cap ? ` · ${cap}` : ''} · ${beat}`;
}

export function NodeProfileRows({ enabled = true }: { enabled?: boolean }) {
  const query = useQuery(nodesQuery);
  const refetch = useRefetch(nodesQuery);
  usePollWhileVisible(refetch, POLL_MS, { enabled });
  const rows = profileNodeRows(query.data?.nodes);
  if (!enabled || rows.length === 0) return null;
  return (
    <div className={styles.group} data-node-profiles role="group" aria-label="Node resources">
      {rows.map((n) => (
        <button key={n.id} type="button" className={styles.row} data-state={n.status} data-node-id={n.id}
          aria-label={`${nodeRowSummary(n)}. Open fleet nodes`} onClick={() => setVerseSection('fleet')}>
          <span className={styles.line}>
            <span className={styles.name}>{n.profile!.label}</span>
            <span className={styles.state}>{n.status}</span>
          </span>
          <span className={styles.meta}>{nodeRowSummary(n)}</span>
        </button>
      ))}
    </div>
  );
}
