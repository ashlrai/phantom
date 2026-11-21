/**
 * The Map pane's "By org" layout: the leader on top, then one box per lane holding the lane and its
 * jobs (a box named "unassigned" holds anything with no known parent), then computers and pools in a
 * bottom row. Same nodes and ids as the row layout, so lines, logos and message counts are unchanged.
 * The choice of layout is remembered like the 2D/3D choice.
 */
import type { FleetLiveMap } from '../../../../core/fleet/live-map.js';
import { fleetOrgGroups, PLANNER_GROUPS, type FleetOrgGroups, type OrgGroupCounts } from '../../../../core/fleet/org-groups.js';
import { NODE_H, NODE_W, type MapLayout, type PlacedNode } from './map-model.js';

export type MapLayoutMode = 'rows' | 'org';
export const MAP_LAYOUT_KEY = 'phantom.fleet-map.layout';
export function readMapLayout(): MapLayoutMode {
  try { return globalThis.localStorage?.getItem(MAP_LAYOUT_KEY) === 'org' ? 'org' : 'rows'; } catch { return 'rows'; }
}
export function saveMapLayout(mode: MapLayoutMode): void {
  try { globalThis.localStorage?.setItem(MAP_LAYOUT_KEY, mode); } catch { /* storage blocked: the choice lasts this visit */ }
}

/** A planner line inside the guardian or loops box: the boxes hold text, not map nodes. */
export interface OrgBoxMember { id: string; label: string; state: string }
export interface OrgBox { id: string; label: string; counts: OrgGroupCounts; members?: OrgBoxMember[]; x: number; y: number; width: number; height: number }
export interface OrgLayout extends MapLayout { boxes: OrgBox[] }

const LINE = 22, PAD = 16, GAP = 12, HEADER = 34, BOX_W = NODE_W + 24, BAND = 40, COLUMN = 156;

/** "claude: 2 running", with unknown spelled out when some state is not reported. */
export function orgBoxLabel(box: Pick<OrgBox, 'label' | 'counts'>): string {
  return `${box.label}: ${box.counts.running} running${box.counts.unknown ? `, ${box.counts.unknown} unknown` : ''}`;
}

export function layoutByOrg(map: FleetLiveMap, groups: FleetOrgGroups = fleetOrgGroups(map)): OrgLayout {
  const byId = new Map(groups.nodes.map(node => [node.id, node]));
  const source = new Map(map.nodes.map(node => [node.id, node]));
  const root = byId.get(groups.root)!;
  const members = (id: string): string[] => [id, ...byId.get(id)!.children.flatMap(members)];
  const at = new Map<string, PlacedNode>(), placed: PlacedNode[] = [], boxes: OrgBox[] = [];
  const place = (id: string, x: number, y: number) => {
    const node = source.get(id);
    if (!node || at.has(id)) return;
    const spot = { ...node, x: Math.round(x), y: Math.round(y) };
    at.set(id, spot); placed.push(spot);
  };

  const top = PAD + NODE_H / 2;
  const boxTop = PAD + NODE_H + BAND;
  let tallest = 0;
  root.children.forEach((id, column) => {
    const group = byId.get(id)!;
    if (PLANNER_GROUPS.has(id)) {
      const members = group.children.map(child => ({ id: child, label: byId.get(child)!.label, state: byId.get(child)!.status ?? 'unknown' }));
      const height = HEADER + members.length * LINE + GAP;
      boxes.push({ id, label: group.label, counts: group.counts, members, x: PAD + column * (BOX_W + GAP), y: boxTop, width: BOX_W, height });
      tallest = Math.max(tallest, height);
      return;
    }
    const items = (group.role === 'group' ? group.children.flatMap(members) : members(id)).filter(item => source.has(item));
    const x = PAD + column * (BOX_W + GAP);
    const height = HEADER + items.length * (NODE_H + GAP) + GAP;
    boxes.push({ id, label: group.label, counts: group.counts, x, y: boxTop, width: BOX_W, height });
    items.forEach((item, row) => place(item, x + BOX_W / 2, boxTop + HEADER + GAP + NODE_H / 2 + row * (NODE_H + GAP) - GAP));
    tallest = Math.max(tallest, height);
  });
  const columns = Math.max(root.children.length, 1);
  const rest = map.nodes.filter(node => !at.has(node.id) && node.kind !== 'leader');
  const bandWidth = Math.max(COLUMN * 4, columns * (BOX_W + GAP) - GAP + PAD * 2, rest.length * COLUMN + PAD * 2);
  const centre = (index: number, count: number) => PAD + ((bandWidth - PAD * 2) / count) * (index + 0.5);
  if (source.has(groups.root)) place(groups.root, bandWidth / 2, top);
  const restTop = boxTop + tallest + BAND + NODE_H / 2;
  rest.forEach((node, index) => place(node.id, centre(index, rest.length), restTop));
  const height = (rest.length ? restTop + NODE_H / 2 : boxTop + tallest) + PAD;
  return { width: bandWidth, height, nodes: placed, at, boxes };
}
