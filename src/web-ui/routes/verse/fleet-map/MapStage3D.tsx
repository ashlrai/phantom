/**
 * The Map pane's 3D view: the same nodes and lines as the 2D rows, grouped by the org tree (a cluster per lane,
 * a label per group that hides or shows it) and turning slowly. Plain DOM buttons over an SVG of lines, moved by a projection each frame, so every node
 * stays a real button (keyboard, screen reader, click opens its detail pane) and no 3D library is needed.
 * Rotation stops while the pointer or focus is on the map, and never starts under reduced motion.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { messageLineWidth, type FleetLiveMap, type LiveMapEdge, type LiveMapNode } from '../../../../core/fleet/live-map.js';
import { prefersReducedMotion } from '../../../components/charts/motion.js';
import { LaneHealthBadge } from '../../../components/fleet/LaneHealthBadge.js';
import { ProviderBadge } from '../../../components/primitives/ProviderBadge.js';
import { DEGREES_PER_SECOND, layoutLiveMap3D, projectLayout3D } from './map3d-model.js';
import { MESSAGE_EDGE_TTL_MS, pulsing } from './map-model.js';
import styles from './fleet-map.module.css';

export const STAGE_H = 480;
const STAGE_W = 800, START_YAW = 20;
type Rotate = 'on' | 'paused' | 'off';

interface Props {
  showMessages?: boolean; reducedMotion?: boolean; onHover?: (id: string | null) => void; cardEdge?: LiveMapEdge; card?: ReactNode;
  map: FleetLiveMap; now: number; onOpen: (node: LiveMapNode) => void; onOpenEdge: (edge: LiveMapEdge) => void;
  /** "Open lane claude: …", the same words as the 2D buttons. */
  nameOf: (node: LiveMapNode) => string;
}

export function MapStage3D({ map, now, onOpen, onOpenEdge, nameOf, showMessages = true, reducedMotion = false, onHover, cardEdge, card }: Props) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) => setCollapsed(now => { const next = new Set(now); if (!next.delete(id)) next.add(id); return next; });
  const layout = useMemo(() => layoutLiveMap3D(map, collapsed), [map, collapsed]);
  const stage = useRef<HTMLDivElement>(null);
  const yaw = useRef(START_YAW);
  const [still] = useState(prefersReducedMotion);
  // Pointer over the map or focus inside it: either one holds the rotation.
  const [held, setHeld] = useState({ pointer: false, focus: false });
  const hold = (why: 'pointer' | 'focus', on: boolean) => setHeld(h => h[why] === on ? h : { ...h, [why]: on });
  const rotate: Rotate = still || reducedMotion ? 'off' : held.pointer || held.focus ? 'paused' : 'on';

  // Moves the existing elements; React renders them once per read, not once per frame.
  const place = useCallback(() => {
    const el = stage.current;
    if (!el) return;
    const at = projectLayout3D(layout, yaw.current, el.clientWidth || STAGE_W, STAGE_H);
    for (const node of el.querySelectorAll<HTMLElement>('[data-node]')) {
      const p = at.get(node.dataset.node!);
      if (!p) continue;
      node.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%) scale(${p.scale.toFixed(3)})`;
      node.style.zIndex = String(Math.round(p.scale * 1000));
    }
    for (const label of el.querySelectorAll<HTMLElement>('[data-label]')) {
      const p = at.get(`label:${label.dataset.label}`);
      if (!p) continue;
      label.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -150%) scale(${p.scale.toFixed(3)})`;
      label.style.zIndex = String(Math.round(p.scale * 1000));
    }
    for (const line of el.querySelectorAll<SVGLineElement>('line[data-from]')) {
      const a = at.get(line.dataset.from!), b = at.get(line.dataset.to!);
      if (!a || !b) continue;
      line.setAttribute('x1', a.x.toFixed(1)); line.setAttribute('y1', a.y.toFixed(1));
      line.setAttribute('x2', b.x.toFixed(1)); line.setAttribute('y2', b.y.toFixed(1));
    }
    for (const badge of el.querySelectorAll<HTMLElement>('[data-edge-badge], [data-edge-card]')) {
      const a = at.get(badge.dataset.from!), b = at.get(badge.dataset.to!);
      if (!a || !b) continue;
      const isCard = badge.hasAttribute('data-edge-card');
      const x = isCard ? Math.max(0, Math.min(el.clientWidth - 258, (a.x + b.x) / 2)) : (a.x + b.x) / 2;
      const y = isCard ? Math.max(0, Math.min(STAGE_H - 200, (a.y + b.y) / 2)) : (a.y + b.y) / 2;
      badge.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)${isCard ? '' : ' translate(-50%, -50%)'}`;
      badge.style.zIndex = isCard ? '2000' : String(Math.round((a.scale + b.scale) * 500));
    }
  }, [layout]);

  useLayoutEffect(() => { place(); });
  useEffect(() => {
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [place]);
  useEffect(() => {
    if (rotate !== 'on' || typeof requestAnimationFrame !== 'function') return;
    let raf = 0, last: number | null = null;
    const tick = (t: number) => {
      if (last !== null) yaw.current = (yaw.current + (t - last) / 1000 * DEGREES_PER_SECOND) % 360;
      last = t; place(); raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rotate, place]);

  const byId = layout.at;
  return <div ref={stage} className={styles.stage} style={{ height: STAGE_H }} data-rotate={rotate} data-testid="map-3d"
    onPointerEnter={() => hold('pointer', true)} onPointerLeave={() => hold('pointer', false)}
    onFocus={() => hold('focus', true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) hold('focus', false); }}>
    <svg className={styles.edges} width="100%" height={STAGE_H} aria-hidden="true">
      {map.edges.map(edge => {
        if (!byId.has(edge.from) || !byId.has(edge.to)) return null;
        const message = edge.kind === 'messaged-in-last-15-min';
        const ends = { 'data-from': edge.from, 'data-to': edge.to };
        if (message && !showMessages) return null;
        if (!message) return <line key={edge.id} {...ends} className={styles.edge} data-kind={edge.kind} />;
        return <g key={edge.id}>
          <line {...ends} className={styles.edge} data-kind={edge.kind} data-pulse={pulsing(edge, map, now, reducedMotion) ? 'true' : undefined} style={{ strokeWidth: edge.id.startsWith('live:') ? 5 : messageLineWidth(edge.messages), opacity: edge.id.startsWith('live:') ? 1 - (now - Date.parse(edge.lastMessageAt!)) / MESSAGE_EDGE_TTL_MS : 1 }} />
          <line {...ends} className={styles.hit} data-open-messages={edge.id} onClick={() => onOpenEdge(edge)} onMouseEnter={() => onHover?.(edge.id)} onMouseLeave={() => onHover?.(null)} />
        </g>;
      })}
    </svg>
    {map.edges.filter(edge => showMessages && edge.kind === 'messaged-in-last-15-min' && byId.has(edge.from) && byId.has(edge.to)).map(edge =>
      <span key={edge.id} className={styles.edgeBadge} data-edge-badge={edge.id} data-from={edge.from} data-to={edge.to}>
        <ProviderBadge of={byId.get(edge.from)!.provider} iconOnly size={12} />
      </span>)}
    {cardEdge && card && <span className={styles.edgeCard} data-edge-card={cardEdge.id} data-from={cardEdge.from} data-to={cardEdge.to}>{card}</span>}
    {layout.labels.map(label => <button key={label.id} type="button" className={styles.groupLabel3d} data-label={label.id} aria-expanded={!collapsed.has(label.id)}
      title={collapsed.has(label.id) ? 'Show this group' : 'Hide this group'} onClick={() => toggle(label.id)}>{label.text}</button>)}
    {layout.nodes.map(node => <button key={node.id} type="button" className={styles.node3d} data-node={node.id} data-kind={node.kind} data-status={node.status}
      aria-label={nameOf(node)} title={node.detail} onClick={() => onOpen(node)}>
      {!['computer', 'resource'].includes(node.kind) && <ProviderBadge of={node.provider} iconOnly size={12} />}
      {node.live && <span className={styles.live} role="img" aria-label="Active in the last 5 minutes" />}
      <strong>{node.label}</strong>
      {node.kind === 'lane' && <LaneHealthBadge health={node.health} />}
    </button>)}
  </div>;
}
