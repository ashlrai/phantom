/**
 * Pure model for the 3D fleet map: deterministic layout, bounded agent markers and an allocation-free
 * projection. No React, no DOM, no randomness. Same observations as the 2D map; null stays "unknown".
 */
import type { ComputeNode } from '../../../../core/fleet/compute-view.js';
import type { MapSession } from '../../../../core/fleet/sessions-view.js';
import { providerFor, type Provider } from '../../../../core/fleet/provider.js';
import { loadRatio } from './compute-model.js';

export const MAX_AGENTS_PER_NODE = 12;
export const UNKNOWN_COLOR = '#8a8f98';
export const AGENT_COLORS = { running: '#3fb950', idle: '#6e7f99', held: '#d29922', unknown: '#8a8f98' } as const;
export type AgentKind = keyof typeof AGENT_COLORS | 'more';

export interface SceneAgent { job: string; kind: AgentKind; label: string; provider: Provider; node: number; base: number; top: number }
export interface SceneNode { id: string; label: string; heat: number | null; color: string; dim: boolean; corners: number; center: number }
export interface Scene {
  nodes: SceneNode[]; agents: SceneAgent[]; points: Float32Array; pointCount: number;
  extent: number; overflow: number; shown: number;
}

const HALF = 1, GAP = 3.2, COLS = 4;
/** Heat: green→red by load ratio; unknown (null) is neutral gray, never a fabricated reading. */
export function heatColor(ratio: number | null): string {
  if (ratio === null) return UNKNOWN_COLOR;
  const r = Math.min(1.2, Math.max(0, ratio)) / 1.2;
  return `hsl(${Math.round(135 * (1 - r))} 70% ${Math.round(38 + 14 * r)}%)`;
}
const kindOf = (s: MapSession): AgentKind => s.mapState === 'running' || s.mapState === 'idle' || s.mapState === 'held' ? s.mapState : 'unknown';

export function buildScene(nodes: ComputeNode[], jobs: MapSession[], now: number, heat: boolean, cap = MAX_AGENTS_PER_NODE): Scene {
  const sorted = [...nodes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const cols = Math.max(1, Math.ceil(Math.sqrt(sorted.length)));
  const byNode = new Map<string, MapSession[]>();
  for (const j of jobs) if (j.nodeId) { const l = byNode.get(j.nodeId); if (l) l.push(j); else byNode.set(j.nodeId, [j]); }
  const rows = Math.ceil(sorted.length / cols);
  const agents: SceneAgent[] = [], outNodes: SceneNode[] = [];
  const pts: number[] = [];
  let overflow = 0, shownTotal = 0;
  sorted.forEach((n, i) => {
    const x = (i % cols - (cols - 1) / 2) * GAP, z = (Math.floor(i / cols) - (rows - 1) / 2) * GAP;
    const ratio = heat ? loadRatio(n, now) : null;
    const corners = pts.length / 3;
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) pts.push(x + dx * HALF, 0, z + dz * HALF);
    const center = pts.length / 3; pts.push(x, 0, z);
    outNodes.push({ id: n.id, label: n.id.length > 18 ? `${n.id.slice(0, 17)}…` : n.id, heat: ratio, color: heatColor(ratio), dim: n.state === 'offline', corners, center });
    const list = (byNode.get(n.id) ?? []).sort((a, b) => a.job < b.job ? -1 : a.job > b.job ? 1 : 0);
    const shown = list.length > cap ? cap - 1 : list.length;
    const place = (slot: number, job: string, kind: AgentKind, label: string, provider = providerFor()) => {
      const ax = x + ((slot % COLS) - (COLS - 1) / 2) * (1.6 / COLS * 1.3), az = z + (Math.floor(slot / COLS) - 1) * 0.5;
      const base = pts.length / 3; pts.push(ax, 0, az, ax, 0.9, az);
      agents.push({ job, kind, label, provider, node: i, base, top: base + 1 });
    };
    shownTotal += shown;
    for (let k = 0; k < shown; k++) place(k, list[k]!.job, kindOf(list[k]!), list[k]!.job, providerFor(list[k]!.model, list[k]!.lane));
    if (list.length > shown) { overflow += list.length - shown; place(shown, '', 'more', `+${list.length - shown} more`); }
  });
  return { nodes: outNodes, agents, points: Float32Array.from(pts), pointCount: pts.length / 3, extent: Math.max(HALF * 2, cols * GAP, rows * GAP), overflow, shown: shownTotal };
}

/** Preallocated per-view buffers, so drawing never allocates. */
export interface Frame { sx: Float32Array; sy: Float32Array; depth: Float32Array; order: Int32Array; scale: number }
export const makeFrame = (scene: Scene): Frame => ({
  sx: new Float32Array(scene.pointCount), sy: new Float32Array(scene.pointCount), depth: new Float32Array(scene.pointCount),
  order: Int32Array.from({ length: scene.nodes.length }, (_, i) => i), scale: 1,
});

/** Orbit camera: yaw about Y, tilt about X, perspective divide. Angles in degrees. Writes into frame only. */
export function project(scene: Scene, frame: Frame, w: number, h: number, yawDeg: number, tiltDeg: number, zoom: number): void {
  const yaw = yawDeg * Math.PI / 180, tilt = tiltDeg * Math.PI / 180;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
  const dist = scene.extent * 1.6 + 6;
  const k = zoom * Math.min(w, h) * dist / (scene.extent + 3);
  frame.scale = k / dist;
  const p = scene.points;
  for (let i = 0; i < scene.pointCount; i++) {
    const x = p[i * 3]!, y = p[i * 3 + 1]!, z = p[i * 3 + 2]!;
    const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    const y2 = y * ct - z1 * st, z2 = y * st + z1 * ct;
    const s = k / Math.max(0.5, dist + z2);
    frame.sx[i] = w / 2 + x1 * s; frame.sy[i] = h / 2 + h * 0.08 - y2 * s; frame.depth[i] = z2;
  }
  // Far-to-near painter's order by platform centre depth; insertion sort in place (n is small, mostly sorted).
  const o = frame.order;
  for (let i = 1; i < o.length; i++) {
    const v = o[i]!, d = frame.depth[scene.nodes[v]!.center]!; let j = i - 1;
    while (j >= 0 && frame.depth[scene.nodes[o[j]!]!.center]! < d) { o[j + 1] = o[j]!; j--; }
    o[j + 1] = v;
  }
}

/** Nearest clickable agent marker (not the "+N more" aggregate) within `radius` px of the pointer. */
export function pickAgent(scene: Scene, frame: Frame, px: number, py: number, radius = 12): SceneAgent | null {
  let best: SceneAgent | null = null, bestD = radius * radius;
  for (const a of scene.agents) {
    if (a.kind === 'more') continue;
    const dx = frame.sx[a.top]! - px, dy = frame.sy[a.top]! - py, d = dx * dx + dy * dy;
    if (d <= bestD) { bestD = d; best = a; }
  }
  return best;
}
