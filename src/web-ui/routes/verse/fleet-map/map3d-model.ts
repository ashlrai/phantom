/**
 * The Map pane's 3D layout: the same fleet.live-map.v1 nodes and edges as the 2D rows (`phm map --json`),
 * grouped by the one org tree the 2D "By org" layout reads (core/fleet/org-layout-3d.ts): depth is the
 * vertical axis, each lane or "Other" group is a cluster, children sit round their parent. Computers
 * and pools are not in the org, so they sit on a ring under it. Pure: no React, no DOM, no randomness.
 * Projection is a plain orbit camera, so no 3D library is needed.
 */
import type { FleetLiveMap, LiveMapNode } from '../../../../core/fleet/live-map.js';
import { fleetOrgGroups } from '../../../../core/fleet/org-groups.js';
import { layoutOrgGroups3D, ORG_LAYER, ORG_MIN_RING, type OrgGroupLabel3D } from '../../../../core/fleet/org-layout-3d.js';

/** World units each node gets on the ring under the org (computers and pools). */
const ARC = 120;
/** The camera looks down on the rings by this much, so layers read as layers. */
export const TILT_DEG = 22;
/** Slow auto-rotate: one turn a minute. */
export const DEGREES_PER_SECOND = 6;

export interface Node3D extends LiveMapNode { x: number; y: number; z: number }
export interface MapLayout3D { nodes: Node3D[]; at: Map<string, Node3D>; labels: OrgGroupLabel3D[]; radius: number; height: number }

/**
 * Every node of the map is placed, grouped by who it reports to. A group id in `collapsed` shows only
 * itself, and its label counts what is hidden.
 */
export function layoutLiveMap3D(map: FleetLiveMap, collapsed: ReadonlySet<string> = new Set()): MapLayout3D {
  const org = layoutOrgGroups3D(fleetOrgGroups(map), collapsed);
  const source = new Map(map.nodes.map(node => [node.id, node]));
  const hidden = new Set(org.hidden);
  const placed: { node: LiveMapNode; depth: number; x: number; z: number }[] = [];
  const seen = new Set<string>();
  for (const row of org.positions) {
    const node = source.get(row.id);
    if (node && !seen.has(row.id)) { seen.add(row.id); placed.push({ node, depth: row.depth, x: row.x, z: row.z }); }
  }
  const orgDepth = Math.max(1, ...org.positions.map(row => row.depth));
  const rest = map.nodes.filter(node => !seen.has(node.id) && !hidden.has(node.id) && seen.add(node.id));
  const r = rest.length <= 1 ? 0 : Math.max(ORG_MIN_RING, rest.length * ARC / (2 * Math.PI));
  rest.forEach((node, i) => {
    const a = 2 * Math.PI * i / rest.length;
    placed.push({ node, depth: orgDepth + 1, x: Math.round(r * Math.sin(a)) || 0, z: Math.round(-r * Math.cos(a)) || 0 });
  });
  const deepest = Math.max(0, ...placed.map(row => row.depth)), height = deepest * ORG_LAYER;
  const nodes = placed.map(({ node, depth, x, z }): Node3D => ({ ...node, x, y: depth * ORG_LAYER - height / 2, z }));
  const labels = org.labels.map(label => ({ ...label, y: label.depth * ORG_LAYER - height / 2 }));
  return { nodes, at: new Map(nodes.map(node => [node.id, node])), labels,
    radius: Math.max(0, r, ...nodes.map(node => Math.hypot(node.x, node.z))), height };
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
  for (const node of [...layout.nodes, ...layout.labels.map(label => ({ ...label, id: `label:${label.id}` }))]) {
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
