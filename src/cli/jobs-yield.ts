/** `phm jobs yield`: which job kinds are worth a launch slot. Read-only. */
import { join } from 'node:path';
import type { YieldLineReader } from '../core/fleet/ledger-lines.js';
import { readJobYield } from '../core/fleet/metrics-series.js';
import { JOB_KEEP_RATE, JOB_STOP_MIN_LAUNCHES, JOB_STOP_RATE, type JobYieldReport } from '../core/fleet/slot-yield.js';
import { runsRoot } from '../core/metrics/loop-collect.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: phm jobs yield [--since 24h] [--metrics <jobs.jsonl>] [--json]';

/** The summary sentence, the kinds to stop first, then every kind: stop, watch, keep. */
export function jobYieldLines(report: JobYieldReport): string[] {
  if (!report.known) return [report.summary];
  const rate = (value: number | null) => value === null ? 'unknown' : value.toFixed(2);
  return [
    report.summary,
    ...(report.stop_first.length ? ['Stop first:', ...report.stop_first.map((row, i) => `  ${i + 1}. ${row.family}: ${row.slots} slots, ${row.merged} merged`)] : []),
    ...(report.families.length ? ['Job kinds:'] : []),
    ...report.families.map(row => `  ${row.verdict.padEnd(5)} ${row.family}: ${row.reason}; merged per launch ${rate(row.merged_per_launch)}`),
  ];
}

export async function cmdJobsYield(args: string[], read?: YieldLineReader, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}
Which kinds of jobs are worth launching. Reads the job metrics file
(default: <fleet runs dir>/metrics/jobs.jsonl) and counts each launch in the window once.
A job kind is the job id minus its trailing counter (RQ-PHX-RECUTCOREC566 is RQ-PHX-RECUTCORE);
one-test filler jobs group by repo. Per kind: launches, empty, skipped before launch, merged and merged per launch.
keep: merged per launch ${JOB_KEEP_RATE} or more. stop: ${JOB_STOP_MIN_LAUNCHES} or more ended launches and merged per launch under ${JOB_STOP_RATE}. watch: the rest.
JSON is jobs.yield.v1 with version 1. An unreadable file prints unknown, never zero.`);
    return 0;
  }
  let hours = 24, json = false, seenSince = false, metrics: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--metrics' && metrics === null) {
      metrics = args[++i] ?? '';
      if (!metrics || metrics.startsWith('-')) { console.error(usage); return 2; }
    } else if (arg === '--since' && !seenSince) {
      seenSince = true;
      const match = /^(\d+(?:\.\d+)?)([hd])$/.exec(args[++i] ?? '');
      if (!match) { console.error(usage); return 2; }
      hours = Number(match[1]) * (match[2] === 'd' ? 24 : 1);
    } else { console.error(usage); return 2; }
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) { console.error(usage); return 2; }
  const report = await readJobYield(metrics ?? join(runsRoot(), 'metrics', 'jobs.jsonl'), hours, now, read);
  console.log(json ? JSON.stringify(sanitizePublicJson(report)) : jobYieldLines(report).join('\n'));
  return 0;
}
