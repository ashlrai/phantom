/**
 * Home's Machines card, on the desktop and the phone: the joined Macs as one pool, this Mac first.
 * Built only on the `phm nodes pool --json` report (phantom.nodes-pool.v1). Read-only: no button.
 */
import { NODES_POOL_SCHEMA, poolParts, type NodesPool, type PoolNode } from '../../../../core/fleet/nodes-pool.js';
import { apiGet, ApiError } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import styles from './machines-card.module.css';

export const NODES_POOL_PATH = '/api/verse/fleet/control/nodes-pool';
const MAX_NODES = 32;
const STATUSES = ['online', 'offline', 'unknown'];
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const measured = (v: unknown) => v === 'unknown' || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 160;

/** Accepts only a well-formed phantom.nodes-pool.v1 report; anything else (an older server, another payload) is no reading. */
export function narrowNodesPool(raw: unknown): NodesPool | null {
  if (!object(raw) || raw.schema !== NODES_POOL_SCHEMA || raw.schemaVersion !== 1 || !Array.isArray(raw.nodes) || raw.nodes.length > MAX_NODES
    || !object(raw.total) || !text(raw.total.line) || !Array.isArray(raw.reasons)) return null;
  for (const row of raw.nodes as unknown[]) {
    if (!object(row) || !text(row.name) || !text(row.state) || !STATUSES.includes(row.status as string) || !['on', 'off', 'unknown'].includes(row.offload as string)
      || !measured(row.freeSlots) || !measured(row.load) || !measured(row.freeMemoryBytes) || !measured(row.freeDiskGb) || typeof row.lastSeen !== 'string'
      || !(row.jobsRunning === 'unknown' || (Array.isArray(row.jobsRunning) && row.jobsRunning.length <= 500 && row.jobsRunning.every(text)))) return null;
  }
  return raw as unknown as NodesPool;
}

export const nodesPoolQuery: QueryDef<NodesPool | null> = {
  key: 'verse-fleet-nodes-pool',
  async fetch(signal) {
    try { return narrowNodesPool(await apiGet<unknown>(NODES_POOL_PATH, signal)); }
    catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
  },
};

const Mac = ({ node, asOf }: { node: PoolNode; asOf: string }) => <li className={styles.mac}>
  <span className={styles.name}>{node.name}{node.isSelf ? ' (this Mac)' : ''}</span>
  <span className={styles.status} data-status={node.status}>{node.status}</span>
  <span className={styles.facts}>{poolParts(node, asOf).join(' · ')}</span>
</li>;

export function MachinesCard({ visible = true, className = '' }: { visible?: boolean; className?: string }) {
  const read = useQuery(nodesPoolQuery, { enabled: visible, freshMs: 0 });
  const refresh = useRefetch(nodesPoolQuery);
  usePollWhileVisible(refresh, 30_000, { enabled: visible });
  const pool = narrowNodesPool(read.data);
  // Before the first read, or on an older server, the card stays hidden.
  if (!pool) return null;
  return <section className={`${styles.card} ${className}`} aria-label="Machines">
    <h3 className={styles.title}>Machines</h3>
    {read.status === 'error' ? <p className={styles.muted} role="status">Machines could not refresh. Showing the last reading.</p> : null}
    <p className={styles.line}>{pool.total.line}</p>
    {pool.nodes.length ? <ul className={styles.macs}>{pool.nodes.map(node => <Mac key={node.name} node={node} asOf={pool.asOf} />)}</ul>
      : <p className={styles.muted}>No Macs known. Run <code>phm node join</code> on each Mac.</p>}
    <p className={styles.muted}>Same for agents: <code>phm nodes pool --json</code></p>
  </section>;
}
