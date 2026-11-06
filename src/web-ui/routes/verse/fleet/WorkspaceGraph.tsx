import { useId, useState } from 'react';
import type { WorkspaceGraphV1 } from './workspace-graph.js';
import styles from './workspace-graph.module.css';

const NODE_LIMIT = 80;
const EDGE_LIMIT = 160;

export function WorkspaceGraph({ graph, onSelect }: { graph: WorkspaceGraphV1; onSelect?: (id: string | null) => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const select = (id: string) => {
    const next = onSelect && selectedId === id ? null : id;
    if (next !== selectedId) { setSelectedId(next); onSelect?.(next); }
  };
  const marker = useId();
  const nodes = graph.nodes.slice(0, NODE_LIMIT);
  const positions = new Map(nodes.map((node, index) => [node.id, { x: node.kind === 'repository' ? 16 : 340, y: index * 64 + 24 }]));
  const edges = graph.edges.filter(edge => positions.has(edge.from) && positions.has(edge.to)).slice(0, EDGE_LIMIT);
  const selected = graph.nodes.find(node => node.id === selectedId);
  return <section aria-label="Agent workspace control room" className={styles.room}>
    <h3>Workspace graph</h3>
    <p>{graph.state} · <time dateTime={graph.observedAt}>{graph.observedAt}</time></p>
    <p>Repository membership and recorded run states. Lines show membership, not execution order.</p>
    {nodes.length ? <div className={styles.viewport} tabIndex={0} role="region" aria-label="Workspace graph diagram">
      <svg width="660" height={nodes.length * 64 + 40} role="group" aria-label="Nodes and membership edges">
        <defs><marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="currentColor" /></marker></defs>
        {edges.map(edge => {
          const from = positions.get(edge.from)!; const to = positions.get(edge.to)!;
          return <path role="img" aria-label={`${edge.kind}: ${edge.from} → ${edge.to}`} key={edge.id} d={`M ${from.x + 280} ${from.y + 22} L ${to.x} ${to.y + 22}`} stroke="currentColor" markerEnd={`url(#${marker})`}><title>{edge.kind}: {edge.from} → {edge.to}</title></path>;
        })}
        {nodes.map(node => {
          const position = positions.get(node.id)!;
          return <g key={node.id} transform={`translate(${position.x},${position.y})`}>
            <foreignObject width="280" height="54"><button className={styles.node} type="button" aria-label={`Inspect workspace node ${node.id}`} aria-pressed={selectedId === node.id} onClick={() => select(node.id)}>
              <strong>{node.label}</strong><span>{node.kind} · {node.state}</span>
            </button></foreignObject>
          </g>;
        })}
      </svg>
    </div> : <p>No recorded workspace nodes.</p>}
    {nodes.length < graph.nodes.length || edges.length < graph.edges.length ? <p role="status">Diagram shows {nodes.length} of {graph.nodes.length} nodes and {edges.length} of {graph.edges.length} edges.</p> : null}
    <aside aria-label="Selected workspace node">{selected ? <p>{selected.label} · {selected.state}</p> : <p>{selectedId ? 'This node is no longer in the current snapshot.' : 'Select a node to inspect its state.'}</p>}</aside>
    <h4>Attention inbox</h4>
    <p>Recorded run holds; agent messages are not provided by this source.</p>
    {graph.inbox.length ? <ul>{graph.inbox.slice(0, NODE_LIMIT).map(item => <li key={item.id}>
      <button type="button" aria-label={`Inspect inbox node ${item.nodeId}`} onClick={() => select(item.nodeId)}>{graph.nodes.find(node => node.id === item.nodeId)?.label ?? item.nodeId}</button>: {item.message}
      {item.nextEligibleAt ? <span> · Next eligible: <time dateTime={item.nextEligibleAt}>{item.nextEligibleAt}</time></span> : null}
    </li>)}</ul> : <p>No recorded holds in this snapshot.</p>}
    {graph.inbox.length > NODE_LIMIT ? <p>Showing {NODE_LIMIT} of {graph.inbox.length} inbox items.</p> : null}
  </section>;
}
