/**
 * `ashlr fleet comms-readiness` — read-only email/iMessage cutover readiness.
 * Projects local evidence into per-capability states with fixed next steps;
 * never claims Commsbot can be retired on config alone.
 */
import { buildCommsCutoverReadiness, type CommsCutoverReadinessDeps } from '../core/comms/cutover-readiness.js';

const usage = 'Usage: ashlr fleet comms-readiness [--json]';

export async function cmdFleetCommsReadiness(args: string[], deps: CommsCutoverReadinessDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${usage}\nRead-only projection of local email/iMessage evidence into per-capability\ncutover readiness (ready / blocked / unsupported / unverified) with fixed next\nsteps. Config is not proof of delivery: Gmail triage, LinkedIn and owner\niMessage delivery stay unverified, so Commsbot retirement is never evidenced.`);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(usage);
    return 2;
  }
  const report = await buildCommsCutoverReadiness(deps);
  if (args[0] === '--json') {
    console.log(JSON.stringify(report));
    return 0;
  }
  console.log(`comms-cutover: ${report.overall.state} (local evidence only; commsbot retirement ${report.overall.commsbotRetirement})`);
  for (const id of report.overall.blockers) {
    const cap = report.capabilities[id as keyof typeof report.capabilities];
    console.log(`  ${id}: ${cap.state} (${cap.reason}) — ${cap.nextStep}`);
  }
  return 0;
}
