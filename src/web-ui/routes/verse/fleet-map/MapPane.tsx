/**
 * The Map pane: the whole fleet on one screen (`phm map`). Leader on top, then
 * lanes with their provider logo, running jobs, computers and pools. A line
 * pulses when a message crossed it in the last minute and is thicker the more
 * messages it carried. Select any node to open the pane that already shows its
 * details, or a message line to open its last 20 messages in the Messages pane.
 * Hovering a message line (or its row in the list) shows a card of its last 5
 * messages (`phm agents messages`). The Messages switch hides every message
 * line; reduced motion keeps the lines but stops the pulse.
 *
 * 2D only: no 3D library is a dependency, so there is no 3D toggle.
 */
import { messageLineWidth, type FleetLiveMap, type LiveMapEdge, type LiveMapEdgeKind, type LiveMapNode, type LiveMapNodeKind } from '../../../../core/fleet/live-map.js';
import type { MapEdge } from '../../../../core/fleet/map-edges.js';
import type { AgentsMessagePair } from '../../../../core/fleet/agents-messages.js';
import { useState } from 'react';
import { prefersReducedMotion } from '../../../components/charts/motion.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { relativeAt } from '../fleet/bus-feed-model.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { showMessagePair, type MessagePair } from '../fleet-messages/messages-pair.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { emptyMap, layoutLiveMap, liveMapQuery, mapEdgesQuery, mapHeadline, messagePairsQuery, MAP_POLL_MS, NODE_H, NODE_W, pulsing } from './map-model.js';
import styles from './fleet-map.module.css';

/** The existing pane that shows each kind's details. */
export const DETAIL_PANE: Readonly<Record<LiveMapNodeKind, string>> = {
  leader: 'leader-thread', lane: 'fleet-lanes', job: 'worker-log', computer: 'fleet-computers', resource: 'fleet-usage',
};
const KIND_WORD: Readonly<Record<LiveMapNodeKind, string>> = { leader: 'leader', lane: 'lane', job: 'job', computer: 'computer', resource: 'pool' };
const LEGEND: readonly [LiveMapEdgeKind, string][] = [
  ['reports-to', 'reports to'], ['runs-on', 'runs on'], ['uses-resource', 'uses pool'], ['messaged-in-last-15-min', 'messaged'],
];

interface MapViewProps {
  map: FleetLiveMap; now: number; onOpen: (node: LiveMapNode) => void;
  /** `phm map edges`: the last words on each message line. Null or absent when that read is unknown; the lines still draw. */
  edges?: MapEdge[] | null;
  onOpenMessages?: (pair: MessagePair) => void;
  /** `phm agents messages`: count and last 5 summaries per line, keyed `from->to` by node id. Null or absent: the card says unknown. */
  pairs?: Map<string, AgentsMessagePair> | null;
  /** No pulse animation; lines keep their thickness. */
  reducedMotion?: boolean;
}
export function MapView({ map, now, onOpen, edges, onOpenMessages = () => {}, pairs, reducedMotion = false }: MapViewProps) {
  const [showMessages, setShowMessages] = useState(true);
  const [hovered, setHovered] = useState<string | null>(null);
  const layout = layoutLiveMap(map);
  const pulse = (edge: LiveMapEdge) => pulsing(edge, map, now, reducedMotion) ? 'true' : undefined;
  const talk = showMessages ? map.edges.filter(edge => edge.kind === 'messaged-in-last-15-min') : [];
  const hover = (edge: LiveMapEdge) => ({ onMouseEnter: () => setHovered(edge.id), onMouseLeave: () => setHovered(null),
    onFocus: () => setHovered(edge.id), onBlur: () => setHovered(null) });
  const label = (id: string) => layout.at.get(id)?.label ?? 'unknown';
  // Edges arrive newest first, so the first one between two map nodes holds the last words on that line.
  const said = new Map<string, MapEdge>();
  for (const edge of edges ?? []) if (edge.from.node && edge.to.node && !said.has(`${edge.from.node}->${edge.to.node}`)) said.set(`${edge.from.node}->${edge.to.node}`, edge);
  const lastOn = (edge: LiveMapEdge) => said.get(`${edge.from}->${edge.to}`);
  const agent = (id: string) => id === 'leader' ? id : label(id);
  const pairOf = (edge: LiveMapEdge): MessagePair => { const last = lastOn(edge); return last ? [last.from.name, last.to.name] : [agent(edge.from), agent(edge.to)]; };
  const last = (edge: MapEdge) => ` · last ${relativeAt(edge.lastAt, now)}: “${edge.lastSummary}”`;
  // Agents the map does not draw (a numbered worker, an unknown name) still talk: listed, never dropped.
  const drawn = new Set(talk.map(edge => `${edge.from}->${edge.to}`));
  const offMap = showMessages ? (edges ?? []).filter(edge => !drawn.has(`${edge.from.node}->${edge.to.node}`)) : [];
  const card = talk.find(edge => edge.id === hovered);
  return <section className={styles.root} aria-label="Fleet map">
    <div className={styles.toolbar} role="toolbar" aria-label="Map">
      <p className={styles.headline}>{mapHeadline(map)}</p>
      <button type="button" aria-pressed={showMessages} onClick={() => { setShowMessages(on => !on); setHovered(null); }}>Messages</button>
    </div>
    {emptyMap(map) && <p className={styles.notice} role="status">Nothing to map yet: no lanes, jobs or computers reported.</p>}
    <div className={styles.scroll}>
      <div className={styles.canvas} style={{ width: layout.width, height: layout.height }}>
        <svg className={styles.edges} width={layout.width} height={layout.height} aria-hidden="true">
          {map.edges.map(edge => {
            const a = layout.at.get(edge.from), b = layout.at.get(edge.to);
            const message = edge.kind === 'messaged-in-last-15-min';
            if (!a || !b || (message && !showMessages)) return null;
            // Messages bow sideways so they never hide a reporting line between the same two nodes.
            const bend = message ? 40 * (a.x <= b.x ? 1 : -1) : 0;
            const d = `M${a.x},${a.y} Q${(a.x + b.x) / 2 + bend},${(a.y + b.y) / 2 - Math.abs(bend)} ${b.x},${b.y}`;
            if (!message) return <path key={edge.id} d={d} className={styles.edge} data-kind={edge.kind} />;
            return <g key={edge.id}>
              <path d={d} className={styles.edge} data-kind={edge.kind} data-pulse={pulse(edge)} style={{ strokeWidth: messageLineWidth(edge.messages) }} />
              <path d={d} className={styles.hit} data-open-messages={edge.id} onClick={() => onOpenMessages(pairOf(edge))} {...hover(edge)} />
            </g>;
          })}
        </svg>
        {card && <MessageCard edge={card} pair={pairs?.get(`${card.from}->${card.to}`)} layout={layout} now={now} title={`${label(card.from)} → ${label(card.to)}`} />}
        {layout.nodes.map(node => <button key={node.id} type="button" className={styles.node} data-kind={node.kind} data-status={node.status}
          style={{ left: node.x - NODE_W / 2, top: node.y - NODE_H / 2, width: NODE_W, height: NODE_H }}
          aria-label={`Open ${KIND_WORD[node.kind]} ${node.label}: ${node.detail}`} title={node.detail} onClick={() => onOpen(node)}>
          <span className={styles.name}>
            {(node.kind === 'lane' || node.kind === 'job') && <ProviderBadge of={node.provider} iconOnly size={node.kind === 'lane' ? 16 : 12} />}
            {node.live && <span className={styles.live} role="img" aria-label="Active in the last 5 minutes" />}
            <strong>{node.label}</strong>
          </span>
          <small>{node.detail}</small>
        </button>)}
      </div>
    </div>
    <ul className={styles.legend} aria-label="Line key">
      {LEGEND.filter(([kind]) => showMessages || kind !== 'messaged-in-last-15-min').map(([kind, word]) => <li key={kind}><span className={styles.swatch} data-kind={kind} />{word}</li>)}
      {showMessages && !reducedMotion && <li><span className={styles.swatch} data-kind="messaged-in-last-15-min" data-pulse="true" />message in the last minute</li>}
    </ul>
    {showMessages && <section aria-label="Messages on the map">
      {map.counts.messages === null ? <p className={styles.notice}>Messages unknown.</p>
        : talk.length ? <ul className={styles.talk}>{talk.map(edge => <li key={edge.id}>
          <button type="button" title="Open the last 20 messages" data-pulse={pulse(edge)} onClick={() => onOpenMessages(pairOf(edge))} {...hover(edge)}>
            {label(edge.from)} → {label(edge.to)}: {edge.messages ?? 'unknown'} in {map.windowMinutes} min{lastOn(edge) ? last(lastOn(edge)!) : ''}</button></li>)}</ul>
          : <p className={styles.notice}>No messages between agents in the last {map.windowMinutes} minutes.</p>}
      {offMap.length > 0 && <ul className={styles.talk} aria-label="Messages not drawn on the map">{offMap.map(edge => <li key={edge.id}>
        <button type="button" title="Open the last 20 messages" onClick={() => onOpenMessages([edge.from.name, edge.to.name])}>
          {edge.from.name} ({edge.from.role}) → {edge.to.name} ({edge.to.role}): {edge.count}, not drawn{last(edge)}</button></li>)}</ul>}
      {talk.length + offMap.length > 0 && <p className={styles.notice}>Select a line to open its last 20 messages.</p>}
    </section>}
    {map.gaps.length > 0 && <ul className={styles.gaps} aria-label="Unknown">{map.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>}
    <p className={styles.notice}>Same graph for agents: <code>phm map --json</code>, <code>phm map edges --json</code> and <code>phm agents messages --json</code></p>
  </section>;
}

/** A message line's last 5 messages, beside the middle of the line. */
function MessageCard({ edge, pair, layout, now, title }: { edge: LiveMapEdge; pair: AgentsMessagePair | undefined;
  layout: ReturnType<typeof layoutLiveMap>; now: number; title: string }) {
  const a = layout.at.get(edge.from), b = layout.at.get(edge.to);
  const left = a && b ? Math.min((a.x + b.x) / 2, layout.width - 240) : 0, top = a && b ? (a.y + b.y) / 2 : 0;
  return <div className={styles.card} role="tooltip" aria-label={`Last messages ${title}`} style={{ left: Math.max(0, left), top }}>
    <strong>{title}: {pair ? pair.count : edge.messages ?? 'unknown'} message{(pair ? pair.count : edge.messages) === 1 ? '' : 's'}</strong>
    {pair?.recent.length ? <ol>{pair.recent.map((item, i) => <li key={i}>{relativeAt(item.at, now)} · {item.kind}: {item.summary}</li>)}</ol>
      : <p>Last messages unknown.</p>}
  </div>;
}

export function MapPane({ visible, host }: Pick<PaneProps, 'visible' | 'host'>) {
  const read = useQuery(liveMapQuery, { enabled: visible, freshMs: MAP_POLL_MS });
  const refetch = useRefetch(liveMapQuery);
  const edges = useQuery(mapEdgesQuery, { enabled: visible, freshMs: MAP_POLL_MS });
  const refetchEdges = useRefetch(mapEdgesQuery);
  const pairs = useQuery(messagePairsQuery, { enabled: visible, freshMs: MAP_POLL_MS });
  const refetchPairs = useRefetch(messagePairsQuery);
  usePollWhileVisible(() => { refetch(); refetchEdges(); refetchPairs(); }, MAP_POLL_MS, { enabled: visible });
  const openMessages = (pair: MessagePair) => { showMessagePair(pair); host.openPane('fleet-messages'); };
  const open = (node: LiveMapNode) => {
    if (node.kind === 'job') requestWorkerLogJob(node.label);
    host.openPane(DETAIL_PANE[node.kind]);
  };
  if (read.data === undefined && !read.error) return <div className={styles.root} role="status">Reading the fleet…</div>;
  if (!read.data) return <div className={styles.root}><p className={styles.notice} role="status">Map unavailable right now. It retries every few seconds.</p></div>;
  return <>
    {read.error && <p className={styles.notice} role="status">Refresh failed; showing the last map, which may be stale.</p>}
    <MapView map={read.data} now={Date.now()} onOpen={open} edges={edges.data} onOpenMessages={openMessages}
      pairs={pairs.data} reducedMotion={prefersReducedMotion()} />
  </>;
}
