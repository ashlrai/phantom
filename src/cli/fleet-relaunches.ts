/** Jobs that keep spending launch starts with no merged PR, in plain words. */
import { join, resolve } from 'node:path';
import { defaultRunsDir } from '../core/fleet/landed-closes-read.js';
import { readText } from '../core/fleet/empty-cause.js';
import { buildRelaunches, RELAUNCH_MIN_LAUNCHES, relaunchesText } from '../core/fleet/relaunches.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm fleet relaunches [--json] [--runs-dir <directory>]
Jobs launched ${RELAUNCH_MIN_LAUNCHES} or more times in the last 24 hours with no merged PR, and what to do about each. Read-only.
Launch starts are scarce; this lists the jobs spending them again and again (launches, lanes, minutes, PRs).
  --json              print JSON (schema fleet.relaunches.v1; "jobs" has every job launched, "repeat_jobs" the listed ones)
  --runs-dir <dir>    fleet runs directory, default ASHLR_RUNS_DIR or ~/.ashlr-runs
Reads <runs-dir>/metrics/jobs.jsonl; exit 1 when it cannot be read, 2 on a bad option.`;

export interface FleetRelaunchesDeps { now?: () => number; out?: (line: string) => void; err?: (line: string) => void }

export async function cmdFleetRelaunches(args: string[], deps: FleetRelaunchesDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  let json = false, runsArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, next = args[i + 1];
    if (arg === '--json') json = true;
    else if (arg === '--runs-dir' && runsArg === undefined && next && !next.startsWith('-')) runsArg = args[++i];
    else { err(`phm fleet relaunches: unknown or incomplete option ${arg}\n${usage}`); return 2; }
  }
  const runsDir = runsArg ? resolve(runsArg) : defaultRunsDir();
  const ledger = await readText(join(runsDir, 'metrics', 'jobs.jsonl'), 32 * 1024 * 1024);
  const report = buildRelaunches(ledger, (deps.now ?? Date.now)());
  out(json ? JSON.stringify(sanitizePublicJson(report)) : relaunchesText(report).map(line => sanitizePublicJson(line)).join('\n'));
  return report.metrics === 'ok' ? 0 : 1;
}
