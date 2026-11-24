/**
 * `phm agents roster` dispatcher. Parsing only; the roster lives in core.
 */
import { terminalColor } from '../core/brand/registry.js';
import { collectAgentRoster, formatAgentRoster, validateAgentRoster, parseRosterViewOptions, selectAgentRoster, type AgentRosterDeps } from '../core/fleet/agent-roster.js';

const HELP = `ashlr agents roster [--principal <id> | --all-owners] [--json]

Read-only unified session roster. One probe per source, in parallel, each
about 5 seconds. A source that times out or has no documented machine-readable
list is unknown. Claims are read from the bus work claim table. No secrets.
--principal local keeps the detailed local view. Other principals and
--all-owners expose only qualified handle, kind, coarse status and last-seen.`;

export async function runAgentsRosterCli(
  args: string[],
  out: (text: string) => void = console.log,
  err: (text: string) => void = console.error,
  deps?: AgentRosterDeps,
): Promise<number> {
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) {
    out(HELP);
    return 0;
  }
  const json = args.includes('--json');
  const rest = args.filter((arg) => arg !== '--json');
  let input: Record<string, unknown> | null = {};
  if (rest.length === 1 && rest[0] === '--all-owners') input = { allOwners: true };
  else if (rest.length === 2 && rest[0] === '--principal') input = { principal: rest[1] };
  else if (rest.length) input = null;
  const options = input && parseRosterViewOptions(input);
  if (!options) {
    err(json ? JSON.stringify({ error: 'invalid-argument' }) : HELP);
    return 2;
  }
  const roster = await collectAgentRoster(deps);
  const problem = validateAgentRoster(roster);
  if (problem) {
    err(json ? JSON.stringify({ error: 'invalid-roster', field: problem }) : problem);
    return 1;
  }
  const view = selectAgentRoster(roster, options);
  out(json ? JSON.stringify(view) : Array.isArray(view)
    ? view.map(row => `${row.qualifiedHandle ? JSON.stringify(row.qualifiedHandle) : 'unverified'}  ${row.kind}  ${row.status}  ${row.lastSeen ?? 'unknown'}`).join('\n')
    : formatAgentRoster(view, { color: terminalColor() }));
  return 0;
}
