/**
 * The Map pane: the whole fleet on one screen (`phm map`). Leader on top, then
 * lanes with their provider logo, running jobs, computers and pools. A line
 * pulses when a message crossed it in the last minute and carries the number of
 * messages in the window; select that number to list them beside the map
 * (EdgeMessagesPanel). Select any node to open the pane that already shows its details.
 *
 * 2D only: no 3D library is a dependency, so there is no 3D toggle.
 */
import { useState } from 'react';
import type { FleetLiveMap, LiveMapEdgeKind, LiveMapNode, LiveMapNodeKind } from '../../../../core/fleet/live-map.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { EdgeMessages } from './EdgeMessagesPanel.js';
import { emptyMap, layoutLiveMap, liveMapQuery, mapHeadline, MAP_POLL_MS, messageCurve, messagePairs, NODE_H, NODE_W, pulsing } from './map-model.js';
import styles from './fleet-map.module.css';

/** The existing pane that shows each kind's details. */
export const DETAIL_PANE: Readonly<Record<LiveMapNodeKind, string>> = {
  leader: 'leader-thread', lane: 'fleet-lanes', job: 'worker-log', computer: 'fleet-computers', resource: 'fleet-usage',
};
const KIND_WORD: Readonly<Record<LiveMapNodeKind, string>> = { leader: 'leader', lane: 'lane', job: 'job', computer: 'computer', resource: 'pool' };
const LEGEND: readonly [LiveMapEdgeKind, string][] = [
  ['reports-to', 'reports to'], ['runs-on', 'runs on'], ['uses-resource', 'uses pool'], ['messaged-in-last-15-min', 'messaged'],
];

export interface MapViewProps {
  map: FleetLiveMap; now: number; onOpen: (node: LiveMapNode) => void;
  /** Opens a job named by a message in the side panel. */
  onOpenJob?: (job: string) => void;
  visible?: boolean;
}

export function MapView({ map, now, onOpen, onOpenJob = () => {}, visible = true }: MapViewProps) {
  const layout = layoutLiveMap(map);
  const talk = map.edges.filter(edge => edge.kind === 'messaged-in-last-15-min');
  const label = (id: string) => layout.at.get(id)?.label ?? 'unknown';
  const pairs = messagePairs(map);
  const [openKey, setOpenKey] = useState<string | null>(null);
  // A line that left the window closes its panel on the next refresh.
  const open = pairs.find(pair => pair.key === openKey) ?? null;
  const pairOf = (from: string, to: string) => pairs.find(pair => pair.key === [from, to].sort().join('|'));
  const countWords = (count: number | null) => count === null ? 'an unknown number of messages' : `${count} message${count === 1 ? '' : 's'}`;
  return <section className={styles.root} aria-label="Fleet map">
    <p className={styles.headline}>{mapHeadline(map)}</p>
    {emptyMap(map) && <p className={styles.notice} role="status">Nothing to map yet: no lanes, jobs or computers reported.</p>}
    <div className={styles.stage}>
      <div className={styles.scroll}>
        <div className={styles.canvas} style={{ width: layout.width, height: layout.height }}>
          <svg className={styles.edges} width={layout.width} height={layout.height} aria-hidden="true">
            {map.edges.map(edge => {
              const a = layout.at.get(edge.from), b = layout.at.get(edge.to);
              if (!a || !b) return null;
              const message = edge.kind === 'messaged-in-last-15-min';
              const d = message ? messageCurve(a, b).d : `M${a.x},${a.y} L${b.x},${b.y}`;
              return <path key={edge.id} d={d} className={styles.edge} data-kind={edge.kind} data-pulse={message && pulsing(edge, map, now) ? 'true' : undefined} />;
            })}
          </svg>
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
          {pairs.map(pair => {
            // The count sits on the pair's lines, midway between the two nodes.
            const mids = pair.edges.flatMap(edge => {
              const a = layout.at.get(edge.from), b = layout.at.get(edge.to);
              return a && b ? [messageCurve(a, b).mid] : [];
            });
            if (!mids.length) return null;
            const mean = (pick: (mid: { x: number; y: number }) => number) => Math.round(mids.reduce((sum, mid) => sum + pick(mid), 0) / mids.length);
            return <button key={pair.key} type="button" className={styles.count} style={{ left: mean(mid => mid.x), top: mean(mid => mid.y) }}
              aria-pressed={open?.key === pair.key} aria-label={`Show ${countWords(pair.count)} between ${label(pair.a)} and ${label(pair.b)}`}
              onClick={() => setOpenKey(open?.key === pair.key ? null : pair.key)}>{pair.count ?? '?'}</button>;
          })}
        </div>
      </div>
      {open && <EdgeMessages map={map} pair={open} visible={visible} onClose={() => setOpenKey(null)} onOpenJob={onOpenJob} />}
    </div>
    <ul className={styles.legend} aria-label="Line key">
      {LEGEND.map(([kind, word]) => <li key={kind}><span className={styles.swatch} data-kind={kind} />{word}</li>)}
      <li><span className={styles.swatch} data-kind="messaged-in-last-15-min" data-pulse="true" />message in the last minute</li>
    </ul>
    <section aria-label="Messages on the map">
      {map.counts.messages === null ? <p className={styles.notice}>Messages unknown.</p>
        : talk.length ? <ul className={styles.talk}>{talk.map(edge => <li key={edge.id}>
          {/* The same panel as the count on the line: the easy target on a phone, where the map scrolls sideways. */}
          <button type="button" data-pulse={pulsing(edge, map, now) ? 'true' : undefined} onClick={() => setOpenKey(pairOf(edge.from, edge.to)?.key ?? null)}>
            {label(edge.from)} → {label(edge.to)}: {edge.messages ?? 'unknown'} in {map.windowMinutes} min</button></li>)}</ul>
          : <p className={styles.notice}>No messages between agents in the last {map.windowMinutes} minutes.</p>}
    </section>
    {map.gaps.length > 0 && <ul className={styles.gaps} aria-label="Unknown">{map.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>}
    <p className={styles.notice}>Same graph for agents: <code>phm map --json</code></p>
  </section>;
}

export function MapPane({ visible, host }: Pick<PaneProps, 'visible' | 'host'>) {
  const read = useQuery(liveMapQuery, { enabled: visible, freshMs: MAP_POLL_MS });
  const refetch = useRefetch(liveMapQuery);
  usePollWhileVisible(refetch, MAP_POLL_MS, { enabled: visible });
  const openJob = (job: string) => { requestWorkerLogJob(job); host.openPane(DETAIL_PANE.job); };
  const open = (node: LiveMapNode) => node.kind === 'job' ? openJob(node.label) : host.openPane(DETAIL_PANE[node.kind]);
  if (read.data === undefined && !read.error) return <div className={styles.root} role="status">Reading the fleet…</div>;
  if (!read.data) return <div className={styles.root}><p className={styles.notice} role="status">Map unavailable right now. It retries every few seconds.</p></div>;
  return <>
    {read.error && <p className={styles.notice} role="status">Refresh failed; showing the last map, which may be stale.</p>}
    <MapView map={read.data} now={Date.now()} onOpen={open} onOpenJob={openJob} visible={visible} />
  </>;
}
