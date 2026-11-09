import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { computeLaneFit } from '../core/fleet/lane-fit.js';
import { buildFleetLiveSnapshot } from '../core/verse/fleet-live-api.js';
import { computeLaneHealth, laneHealthLine, stuckBadge } from '../core/fleet/lane-health.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = `Usage: phm lanes health [--json] | phm lanes fit --lane <lane> [--json]
Calls, error rate, p50 latency and deployed commit per lane over the last 12 h,
plus a "stuck" badge with phase age for any run past its phase timeout.
Figures that cannot be measured print "unknown".`;

export async function cmdLanes(args: string[]): Promise<number> {
  if (args.length === 0 || ['--help', '-h'].includes(args[0]!)) {
    console.log(USAGE);
    return args.length === 0 ? 2 : 0;
  }
  if (args[0] === 'fit') {
    const flags = args.slice(1);
    const laneIndex = flags.indexOf('--lane');
    const lane = laneIndex >= 0 ? flags[laneIndex + 1] : undefined;
    if (!lane || lane.startsWith('-') || flags.filter(x => x === '--lane').length !== 1 || flags.filter(x => x === '--json').length > 1 || flags.some((x, i) => i !== laneIndex && i !== laneIndex + 1 && x !== '--json')) {
      console.error(USAGE); return 2;
    }
    let text: string | null;
    try { text = await readFile(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'), 'utf8'); } catch { text = null; }
    const report = computeLaneFit(text, lane);
    if (flags.includes('--json')) console.log(JSON.stringify(sanitizePublicJson(report)));
    else if (!report.known) console.log('Job history is unavailable. Fit is unknown.');
    else if (!report.kinds.length) console.log('No job history for this lane. Fit is unknown.');
    else for (const kind of report.kinds) console.log(`${kind.repo ?? 'unknown repo'} / ${kind.tier ?? 'unknown tier'} / ${kind.verb ?? 'unknown verb'}: ${kind.recommendation}; ${kind.prs}/${kind.jobs - kind.unknownOutcomes} produced a PR, ${kind.unknownOutcomes} unknown`);
    return 0;
  }
  if (args[0] !== 'health' || args.slice(1).some((a) => a !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  const { snapshot } = await buildFleetLiveSnapshot();
  const health = computeLaneHealth(snapshot);
  if (args.includes('--json')) {
    console.log(JSON.stringify(sanitizePublicJson(health)));
    return 0;
  }
  console.log(`Lane health, last ${health.window.hours} h (to ${health.window.until})`);
  for (const lane of health.lanes) {
    const badge = stuckBadge(lane);
    console.log(`${lane.lane}: ${laneHealthLine(lane)}${badge ? `  [${badge}]` : ''}`);
  }
  return 0;
}
