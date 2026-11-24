/**
 * Where each node of the org tree sits in 3D, so the 3D map groups every session and agent by who it
 * reports to. Reads `fleetOrgGroups` (the one org tree `phm fleet org` and the 2D "By org" layout read) and
 * builds no tree of its own. Pure and deterministic: the same tree always gives the same positions, so
 * nodes do not jump between refreshes.
 *
 *  - depth is the vertical axis: the leader on top, each level below it (y grows downward on screen);
 *  - the leader sits on the axis; each group or lane is a cluster on a ring round it;
 *  - children sit on a ring round their parent, one level lower; ring room comes from the subtree size,
 *    so no two nodes share a spot;
 *  - a node with no known owner is under the "Other" group, never dropped.
 * A collapsed group shows only itself; its label says how many nodes are hidden.
 */
import { fleetOrgGroups, type FleetOrgGroups, type OrgGroupCounts, type OrgGroupRole } from './org-groups.js';

/** World units between two depths, the room one leaf needs, and the smallest ring. */
export const ORG_LAYER = 130, ORG_LEAF = 36, ORG_MIN_RING = 90;

export interface OrgPosition3D { id: string; role: OrgGroupRole; label: string; parent: string | null; depth: number; x: number; y: number; z: number }
/** One per group and lane: its name, running count and how many of its nodes a collapse hides. */
export interface OrgGroupLabel3D { id: string; label: string; running: number; unknown: number; hidden: number; text: string; depth: number; x: number; y: number; z: number }
export interface FleetOrgLayout3D {
  schema: 'fleet.org-layout3d.v1';
  /** Visible nodes, parents before children. */
  positions: OrgPosition3D[];
  labels: OrgGroupLabel3D[];
  /** Ids a collapse hides; empty unless some group is collapsed. */
  hidden: string[];
  /** Widest ring and total height, for fitting a camera. */
  radius: number;
  height: number;
}

/** "claude: 2 running, 1 unknown, 3 hidden": unknown and hidden show only when above 0. */
export function orgLabelText(label: string, counts: Pick<OrgGroupCounts, 'running' | 'unknown'>, hidden: number): string {
  return `${label}: ${counts.running} running${counts.unknown ? `, ${counts.unknown} unknown` : ''}${hidden ? `, ${hidden} hidden` : ''}`;
}

export function layoutOrgGroups3D(groups: FleetOrgGroups, collapsed: ReadonlySet<string> = new Set()): FleetOrgLayout3D {
  const byId = new Map(groups.nodes.map(node => [node.id, node]));
  const root = byId.get(groups.root);
  if (!root) return { schema: 'fleet.org-layout3d.v1', positions: [], labels: [], hidden: [], radius: 0, height: 0 };
  const kids = (id: string) => collapsed.has(id) ? [] : byId.get(id)!.children;
  const size = new Map<string, number>(), ring = new Map<string, number>();
  const measure = (id: string): number => {
    const children = kids(id).map(measure);
    const total = children.reduce((sum, fp) => sum + 2 * fp, 0);
    const r = children.length <= 1 ? 0 : Math.max(ORG_MIN_RING, total / (2 * Math.PI) * 1.25, total / 4);
    ring.set(id, r);
    const fp = children.length ? r + Math.max(...children) : ORG_LEAF;
    size.set(id, fp);
    return fp;
  };
  measure(root.id);

  const out: { node: typeof root; depth: number; x: number; z: number }[] = [];
  const place = (id: string, depth: number, x: number, z: number) => {
    out.push({ node: byId.get(id)!, depth, x, z });
    const children = kids(id), r = ring.get(id)!, total = children.reduce((sum, c) => sum + 2 * size.get(c)!, 0);
    let used = 0;
    for (const child of children) {
      const slot = 2 * size.get(child)!, a = children.length === 1 ? 0 : 2 * Math.PI * (used + slot / 2) / total;
      used += slot;
      place(child, depth + 1, x + r * Math.sin(a), z - r * Math.cos(a));
    }
  };
  place(root.id, 0, 0, 0);

  const deepest = Math.max(...out.map(row => row.depth)), height = deepest * ORG_LAYER;
  const positions = out.map(({ node, depth, x, z }): OrgPosition3D => ({ id: node.id, role: node.role, label: node.label, parent: node.parent, depth,
    x: Math.round(x) || 0, y: depth * ORG_LAYER - height / 2, z: Math.round(z) || 0 }));
  const shown = new Set(positions.map(row => row.id));
  const hidden = groups.nodes.map(node => node.id).filter(id => !shown.has(id));
  const below = (id: string): number => byId.get(id)!.children.reduce((sum, c) => sum + 1 + below(c), 0);
  const labels = positions.filter(row => row.role === 'group' || row.role === 'lane').map((row): OrgGroupLabel3D => {
    const { counts } = byId.get(row.id)!, gone = collapsed.has(row.id) ? below(row.id) : 0;
    return { id: row.id, label: row.label, running: counts.running, unknown: counts.unknown, hidden: gone, text: orgLabelText(row.label, counts, gone), depth: row.depth, x: row.x, y: row.y, z: row.z };
  });
  return { schema: 'fleet.org-layout3d.v1', positions, labels, hidden, radius: Math.max(0, ...positions.map(row => Math.hypot(row.x, row.z))), height };
}

/** Convenience for callers that hold the live map: the same tree, then the layout. */
export const orgLayoutOf = (map: Parameters<typeof fleetOrgGroups>[0], collapsed?: ReadonlySet<string>): FleetOrgLayout3D => layoutOrgGroups3D(fleetOrgGroups(map), collapsed);
