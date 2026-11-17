import { explainLaunchStall, FLEET_LAUNCH_STALL_SCHEMA, readLaunchStallFacts, type LaunchStallReport } from '../core/fleet/launch-stall-why.js';

const USAGE = `Usage: ashlr fleet launch-stall-why [--lane <name>] [--json]
Say why a lane with queued work and free slots launches nothing: hold, usage, blocked head lines, no recent launch, unknown facts.
Reads ~/.ashlr-runs/queue (override with ASHLR_RUNS_DIR). Read-only. Exit 1 when any shown lane is stalled.`;

export async function cmdFleetLaunchStallWhy(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(USAGE); return 0; }
  let json = false;
  let only: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--lane' && args[i + 1] && !args[i + 1]!.startsWith('-')) only = args[++i];
    else { console.error(USAGE); return 2; }
  }
  const now = Date.now();
  const facts = (await readLaunchStallFacts()).filter(f => only === undefined || f.lane === only);
  if (only !== undefined && facts.length === 0) {
    const error = `Lane ${only} is not in queue/status.json.`;
    console.log(json ? JSON.stringify({ schema: FLEET_LAUNCH_STALL_SCHEMA, readOnly: true, error }) : error);
    return 2;
  }
  const report: LaunchStallReport = {
    schema: FLEET_LAUNCH_STALL_SCHEMA, readOnly: true, lanes: facts.map(f => explainLaunchStall(f, now)),
  };
  if (json) console.log(JSON.stringify(report));
  else {
    for (const l of report.lanes) {
      console.log(`${l.lane}: ${l.stalled ? 'STALLED' : 'ok'}`);
      for (const r of l.reasons) console.log(`  - ${r}`);
      console.log(`  next: ${l.firstAction}`);
    }
    if (report.lanes.length === 0) console.log('No lanes in queue/status.json.');
  }
  return report.lanes.some(l => l.stalled) ? 1 : 0;
}
