/**
 * `phm fleet capability-audit` — human-parity capability matrix (read-only).
 *
 * Prints what a human can do on this Mac versus what fleet agents can do
 * through apps control, desktopctl/computer-use, browser, files/shell, comms
 * and the tool mesh, with gaps ranked by leverage. Grants no authority.
 */
import { sanitizePublicJson } from '../core/util/public-json.js';
import {
  buildCapabilityAudit,
  formatCapabilityAudit,
} from '../core/fleet/capability-audit.js';

const usage = 'Usage: phm fleet capability-audit [--json]';

const HELP = `${usage}
Human-parity capability audit: enumerate Mac human actions (apps, browser,
files, shell, GUI, comms) against what fleet agents can do today, with gaps
ranked by leverage. Read-only; starts no process and grants no authority.
GATES-held items (TCC automation, secrets, connector run, outbound send) stay
listed as deferred/held and are not proposed as autonomous work.
Exit 0 normally, 2 bad usage.`;

type Output = { log: (message: string) => void; error: (message: string) => void };

export interface FleetCapabilityAuditDeps {
  output?: Output;
  now?: () => Date;
}

export async function cmdFleetCapabilityAudit(args: string[], deps: FleetCapabilityAuditDeps = {}): Promise<number> {
  const output = deps.output ?? { log: console.log, error: console.error };
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    output.log(HELP);
    return 0;
  }
  let json = false;
  const seen = new Set<string>();
  for (const arg of args) {
    if (seen.has(arg)) { output.error(`error: duplicate option\n${usage}`); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else {
      output.error(`error: ${arg.startsWith('-') ? 'unknown option' : 'unexpected argument'}: ${arg}\n${usage}`);
      return 2;
    }
  }
  const report = buildCapabilityAudit(deps.now?.() ?? new Date());
  if (json) output.log(JSON.stringify(sanitizePublicJson(report)));
  else output.log(formatCapabilityAudit(report));
  return 0;
}
