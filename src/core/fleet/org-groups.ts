/**
 * Who reports to whom, as one tree: the leader, then each lane, then each
 * lane's jobs. `phm fleet org`, GET /api/verse/fleet/control/org-groups and the
 * Map pane's "By org" layout all read this one function.
 *
 * Pure. It takes the live map's own nodes and edges and adds nothing:
 *  - a node with no known parent goes under a group labelled "Other", never dropped or guessed;
 *  - a repeated id keeps its first row and is listed in `duplicates`;
 *  - computers and pools are infrastructure, not members of the org, so they are left out.
 * - the guardian and the other standing planners (executor, Core orchestrator, comms; "loops") are
 *    their own branches under the leader, from `map.planners` when the server sent it;
 * Counts add up the leaves below a node (a lane with no jobs counts as itself). A state no source
 * reported counts as `unknown`, never as idle.
 */
import type { FleetLiveMap, LiveMapNode, LiveMapPlanner } from './live-map.js';
import type { LaneHealth } from './lane-badge.js';

export type OrgGroupRole = 'leader' | 'group' | 'lane' | 'job' | 'planner';
export interface OrgGroupCounts { running: number; queued: number; idle: number; unknown: number }
export interface OrgGroupNode {
  id: string; role: OrgGroupRole; label: string;
  /** Null only for the root. */
  parent: string | null;
  children: string[];
  counts: OrgGroupCounts;
  /** The live map's state code for this node; absent on groups. */
  status?: string;
  /** Jobs: activity in the last 5 minutes; null when no time is known. */
  live?: boolean | null;
  /** Lanes: the lane's health verdict, when the server sent one. */
  health?: LaneHealth;
  /** Lanes: merged PRs per hour; null when unknown. */
  mergedPerHour?: number | null;
  /** Lanes: percent of the plan used, 0..100; null when no usage reading ("Usage unknown"). */
  usedPct?: number | null;
}
/** The one-line summary a phone shows first. `stuck` is running jobs with no activity in the last 5 minutes. */
export interface OrgHeadline {
  running: number; queued: number; stuck: number;
  /** Merged PRs in the last hour, summed over lanes that reported; null when no lane did. */
  mergedLastHour: number | null;
  /** "6 running, 2 stuck, 14 merged in the last hour"; "Nothing running." when idle. */
  text: string;
}
export interface FleetOrgGroups {
  schema: 'fleet.org-groups.v1';
  generatedAt: string;
  /** Id of the root (the leader). */
  root: string;
  /** Depth first from the root, so a parent always comes before its children. */
  nodes: OrgGroupNode[];
  /** Ids that appeared more than once in the map; only the first row of each was used. */
  duplicates: string[];
  headline: OrgHeadline;
}

export const UNASSIGNED_GROUP = 'group:unassigned';
export const GUARDIAN_GROUP = 'group:guardian';
export const LOOPS_GROUP = 'group:loops';
/** Branches that hold planners; their counts stay out of the leader's, which count jobs. */
export const PLANNER_GROUPS: ReadonlySet<string> = new Set([GUARDIAN_GROUP, LOOPS_GROUP]);
const ROLES: Partial<Record<LiveMapNode['kind'], OrgGroupRole>> = { leader: 'leader', lane: 'lane', job: 'job' };
const empty = (): OrgGroupCounts => ({ running: 0, queued: 0, idle: 0, unknown: 0 });

/** Which bucket one leaf falls in. Held and idle both mean "not working now". */
export function orgGroupBucket(status: string): keyof OrgGroupCounts {
  if (status === 'running' || status === 'launching' || status === 'publishing') return 'running';
  if (status === 'queued') return 'queued';
  if (status === 'idle' || status === 'held') return 'idle';
  return 'unknown';
}

export function fleetOrgGroups(map: Pick<FleetLiveMap, 'generatedAt' | 'nodes' | 'edges' | 'planners'>): FleetOrgGroups {
  const rows = new Map<string, LiveMapNode>();
  const duplicates: string[] = [];
  for (const node of map.nodes) {
    if (!ROLES[node.kind]) continue;
    if (rows.has(node.id)) { if (!duplicates.includes(node.id)) duplicates.push(node.id); } else rows.set(node.id, node);
  }
  const rootRow = [...rows.values()].find(node => node.kind === 'leader');
  const root = rootRow?.id ?? 'leader';
  const made = new Map<string, OrgGroupNode>();
  const make = (id: string, role: OrgGroupRole, label: string, parent: string | null) => {
    const node: OrgGroupNode = { id, role, label, parent, children: [], counts: empty() };
    made.set(id, node);
    return node;
  };
  make(root, 'leader', rootRow?.label ?? 'Leader', null);

  // First reports-to edge of a node wins.
  const declared = new Map<string, string>();
  for (const edge of map.edges) if (edge.kind === 'reports-to' && !declared.has(edge.from)) declared.set(edge.from, edge.to);
  // A parent counts only when it is on the map and its chain of parents ends at the root (no loops).
  const reachesRoot = (id: string): boolean => {
    for (let at = id, hops = 0; hops <= rows.size; hops++) {
      if (at === root) return true;
      const up = declared.get(at);
      if (up === undefined || !rows.has(up) || up === at) return false;
      at = up;
    }
    return false;
  };
  const parentOf = (id: string): string => {
    const up = declared.get(id);
    return up !== undefined && rows.has(up) && reachesRoot(id) ? up : UNASSIGNED_GROUP;
  };
  for (const node of rows.values()) {
    if (node.kind === 'leader') continue;
    make(node.id, ROLES[node.kind]!, node.label, parentOf(node.id));
  }
  // The guardian is its own branch; the other standing planners share "loops". A branch exists only when it has a planner.
  const planners = new Map<string, LiveMapPlanner>();
  // Guardian first, so the branch order does not depend on the order the server listed planners in.
  for (const planner of [...map.planners ?? []].sort((a, b) => Number(b.id === 'guardian') - Number(a.id === 'guardian'))) {
    const id = `planner:${planner.id}`;
    if (planners.has(id)) continue;
    planners.set(id, planner);
    const group = planner.id === 'guardian' ? GUARDIAN_GROUP : LOOPS_GROUP;
    if (!made.has(group)) make(group, 'group', group === GUARDIAN_GROUP ? 'Guardian' : 'Loops', root);
    const row = make(id, 'planner', planner.label, group);
    row.status = planner.state;
  }
  if ([...made.values()].some(node => node.parent === UNASSIGNED_GROUP)) make(UNASSIGNED_GROUP, 'group', 'Other', root);
  for (const node of made.values()) if (node.parent !== null) made.get(node.parent)!.children.push(node.id);

  const ordered: OrgGroupNode[] = [];
  const walk = (node: OrgGroupNode): OrgGroupCounts => {
    ordered.push(node);
    for (const id of node.children) {
      const sub = walk(made.get(id)!);
      if (node.role === 'leader' && PLANNER_GROUPS.has(id)) continue;
      for (const key of Object.keys(sub) as (keyof OrgGroupCounts)[]) node.counts[key] += sub[key];
    }
    if (!node.children.length && node.role !== 'leader' && node.role !== 'group') node.counts[orgGroupBucket(planners.has(node.id) ? planners.get(node.id)!.state : rows.get(node.id)!.status)] += 1;
    return node.counts;
  };
  walk(made.get(root)!);

  const used = new Map<string, number | null>();
  for (const node of map.nodes) if (node.kind === 'resource') used.set(node.id.replace(/^resource:/, 'lane:'), node.usedPct ?? null);
  let stuck = 0, merged: number | null = null;
  for (const node of ordered) {
    const row = rows.get(node.id);
    if (!row) continue;
    node.status = row.status;
    if (node.role === 'job') {
      node.live = row.live;
      if (orgGroupBucket(row.status) === 'running' && row.live === false) stuck++;
    } else if (node.role === 'lane') {
      if (row.health) node.health = row.health;
      node.mergedPerHour = row.mergedPerHour ?? null;
      node.usedPct = used.get(node.id) ?? null;
      if (node.mergedPerHour !== null) merged = (merged ?? 0) + node.mergedPerHour;
    }
  }
  const { running, queued } = made.get(root)!.counts;
  const mergedLastHour = merged === null ? null : Math.round(merged);
  const text = running === 0 ? 'Nothing running.'
    : [`${running} running`, `${stuck} stuck`, mergedLastHour === null ? 'merged unknown' : `${mergedLastHour} merged in the last hour`].join(', ');
  return { schema: 'fleet.org-groups.v1', generatedAt: map.generatedAt, root, nodes: ordered, duplicates, headline: { running, queued, stuck, mergedLastHour, text } };
}
