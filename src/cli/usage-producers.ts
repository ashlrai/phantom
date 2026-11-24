/** `phm usage producers`: who is spending each plan, by dispatcher lane and by outside loop. */
import { join, resolve } from 'node:path';
import { defaultRunsDir } from '../core/fleet/landed-closes-read.js';
import { readUsageProducers, USAGE_PRODUCERS_DEFAULT_HOURS, usageProducersHours, usageProducersText } from '../core/fleet/usage-producers.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm usage producers [--since <window>] [--json] [--runs-dir <directory>]
Who started jobs against the plans: each dispatcher lane and each outside loop by name. Read-only.
Per producer: jobs started, models, wall minutes, PRs published, PRs merged. A field no record says prints "unknown", never 0.
  --since <window>    how far back: 90m, 6h or 2d (up to 7d), default ${USAGE_PRODUCERS_DEFAULT_HOURS}h
  --json              print JSON (schema fleet.usage-producers.v1)
  --runs-dir <dir>    fleet runs directory, default ASHLR_RUNS_DIR or ~/.ashlr-runs
Reads <runs-dir>/metrics/jobs.jsonl and each <loop>.log. Leader passes without a record are listed under gaps.
Exit 1 when the job metrics cannot be read, 2 on a bad option.`;

export interface UsageProducersDeps { now?: () => number; out?: (line: string) => void; err?: (line: string) => void }

export async function cmdUsageProducers(args: string[], deps: UsageProducersDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  let json = false;
  let sinceArg: string | undefined, runsArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, next = args[i + 1];
    if (arg === '--json') json = true;
    else if (arg === '--since' && sinceArg === undefined && next && !next.startsWith('-')) sinceArg = args[++i];
    else if (arg === '--runs-dir' && runsArg === undefined && next && !next.startsWith('-')) runsArg = args[++i];
    else { err(`phm usage producers: unknown or incomplete option ${arg}\n${usage}`); return 2; }
  }
  const hours = usageProducersHours(sinceArg);
  if (hours === null) { err(`phm usage producers: --since takes a window like 90m, 6h or 2d, up to 7d\n${usage}`); return 2; }
  const runsDir = runsArg ? resolve(runsArg) : defaultRunsDir();
  const report = await readUsageProducers({ runsDir, metricsPath: join(runsDir, 'metrics', 'jobs.jsonl'), hours, now: (deps.now ?? Date.now)() });
  out(json ? JSON.stringify(sanitizePublicJson(report)) : usageProducersText(report).map(line => sanitizePublicJson(line)).join('\n'));
  return report.metrics === 'ok' ? 0 : 1;
}
