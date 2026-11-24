/** `phm throughput`: thin handler. Parses argv and prints the report built in core/fleet/throughput.ts. */
import { join, resolve } from 'node:path';
import { defaultRunsDir } from '../core/fleet/landed-closes-read.js';
import { readThroughput, THROUGHPUT_MAX_HOURS, throughputOptions, throughputText } from '../core/fleet/throughput.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm throughput [--hours 24] [--by lane|repo|tier|model] [--text] [--metrics <file>] [--runs-dir <directory>]
What the fleet produced, hour by hour: jobs launched, PRs published, PRs merged, empty jobs and the
median time from publish to merge, with totals, a one-line headline and whether main is green.
Prints JSON (schema throughput.v1); --text prints plain lines. Read-only.
  --hours <n>         hours to report, 1 to ${THROUGHPUT_MAX_HOURS}, default 24
  --by <group>        also total by lane (default), repo, tier or model (the model each job's launch row names)
  --metrics <file>    job metrics file, default <runs-dir>/metrics/jobs.jsonl
  --runs-dir <dir>    fleet runs directory, default ASHLR_RUNS_DIR or ~/.ashlr-runs
Anything not measured prints as null (JSON) or "unknown" (text), never as zero. Exit 1 when the metrics file is unreadable.`;

export interface ThroughputDeps { now?: () => number; out?: (line: string) => void; err?: (line: string) => void }

export async function cmdThroughput(args: string[], deps: ThroughputDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  let text = false;
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--text') text = true;
    else if (arg === '--json') text = false;
    else if (['--hours', '--by', '--metrics', '--runs-dir'].includes(arg) && args[i + 1] && !args[i + 1]!.startsWith('-')) values[arg] = args[++i]!;
    else { err(`phm throughput: unknown or incomplete option ${arg}\n${usage}`); return 2; }
  }
  const options = throughputOptions(values['--hours'], values['--by']);
  if (!options) { err(`phm throughput: --hours takes 1 to ${THROUGHPUT_MAX_HOURS} and --by takes lane, repo, tier or model\n${usage}`); return 2; }
  const runsDir = values['--runs-dir'] ? resolve(values['--runs-dir']) : defaultRunsDir();
  const report = await readThroughput({
    ...options, runsDir, now: (deps.now ?? Date.now)(),
    metricsPath: values['--metrics'] ? resolve(values['--metrics']) : join(runsDir, 'metrics', 'jobs.jsonl'),
  });
  out(text ? throughputText(report).map(row => sanitizePublicJson(row)).join('\n') : JSON.stringify(sanitizePublicJson(report)));
  return report.metrics === 'ok' ? 0 : 1;
}
