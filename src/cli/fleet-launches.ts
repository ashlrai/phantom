/** Jobs started per hour, the longest gap, starts and merges by lane, wasted starts and what to change. */
import { join, resolve } from 'node:path';
import { defaultRunsDir } from '../core/fleet/landed-closes-read.js';
import { GAP_NOTE_MINUTES, GAP_NOTE_SPACING, LAUNCH_RATE_MAX_HOURS, launchRateHours, launchRateText, readLaunchRate, WASTE_MIN_STARTS, WASTE_RATE } from '../core/fleet/launch-rate.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm fleet launches [--hours <n>] [--json] [--runs-dir <directory>]
How many jobs the fleet starts per hour and which lanes those starts go to. Read-only.
Prints starts per hour, the longest stretch with no start, starts and merged PRs per start by lane,
wasted starts and a short list of what to change, in plain words.
  --hours <n>         window in whole hours, 1 to ${LAUNCH_RATE_MAX_HOURS}, default 24
  --json              print JSON (schema fleet.launches.v1)
  --runs-dir <dir>    fleet runs directory, default ASHLR_RUNS_DIR or ~/.ashlr-runs
A start is wasted when its lane had ${WASTE_MIN_STARTS} or more starts in the last 24 hours and merged under ${WASTE_RATE} per start.
A gap with no start is called out when it is ${GAP_NOTE_MINUTES} minutes or more and ${GAP_NOTE_SPACING} times the average spacing. Plan use and reset come from queue/resources.json;
without it they print as unknown. Reads <runs-dir>/metrics/jobs.jsonl; exit 1 when it cannot be read, 2 on a bad option.`;

export interface FleetLaunchesDeps { now?: () => number; out?: (line: string) => void; err?: (line: string) => void }

export async function cmdFleetLaunches(args: string[], deps: FleetLaunchesDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  let json = false;
  let hoursArg: string | undefined, runsArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, next = args[i + 1];
    if (arg === '--json') json = true;
    else if (arg === '--hours' && hoursArg === undefined && next && !next.startsWith('-')) hoursArg = args[++i];
    else if (arg === '--runs-dir' && runsArg === undefined && next && !next.startsWith('-')) runsArg = args[++i];
    else { err(`phm fleet launches: unknown or incomplete option ${arg}\n${usage}`); return 2; }
  }
  const hours = launchRateHours(hoursArg);
  if (hours === null) { err(`phm fleet launches: --hours takes a whole number from 1 to ${LAUNCH_RATE_MAX_HOURS}\n${usage}`); return 2; }
  const runsDir = runsArg ? resolve(runsArg) : defaultRunsDir();
  const report = await readLaunchRate({ runsDir, metricsPath: join(runsDir, 'metrics', 'jobs.jsonl'), hours, now: (deps.now ?? Date.now)() });
  out(json ? JSON.stringify(sanitizePublicJson(report)) : launchRateText(report).map(line => sanitizePublicJson(line)).join('\n'));
  return report.metrics === 'ok' ? 0 : 1;
}
