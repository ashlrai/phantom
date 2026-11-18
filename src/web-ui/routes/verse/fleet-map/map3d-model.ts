/**
 * The Map pane's 3D layout: the same fleet.live-map.v1 nodes and edges as the 2D rows (`phm map --json`),
 * stacked as rings, one per org level (leader on top, then lanes, running jobs, computers, pools). Pure: no
 * React, no DOM, no randomness. Projection is a plain orbit camera, so no 3D library is needed.
 */
import type { FleetLiveMap, LiveMapNode } from '../../../../core/fleet/live-map.js';

/** World units between two org layers, and the arc each node gets on its ring. */
const LAYER = 130, ARC = 120, MIN_RADIUS = 90;
/** The camera looks down on the rings by this much, so layers read as layers. */
export const TILT_DEG = 22;
/** Slow auto-rotate: one turn a minute. */
export const DEGREES_PER_SECOND = 6;

export interface Node3D extends LiveMapNode { x: number; y: number; z: number }
export interface MapLayout3D { nodes: Node3D[]; at: Map<string, Node3D>; radius: number; height: number }

/**
 * One ring per org level, top to bottom, centred on the origin. A ring of one (the leader) sits on the axis.
 * Each node is ordered on its ring by the angle of the node it reports to, so a lane's jobs sit under it.
 */
export function layoutLiveMap3D(map: FleetLiveMap): MapLayout3D {
  const parent = new Map<string, string>();
  for (const edge of map.edges) {
    if (edge.kind === 'reports-to') parent.set(edge.from, edge.to);
    if (edge.kind === 'uses-resource') parent.set(edge.to, edge.from);
  }
  const byLevel = new Map<number, LiveMapNode[]>();
  for (const node of map.nodes) { const row = byLevel.get(node.level); if (row) row.push(node); else byLevel.set(node.level, [node]); }
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  const height = Math.max(0, levels.length - 1) * LAYER;
  const at = new Map<string, Node3D>(), nodes: Node3D[] = [], angle = new Map<string, number>();
  let radius = 0;
  levels.forEach((level, index) => {
    const row = byLevel.get(level)!;
    const rank = (node: LiveMapNode) => { const up = parent.get(node.id); return up !== undefined && angle.has(up) ? angle.get(up)! : Number.MAX_VALUE; };
    const ordered = row.map((node, order) => ({ node, order, rank: rank(node) })).sort((a, b) => a.rank - b.rank || a.order - b.order);
    const r = ordered.length <= 1 ? 0 : Math.max(MIN_RADIUS, ordered.length * ARC / (2 * Math.PI));
    radius = Math.max(radius, r);
    ordered.forEach(({ node }, i) => {
      const a = ordered.length <= 1 ? 0 : 2 * Math.PI * i / ordered.length;
      const placed = { ...node, x: Math.round(r * Math.sin(a)) || 0, y: index * LAYER - height / 2, z: Math.round(-r * Math.cos(a)) || 0 };
      angle.set(node.id, a); at.set(node.id, placed); nodes.push(placed);
    });
  });
  return { nodes, at, radius, height };
}

export interface Projected { x: number; y: number; scale: number; depth: number }

/**
 * Screen position of every node at `yawDeg` in a `width` × `height` box: rotate about the vertical axis,
 * tilt toward the viewer, divide by depth. Larger depth is nearer. Fits the whole layout in the box.
 */
export function projectLayout3D(layout: MapLayout3D, yawDeg: number, width: number, height: number): Map<string, Projected> {
  const yaw = yawDeg * Math.PI / 180, tilt = TILT_DEG * Math.PI / 180;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
  const extent = Math.max(1, Math.hypot(layout.radius, layout.height / 2 + layout.radius * st));
  const distance = extent * 3;
  const fit = Math.min(1.4, Math.min(width, height) * 0.42 / extent);
  const out = new Map<string, Projected>();
  for (const node of layout.nodes) {
    const x1 = node.x * cy - node.z * sy, z1 = node.x * sy + node.z * cy;
    // Looking down: near points drop on screen, and higher layers (smaller y) sit nearer the camera.
    const y2 = node.y * ct + z1 * st, z2 = z1 * ct - node.y * st;
    const scale = fit * distance / (distance - z2);
    out.set(node.id, { x: width / 2 + x1 * scale, y: height / 2 + y2 * scale, scale: scale / fit, depth: z2 });
  }
  return out;
}

export type MapViewMode = '2d' | '3d';
export const MAP_VIEW_KEY = 'phantom.fleet-map.view';
/** The last choice of the 2D/3D toggle; 2D when none or storage is blocked. */
export function readMapViewMode(): MapViewMode {
  try { return globalThis.localStorage?.getItem(MAP_VIEW_KEY) === '3d' ? '3d' : '2d'; } catch { return '2d'; }
}
export function saveMapViewMode(mode: MapViewMode): void {
  try { globalThis.localStorage?.setItem(MAP_VIEW_KEY, mode); } catch { /* storage blocked: the choice lasts this visit */ }
}
