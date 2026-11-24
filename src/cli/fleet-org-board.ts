import { OrgStoreError, orgBoardView, orgRunsRoot, readAgentPlane } from '../core/org/agent-plane-reader.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export const ORG_BOARD_USAGE = `Usage: phm fleet org-board [--runs-dir DIR] [--json]

Shows the org chart and pending proposals/bus events from persisted planning metadata
(org/agents.json under the runs dir: --runs-dir, else $ASHLR_RUNS_DIR, else ~/.ashlr-runs).
This is planning metadata, not a fresh runtime, claim, or ownership receipt: live staffing
is reported as unknown and grantsExecutionAuthority is always false. Read only; never writes.
Exit 0 on a valid store; 1 when the store is absent, unsafe, oversized, or invalid; 2 on usage errors.
--json prints org.board.v1 (or org.board.unavailable.v1 on exit 1).`;

export interface FleetOrgBoardDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  defaultRunsRoot?: () => string;
}

/** Human summary. Callers sanitize the whole string before printing. */
export function formatOrgBoardText(view: ReturnType<typeof orgBoardView>): string {
  const lines = [
    `org board ${view.schema} revision ${view.revision}: persisted planning metadata; live staffing unknown; grantsExecutionAuthority false`,
    `roles (${view.agents.length}):`,
    ...view.agents.map(role => `  ${role.id} ${role.tier} ${role.status}${role.reportsTo ? ` reports to ${role.reportsTo}` : ''}: ${role.title}`),
    `pending proposals (${view.pendingProposals.length}):`,
    ...view.pendingProposals.map(row => `  rev ${row.revision} by ${row.proposal.actor} (${row.proposal.change.kind}): ${row.proposal.reason}`),
    `pending bus events: ${view.pendingBusEvents}`,
  ];
  return lines.join('\n');
}

export async function cmdFleetOrgBoard(args: string[], deps: FleetOrgBoardDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  if (args.some(arg => arg === '--help' || arg === '-h')) { out(ORG_BOARD_USAGE); return 0; }

  let json = false;
  let runsDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--runs-dir' && runsDir === undefined && next && !next.startsWith('--')) { runsDir = next; i++; }
    else { err(ORG_BOARD_USAGE); return 2; }
  }

  let plane;
  try {
    plane = readAgentPlane(runsDir ?? (deps.defaultRunsRoot ?? orgRunsRoot)());
  } catch (error) {
    // Only OrgStoreError messages are fixed and safe; anything else gets a generic line.
    const reason = error instanceof OrgStoreError ? error.message : 'Org board unavailable.';
    if (json) out(JSON.stringify({ schema: 'org.board.unavailable.v1', status: 'unavailable', reason, grantsExecutionAuthority: false, liveStaffing: 'unknown' }));
    else err(`phm fleet org-board: ${reason}`);
    return 1;
  }

  const view = { ...orgBoardView(plane), provenance: 'persisted-planning-metadata', liveStaffing: 'unknown' };
  if (json) out(JSON.stringify(sanitizePublicJson(view), null, 2));
  else out(sanitizePublicJson(formatOrgBoardText(view)) as string);
  return 0;
}
