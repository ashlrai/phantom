import {
  orgBoardView,
  orgRunsRoot,
  orgStoreErrorMessage,
  parseOrgPlaneCliArgs,
  readAgentPlane,
} from '../core/org/agent-plane-reader.js';
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
function formatOrgBoardText(view: ReturnType<typeof orgBoardView>): string {
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
  const parsed = parseOrgPlaneCliArgs(args);
  if (parsed.kind === 'help') { out(ORG_BOARD_USAGE); return 0; }
  if (parsed.kind === 'usage') { err(ORG_BOARD_USAGE); return 2; }

  let plane;
  try {
    plane = readAgentPlane(parsed.runsDir ?? (deps.defaultRunsRoot ?? orgRunsRoot)());
  } catch (error) {
    // Only OrgStoreError messages are fixed and safe; anything else gets a generic line.
    const reason = orgStoreErrorMessage(error, 'Org board unavailable.');
    if (parsed.json) out(JSON.stringify({ schema: 'org.board.unavailable.v1', status: 'unavailable', reason, grantsExecutionAuthority: false, liveStaffing: 'unknown' }));
    else err(`phm fleet org-board: ${reason}`);
    return 1;
  }

  const view = { ...orgBoardView(plane), provenance: 'persisted-planning-metadata', liveStaffing: 'unknown' };
  if (parsed.json) out(JSON.stringify(sanitizePublicJson(view), null, 2));
  else out(sanitizePublicJson(formatOrgBoardText(view)) as string);
  return 0;
}
