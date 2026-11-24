import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import styles from '../fleet-host/fleet-host.module.css';

export interface NodeReachItem { label: string; role: string; lastSeenIso: string | null; state: 'reachable' | 'stale' | 'unknown' }

const STATES: readonly string[] = ['reachable', 'stale', 'unknown'];
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Malformed rows are dropped; a bad state or time becomes unknown, never offline. */
export function narrowNodes(raw: unknown): NodeReachItem[] {
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) return [];
  return raw.nodes.slice(0, 32).flatMap((r): NodeReachItem[] => {
    if (!isRecord(r) || typeof r.label !== 'string' || r.label === '') return [];
    const state = typeof r.state === 'string' && STATES.includes(r.state) ? r.state as NodeReachItem['state'] : 'unknown';
    const t = typeof r.lastSeenIso === 'string' && Number.isFinite(Date.parse(r.lastSeenIso)) ? r.lastSeenIso : null;
    return [{ label: r.label.slice(0, 64), role: typeof r.role === 'string' ? r.role.slice(0, 16) : 'worker', lastSeenIso: t, state: t ? state : 'unknown' }];
  });
}

const nodeReachQuery: QueryDef<NodeReachItem[]> = {
  key: 'verse-fleet-node-reach',
  async fetch(signal) { return narrowNodes(await apiGet<unknown>('/api/verse/fleet/runtime-identity', signal)); },
};

/** "seen 3m ago" or "no heartbeat yet"; `now` is injectable for tests. */
export function asOfText(iso: string | null, now: number): string {
  if (!iso) return 'no heartbeat yet';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `seen ${s}s ago` : s < 3600 ? `seen ${Math.floor(s / 60)}m ago` : `seen ${Math.floor(s / 3600)}h ago`;
}

export function NodeReachRows({ nodes, now }: { nodes: NodeReachItem[]; now: number }) {
  if (!nodes.length) return null;
  return <ul className={styles.switches} aria-label="Fleet computers">
    {nodes.map((n) => <li key={n.label}>
      <span>{n.label} ({n.role})</span>{' '}
      <span className={styles.badge} data-tone={n.state === 'reachable' ? undefined : 'warn'}>{n.state}</span>{' '}
      <span className={styles.muted}>{asOfText(n.lastSeenIso, now)}</span>
    </li>)}
  </ul>;
}

export function NodeReachList({ visible }: { visible: boolean }) {
  const refetch = useRefetch(nodeReachQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  const read = useQuery(nodeReachQuery, { enabled: visible, freshMs: 30_000 });
  return <NodeReachRows nodes={read.status === 'error' ? [] : read.data ?? []} now={Date.now()} />;
}
