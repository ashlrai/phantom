/** `phm merges`: thin handler. Parses argv and prints the report built in core/fleet/merge-latency.ts. */
import { join, resolve } from 'node:path';
import { defaultRunsDir } from '../core/fleet/landed-closes-read.js';
import { mergeLatencyText, mergesLatencyOptions, readMergeLatency, MERGES_LATENCY_MAX_HOURS } from '../core/fleet/merge-latency.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm merges latency [--since 24h] [--by lane|repo] [--json] [--metrics <file>] [--runs-dir <directory>]
How long PRs really take to merge. Shows the median and p90 for open to merge (the PR's own created and
merged times, the true time) next to publish to observed (the old time, which includes the polling delay),
each with the share of merged PRs it covers. A PR whose own times were not recorded is unknown for the
true time, never guessed. "phm merges" alone is the same as "phm merges latency".
Prints plain words; --json prints merges.latency.v1. Read-only.
  --since <n>h|<n>d   window, up to ${MERGES_LATENCY_MAX_HOURS} hours, default 24h
  --by <group>        also split by lane (default) or repo
  --metrics <file>    job metrics file, default <runs-dir>/metrics/jobs.jsonl
  --runs-dir <dir>    fleet runs directory, default ASHLR_RUNS_DIR or ~/.ashlr-runs
Exit 0 report, 1 metrics file unreadable, 2 bad usage.`;

export interface MergesDeps { now?: () => number; out?: (line: string) => void; err?: (line: string) => void }

/** "24h" or "2d" to hours; null when not in that form. */
function sinceHours(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([hd])$/.exec(value);
  return m ? Number(m[1]) * (m[2] === 'd' ? 24 : 1) : null;
}

export async function cmdMerges(args: string[], deps: MergesDeps = {}): Promise<number> {
  const out = deps.out ?? console.log, err = deps.err ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  const rest = args[0] === 'latency' ? args.slice(1) : args;
  let json = false;
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') json = true;
    else if (['--since', '--by', '--metrics', '--runs-dir'].includes(arg) && !(arg in values) && rest[i + 1] && !rest[i + 1]!.startsWith('-')) values[arg] = rest[++i]!;
    else { err(`phm merges: unknown or incomplete option ${arg}\n${usage}`); return 2; }
  }
  const hours = values['--since'] === undefined ? undefined : sinceHours(values['--since']);
  const options = hours === null ? null : mergesLatencyOptions(hours, values['--by']);
  if (!options) { err(`phm merges: --since takes a window like 24h or 2d (up to ${MERGES_LATENCY_MAX_HOURS} hours) and --by takes lane or repo\n${usage}`); return 2; }
  const runsDir = values['--runs-dir'] ? resolve(values['--runs-dir']) : defaultRunsDir();
  const report = await readMergeLatency({
    ...options, now: (deps.now ?? Date.now)(),
    metricsPath: values['--metrics'] ? resolve(values['--metrics']) : join(runsDir, 'metrics', 'jobs.jsonl'),
  });
  out(json ? JSON.stringify(sanitizePublicJson(report)) : mergeLatencyText(report).map(line => sanitizePublicJson(line)).join('\n'));
  return report.metrics === 'ok' ? 0 : 1;
}
