/**
 * The Map pane: the whole fleet on one screen (`phm map`). Leader on top, then
 * lanes with their provider logo, running jobs, computers and pools. A line
 * pulses when a message crossed it in the last minute and is thicker the more
 * messages it carried. Select any node to open the pane that already shows its
 * details, or a message line to open its last 20 messages in the Messages pane.
 * A thicker line over a pair that talked in a thread in the last 10 minutes (thicker with more messages) carries a marker
 * when a reply is awaited; selecting it opens that thread in the Conversations panel beside the map (`phm agents conversations`).
 * Hovering a message line (or its row in the list) shows a card of its last 5
 * messages (`phm agents messages`). The Messages switch hides every message
 * line; reduced motion keeps the lines but stops the pulse.
 *
 * One 2D/3D toggle switches to the same graph stacked as rings by org level (MapStage3D); the choice is
 * remembered. Phones always get the 2D rows.
 */
import { messageLineWidth, type FleetLiveMap, type LiveMapEdge, type LiveMapEdgeKind, type LiveMapNode, type LiveMapNodeKind } from '../../../../core/fleet/live-map.js';
import type { MapEdge } from '../../../../core/fleet/map-edges.js';
import type { AgentsMessagePair } from '../../../../core/fleet/agents-messages.js';
import { useMemo, useState } from 'react';
import { filterLiveMap, MAP_FILTER_EMPTY, type MapFilter } from '../../../../core/fleet/map-filter.js';
import { MapFilterBar } from './MapFilterBar.js';
import { ConversationsPanel } from './ConversationsPanel.js';
import { conversationsQuery, threadLines, type Conversation } from './conversations-model.js';
import { prefersReducedMotion } from '../../../components/charts/motion.js';
import { LaneHealthBadge } from '../../../components/fleet/LaneHealthBadge.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { relativeAt } from '../fleet/bus-feed-model.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { showMessagePair, type MessagePair } from '../fleet-messages/messages-pair.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { edgeOpacity, emptyMap, layoutLiveMap, liveMapQuery, mapEdgesQuery, mapHeadline, messageCurve, messagePairs, messagePairsQuery, MAP_POLL_MS, NODE_H, NODE_W, pulsing, readMapFilter, saveMapFilter } from './map-model.js';
import { useViewport } from '../shell/viewport.js';
import { readMapViewMode, saveMapViewMode, type MapViewMode } from './map3d-model.js';
import { MapStage3D } from './MapStage3D.js';
import { PhoneOrg, type OrgAsk } from './PhoneOrg.js';
import { fleetOrgGroups } from '../../../../core/fleet/org-groups.js';
import { layoutByOrg, orgBoxLabel, readMapLayout, saveMapLayout, type MapLayoutMode } from './org-layout-model.js';
import styles from './fleet-map.module.css';

/** The existing pane that shows each kind's details. */
export const DETAIL_PANE: Readonly<Record<LiveMapNodeKind, string>> = {
  leader: 'leader-thread', lane: 'fleet-lanes', job: 'worker-log', computer: 'fleet-computers', resource: 'fleet-usage',
};
const KIND_WORD: Readonly<Record<LiveMapNodeKind, string>> = { leader: 'leader', lane: 'lane', job: 'job', computer: 'computer', resource: 'pool' };
const nameOf = (node: LiveMapNode) => `Open ${KIND_WORD[node.kind]} ${node.label}: ${node.detail}`;
const VIEW_OPTIONS = [{ value: '2d', label: '2D' }, { value: '3d', label: '3D' }] as const;
const LAYOUT_OPTIONS = [{ value: 'rows', label: 'Rows' }, { value: 'org', label: 'By org' }] as const;
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
  /** `phm agents conversations`: threads for the panel and the thread lines. Null when the bus is unknown; absent while loading. */
  conversations?: Conversation[] | null;
  /** No pulse animation; lines keep their thickness. */
  reducedMotion?: boolean;
  /** Phone layout only: what waits on the owner, pinned on top. */
  asks?: readonly OrgAsk[];
}
export function MapView({ map: full, now, onOpen, edges, onOpenMessages = () => {}, pairs, conversations, reducedMotion = false, asks }: MapViewProps) {
  const [filter, setFilter] = useState<MapFilter>(readMapFilter);
  const map = useMemo(() => filterLiveMap(full, filter), [full, filter]);
  const none = map.filter?.matched === 0;
  const changeFilter = (next: MapFilter) => { setFilter(next); saveMapFilter(next); };
  const filterBar = <MapFilterBar map={full} filter={filter} onChange={changeFilter} />;
  const noMatch = <p className={styles.notice} role="status">{MAP_FILTER_EMPTY}</p>;
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [showMessages, setShowMessages] = useState(true);
  const [hovered, setHovered] = useState<string | null>(null);
  const [chosen, setChosen] = useState<MapViewMode>(readMapViewMode);
  const { compact } = useViewport();
  const [phoneMap, setPhoneMap] = useState(false);
  const [arrangement, setArrangement] = useState<MapLayoutMode>(readMapLayout);
  const mode: MapViewMode = compact ? '2d' : chosen;
  const arrange = (next: MapLayoutMode) => { setArrangement(next); setHovered(null); saveMapLayout(next); };
  const choose = (next: MapViewMode) => { setChosen(next); setHovered(null); saveMapViewMode(next); };
  if (compact && !phoneMap) return <>{filterBar}{none ? noMatch
    : <PhoneOrg groups={fleetOrgGroups(map)} asks={asks} messages={showMessages ? edges : undefined} now={now} onShowMap={() => setPhoneMap(true)}
      onOpenJob={job => { const node = map.nodes.find(row => row.kind === 'job' && row.label === job); if (node) onOpen(node); }} />}</>;
  const orgLayout = arrangement === 'org' ? layoutByOrg(map) : null;
  const layout = orgLayout ?? layoutLiveMap(map);
  const pulse = (edge: LiveMapEdge) => pulsing(edge, map, now, reducedMotion) ? 'true' : undefined;
  const counts = showMessages ? messagePairs(map) : [];
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
  const threads = showMessages && mode === '2d' ? threadLines(conversations ?? null, now, new Set(layout.at.keys())) : [];
  return <div className={styles.withPanel}><section className={styles.root} aria-label="Fleet map">
    <div className={styles.toolbar} role="toolbar" aria-label="Map">
      <p className={styles.headline}>{mapHeadline(map)}</p>
      {compact && <button type="button" onClick={() => setPhoneMap(false)}>Back to the list</button>}
      {!compact && <Segmented<MapViewMode> options={VIEW_OPTIONS} value={mode} onChange={choose} size="sm" aria-label="Map view" />}
      {mode === '2d' && <Segmented<MapLayoutMode> options={LAYOUT_OPTIONS} value={arrangement} onChange={arrange} size="sm" aria-label="Map layout" />}
      <button type="button" aria-pressed={showMessages} onClick={() => { setShowMessages(on => !on); setHovered(null); }}>Messages</button>
    </div>
    <p className={styles.notice}>Map as of {Number.isFinite(Date.parse(map.generatedAt)) ? <time dateTime={map.generatedAt}>{map.generatedAt}</time> : 'unknown'}.</p>
    {filterBar}
    {emptyMap(map) && !none && <p className={styles.notice} role="status">Nothing to map yet: no lanes, jobs or computers reported.</p>}
    {none ? noMatch : mode === '3d' ? <MapStage3D map={map} now={now} onOpen={onOpen} onOpenEdge={edge => onOpenMessages(pairOf(edge))} nameOf={nameOf}
      showMessages={showMessages} reducedMotion={reducedMotion} onHover={setHovered} cardEdge={card}
      card={card ? <MessageCard edge={card} pair={pairs?.get(`${card.from}->${card.to}`)} layout={layout} now={now} title={`${label(card.from)} → ${label(card.to)}`} anchored /> : null} />
      : <div className={styles.scroll}>
      <div className={styles.canvas} style={{ width: layout.width, height: layout.height }}>
        {orgLayout?.boxes.map(box => <div key={box.id} className={styles.group} data-org-group={box.id}
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}><span>{orgBoxLabel(box)}</span></div>)}
        {layout.groups?.map(box => <div key={box.id} className={styles.group} data-map-group={box.id} role="group" aria-label={box.label}
          style={{ left: box.x, top: box.y, width: box.width, height: box.height }}><span>{box.label}</span></div>)}
        <svg className={styles.edges} width={layout.width} height={layout.height} aria-hidden="true">
          {map.edges.map(edge => {
            const a = layout.at.get(edge.from), b = layout.at.get(edge.to);
            const message = edge.kind === 'messaged-in-last-15-min';
            if (!a || !b || (message && !showMessages)) return null;
            const d = message ? messageCurve(a, b).d : `M${a.x},${a.y} L${b.x},${b.y}`;
            if (!message) return <path key={edge.id} d={d} className={styles.edge} data-kind={edge.kind} />;
            return <g key={edge.id}>
              <path d={d} className={styles.edge} data-kind={edge.kind} data-pulse={pulse(edge)} style={{ strokeWidth: messageLineWidth(edge.messages), opacity: edgeOpacity(edge, map, now) }} />
              <path d={d} className={styles.hit} data-open-messages={edge.id} onClick={() => onOpenMessages(pairOf(edge))} {...hover(edge)} />
            </g>;
          })}
        </svg>
        {threads.length > 0 && <svg className={styles.edges} width={layout.width} height={layout.height} aria-label="Thread lines">
          {threads.map(line => {
            const a = layout.at.get(line.a), b = layout.at.get(line.b);
            if (!a || !b) return null;
            const chosen = line.threadId === selectedThread;
            return <g key={line.key}>
              <path d={messageCurve(a, b).d} className={styles.threadLine} data-thread-line={line.key} data-selected={chosen ? 'true' : undefined} style={{ strokeWidth: messageLineWidth(line.count) + 1 }} />
              <path d={messageCurve(a, b).d} className={styles.hit} onClick={() => setSelectedThread(line.threadId)}><title>{label(line.a)} and {label(line.b)}: {line.count} message{line.count === 1 ? '' : 's'}. Open thread</title></path>
            </g>;
          })}
        </svg>}
        {threads.filter(line => line.waiting).map(line => {
          const a = layout.at.get(line.a), b = layout.at.get(line.b);
          if (!a || !b) return null;
          const { mid } = messageCurve(a, b);
          return <button key={line.key} type="button" className={styles.waiting} style={{ left: mid.x, top: mid.y - 16 }} data-waiting-line={line.key}
            aria-label={`Waiting for a reply between ${label(line.a)} and ${label(line.b)}. Open thread`} onClick={() => setSelectedThread(line.threadId)}>…</button>;
        })}
        {counts.map(pair => {
          const a = layout.at.get(pair.edge.from), b = layout.at.get(pair.edge.to);
          if (!a || !b) return null;
          const { mid } = messageCurve(a, b);
          const words = pair.count === null ? 'an unknown number of messages' : `${pair.count} message${pair.count === 1 ? '' : 's'}`;
          return <button key={pair.key} type="button" className={styles.count} style={{ left: mid.x, top: mid.y }}
            aria-label={`Show ${words} between ${label(pair.edge.from)} and ${label(pair.edge.to)}`}
            onClick={() => onOpenMessages(pairOf(pair.edge))}>{pair.count ?? '?'}</button>;
        })}
        {card && <MessageCard edge={card} pair={pairs?.get(`${card.from}->${card.to}`)} layout={layout} now={now} title={`${label(card.from)} → ${label(card.to)}`} />}
        {layout.nodes.map(node => <button key={node.id} type="button" className={styles.node} data-kind={node.kind} data-status={node.status}
          style={{ left: node.x - NODE_W / 2, top: node.y - NODE_H / 2, width: NODE_W, height: NODE_H }}
          aria-label={nameOf(node)} title={node.detail} onClick={() => onOpen(node)}>
          <span className={styles.name}>
            {(node.kind === 'lane' || node.kind === 'job') && <ProviderBadge of={node.provider} iconOnly size={node.kind === 'lane' ? 16 : 12} />}
            {node.live && <span className={styles.live} role="img" aria-label="Active in the last 5 minutes" />}
            <strong>{node.label}</strong>
            {node.kind === 'lane' && <LaneHealthBadge health={node.health} />}
          </span>
          <small>{node.detail}</small>
        </button>)}
      </div>
    </div>}
    <ul className={styles.legend} aria-label="Line key">
      {LEGEND.filter(([kind]) => showMessages || kind !== 'messaged-in-last-15-min').map(([kind, word]) => <li key={kind}><span className={styles.swatch} data-kind={kind} />{word}</li>)}
      {showMessages && !reducedMotion && <li><span className={styles.swatch} data-kind="messaged-in-last-15-min" data-pulse="true" />message in the last minute</li>}
    </ul>
    {showMessages && !none && <section aria-label="Messages on the map">
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
  </section>
    <ConversationsPanel conversations={conversations} now={now} selectedId={selectedThread} onSelect={setSelectedThread} />
  </div>;
}

/** A message line's last 5 messages, beside the middle of the line. */
function MessageCard({ edge, pair, layout, now, title, anchored = false }: { edge: LiveMapEdge; pair: AgentsMessagePair | undefined;
  layout: ReturnType<typeof layoutLiveMap>; now: number; title: string; anchored?: boolean }) {
  const a = layout.at.get(edge.from), b = layout.at.get(edge.to);
  const left = a && b ? Math.min((a.x + b.x) / 2, layout.width - 240) : 0, top = a && b ? (a.y + b.y) / 2 : 0;
  return <div className={styles.card} role="tooltip" aria-label={`Last messages ${title}`} style={{ left: anchored ? 0 : Math.max(0, left), top: anchored ? 0 : top }}>
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
  const threads = useQuery(conversationsQuery, { enabled: visible, freshMs: MAP_POLL_MS });
  const refetchThreads = useRefetch(conversationsQuery);
  usePollWhileVisible(() => { refetch(); refetchEdges(); refetchPairs(); refetchThreads(); }, MAP_POLL_MS, { enabled: visible });
  const openMessages = (pair: MessagePair) => { showMessagePair(pair); host.openPane('fleet-messages'); };
  const open = (node: LiveMapNode) => {
    if (node.kind === 'job') requestWorkerLogJob(node.label);
    host.openPane(DETAIL_PANE[node.kind]);
  };
  if (read.data === undefined && !read.error) return <div className={styles.root} role="status">Reading the fleet…</div>;
  if (!read.data) return <div className={styles.root}><p className={styles.notice} role="status">Map unavailable right now. It retries every few seconds.</p></div>;
  return <>
    {read.error && <p className={styles.notice} role="status">Refresh failed; showing the last map, which may be stale.</p>}
    <p className={styles.notice}>Message summaries as of {edges.updatedAt === null ? 'unknown' : <time dateTime={new Date(edges.updatedAt).toISOString()}>{new Date(edges.updatedAt).toISOString()}</time>}
      {edges.error ? ' · refresh failed; cached summaries may be stale' : ''}. Message cards as of {pairs.updatedAt === null ? 'unknown' : <time dateTime={new Date(pairs.updatedAt).toISOString()}>{new Date(pairs.updatedAt).toISOString()}</time>}
      {pairs.error ? ' · refresh failed; cached cards may be stale' : ''}.</p>
    <MapView map={read.data} now={Date.now()} onOpen={open} edges={edges.data} onOpenMessages={openMessages}
      pairs={pairs.data} conversations={threads.data} reducedMotion={prefersReducedMotion()} />
  </>;
}
