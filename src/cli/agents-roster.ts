/**
 * `phm agents roster` dispatcher. Parsing only; the roster lives in core.
 */
import { collectAgentRoster, formatAgentRoster, validateAgentRoster, type AgentRosterDeps } from '../core/fleet/agent-roster.js';

const HELP = `ashlr agents roster [--json]

Read-only unified session roster. One probe per source, in parallel, each
about 5 seconds. A source that times out or has no documented machine-readable
list is unknown. Claims are read from the bus work claim table. No secrets.`;

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
  if (args.length === 0) {
    const roster = await collectAgentRoster(deps);
    const problem = validateAgentRoster(roster);
    if (problem) {
      err(problem);
      return 1;
    }
    out(formatAgentRoster(roster));
    return 0;
  }
  const json = args.includes('--json');
  const rest = args.filter((arg) => arg !== '--json');
  if (rest.length > 0) {
    err(json ? JSON.stringify({ error: 'invalid-argument' }) : HELP);
    return 2;
  }
  const roster = await collectAgentRoster(deps);
  const problem = validateAgentRoster(roster);
  if (problem) {
    err(json ? JSON.stringify({ error: 'invalid-roster', field: problem }) : problem);
    return 1;
  }
  out(json ? JSON.stringify(roster) : formatAgentRoster(roster));
  return 0;
}
