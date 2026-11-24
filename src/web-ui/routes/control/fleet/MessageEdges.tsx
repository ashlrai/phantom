import { useState } from 'react';
import type { MapMessage } from '../../../../core/fleet/map-messages.js';
import styles from './FleetMap.module.css';

/** A message edge stays on the map this long, fading the whole time. */
export const EDGE_FADE_MS = 30_000;
const SIZE = 240, CENTER = SIZE / 2, RADIUS = 90;

/** Messages still inside the fade window, newest first; a time in the future counts as just now. */
export const liveEdges = (messages: readonly MapMessage[], now: number): MapMessage[] =>
  messages.filter(m => now - Date.parse(m.at) < EDGE_FADE_MS);

/**
 * Recent agent messages as short-lived edges between the agents that sent
 * them. Plain read-only drawing: each agent sits on a ring, each message is a
 * line that fades over 30 s, and picking a line shows its summary. An agent
 * the map has no node for is drawn dashed ("not on the map").
 */
export function MessageEdges({ messages, now }: { messages: readonly MapMessage[]; now: number }) {
  const [picked, setPicked] = useState<MapMessage | null>(null);
  const edges = liveEdges(messages, now);
  const nodes = new Map<string, boolean>();
  for (const m of edges) { nodes.set(m.from, m.fromNode !== null); nodes.set(m.to, m.toNode !== null); }
  const names = [...nodes.keys()].sort();
  const at = (name: string) => {
    const angle = (names.indexOf(name) / Math.max(names.length, 1)) * 2 * Math.PI - Math.PI / 2;
    return { x: CENTER + RADIUS * Math.cos(angle), y: CENTER + RADIUS * Math.sin(angle) };
  };
  if (edges.length === 0 && !picked) return <p>No agent messages in the last 30 seconds.</p>;
  return <div>
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="group" aria-label="Agent message edges" className={styles.edgeMap}>
      {edges.map(m => {
        const a = at(m.from), b = at(m.to), age = Math.max(0, now - Date.parse(m.at));
        return <g key={m.id} role="button" tabIndex={0} aria-label={`${m.from} to ${m.to}, ${m.kind}`} data-edge={m.id}
          className={styles.edge} style={{ animationDelay: `-${age}ms` }}
          onClick={() => setPicked(m)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPicked(m); } }}>
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={styles.edgeHit} />
          <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={styles.edgeLine} />
        </g>;
      })}
      {names.map(name => {
        const p = at(name);
        return <g key={name} data-known={String(nodes.get(name))}>
          <circle cx={p.x} cy={p.y} r={5} className={styles.edgeNode} data-known={String(nodes.get(name))} />
          <text x={p.x} y={p.y - 9} textAnchor="middle" className={styles.edgeLabel}>{name.slice(0, 18)}</text>
        </g>;
      })}
    </svg>
    {picked ? <p role="status" className={styles.caption}><strong>{picked.from} → {picked.to}</strong> · {picked.kind} · {picked.summary}</p>
      : <p className={styles.caption}>Pick a line to read its summary. Dashed dots are agents the map has no node for.</p>}
  </div>;
}
