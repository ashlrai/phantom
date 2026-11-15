import type { FleetEdges, FleetEdgeEndpoint } from '../../../../core/fleet/fleet-edges.js';
import { ProviderLogo } from '../../../components/primitives/ProviderLogo.js';
import { apiGet } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import styles from './agent-edges.module.css';

const query: QueryDef<FleetEdges> = { key: 'fleet-edges', fetch: signal => apiGet<FleetEdges>('/api/verse/agent-bus/edges', signal) };
function Endpoint({ endpoint }: { endpoint: FleetEdgeEndpoint }) {
  const provider = endpoint.provider?.toLowerCase();
  const engine = provider === 'anthropic' || provider === 'claude' ? 'claude' : provider === 'openai' || provider === 'codex' ? 'codex' : provider === 'xai' || provider === 'grok' ? 'grok' : provider === 'devin' || provider === 'cognition' ? 'devin' : provider === 'ollama' ? 'local' : null;
  return <span className={styles.endpoint}>{engine && <ProviderLogo engine={engine} />}<strong>{endpoint.address}</strong><small>{endpoint.provider ?? 'Provider unknown'}</small></span>;
}
export function AgentEdges() {
  const result = useQuery(query, { freshMs: 15_000 });
  const data = result.data;
  return <section className={styles.edges} aria-label="Agent messages"><h3>Agent messages</h3>
    <p>Lines show live messages on the local agent bus. Line thickness reflects messages in the last hour. Names and providers are reported labels.</p>
    {!data && !result.error ? <p>Loading agent messages…</p> : result.error || data?.source !== 'available' ? <p role="status">Agent messages unknown.</p> : data.edges?.length ? <ul>{data.edges.map((edge, index) => <li key={`${edge.from.address}:${edge.to.address}:${index}`}><Endpoint endpoint={edge.from} /><span className={styles.line} style={{ borderBottomWidth: Math.min(8, 1 + edge.messagesLastHour) }} aria-label="messaged">→</span><Endpoint endpoint={edge.to} /><small>{edge.messagesLastHour} in the last hour</small></li>)}</ul> : <p>No live agent messages.</p>}
  </section>;
}
