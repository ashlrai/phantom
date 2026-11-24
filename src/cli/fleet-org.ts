import { readFleetOrgGroups } from '../core/verse/fleet-org-groups-api.js';
import type { FleetOrgGroups, OrgGroupNode } from '../core/fleet/org-groups.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm fleet org [--json]

The headline ("6 running, 2 stuck, 14 merged in the last hour"), then who reports to whom:
the leader, then each lane, then its jobs. A node with no
known parent sits under "Other". Read only.
--json prints fleet.org-groups.v1, the same read as GET /api/verse/fleet/control/org-groups.`;

/** One indented line per node: "claude (lane): 2 running, 1 queued, 0 idle, 0 unknown". */
export function formatOrgGroupsText(tree: FleetOrgGroups): string {
  const byId = new Map(tree.nodes.map(node => [node.id, node]));
  const lines: string[] = [tree.headline.text];
  const walk = (node: OrgGroupNode, depth: number) => {
    const { running, queued, idle, unknown } = node.counts;
    lines.push(`${'  '.repeat(depth)}${node.label} (${node.role}): ${running} running, ${queued} queued, ${idle} idle, ${unknown} unknown`);
    for (const id of node.children) walk(byId.get(id)!, depth + 1);
  };
  walk(byId.get(tree.root)!, 0);
  return lines.join('\n');
}

export async function cmdFleetOrg(args: string[], read: () => Promise<FleetOrgGroups> = () => readFleetOrgGroups()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.some(arg => arg !== '--json') || args.length > 1) { console.error(usage); return 2; }
  const tree = sanitizePublicJson(await read()) as FleetOrgGroups;
  console.log(args.length ? JSON.stringify(tree, null, 2) : formatOrgGroupsText(tree));
  return 0;
}
