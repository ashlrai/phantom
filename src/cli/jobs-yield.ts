/** `phm jobs yield`: which job kinds are worth a launch slot. Read-only, except `--stop-file`, which writes the stop file. */
import { join, resolve } from 'node:path';
import type { YieldLineReader } from '../core/fleet/ledger-lines.js';
import { readJobYieldParts } from '../core/fleet/metrics-series.js';
import { JOB_KEEP_RATE, JOB_RECENT_LAUNCHES, JOB_STOP_MIN_LAUNCHES, JOB_STOP_RATE, type JobYieldReport } from '../core/fleet/slot-yield.js';
import { planStopFile, readStopFileText, STOP_FILE_ENV, STOP_FILE_SCHEMA, STOP_TTL_HOURS, STOP_TTL_MAX_HOURS, stopFilePath, stopRows, writeStopFile } from '../core/fleet/stop-file.js';
import { runsRoot } from '../core/metrics/loop-collect.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { readYieldBy, yieldByLines, type YieldBy } from '../core/fleet/yield-by.js';
import { emptyWhyLines, readJobsEmptyWhy } from '../core/fleet/jobs-empty-why.js';

const yieldUsage = 'Usage: phm jobs yield [--since 24h|7d] [--by source|lane|family] [--metrics <jobs.jsonl>] [--stop-list | --stop-file [--ttl-hours N] [--out PATH] [--dry-run]] [--json]';

/** `--stop-file`: turn every stop verdict into a stop-file row. Exit 1 when the yield or the file is unknown. */
async function writeStops(parts: Awaited<ReturnType<typeof readJobYieldParts>>, opts: { ttl: number; out: string | null; dryRun: boolean; json: boolean; now: number }): Promise<number> {
  const path = opts.out ? resolve(opts.out) : stopFilePath();
  const { rows, unsafe } = parts.report.known ? stopRows(parts, opts.now, opts.ttl) : { rows: [], unsafe: [] };
  const before = path ? await readStopFileText(path) : '';
  const problem = !parts.report.known ? parts.report.summary
    : before === null ? 'Stop file: unknown (the file cannot be read); nothing written'
    : !path && !opts.dryRun ? `Stop file: unknown. Pass --out <path> or set ${STOP_FILE_ENV}; add --dry-run to only see the rows` : null;
  const plan = planStopFile(before ?? '', rows, opts.now);
  let written = false, error = problem;
  if (!problem && path && !opts.dryRun) {
    try { await writeStopFile(path, plan.text); written = true; } catch { error = 'Stop file: could not be written'; }
  }
  if (opts.json) {
    console.log(JSON.stringify(sanitizePublicJson({ schema: STOP_FILE_SCHEMA, version: 1, path, dry_run: opts.dryRun, written, ttl_hours: opts.ttl,
      yield_known: parts.report.known, error, rows, unsafe, kept_hand: plan.kept_hand, kept_auto: plan.kept_auto, dropped_expired: plan.dropped_expired })));
    return error ? 1 : 0;
  }
  if (error) { console.error(error); return 1; }
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  console.log([
    `Stop file: ${path ?? 'unknown'}${written ? '' : ' (nothing written)'}`,
    rows.length ? `${count(rows.length, 'job kind')} stopped for ${count(opts.ttl, 'hour')}:` : 'No job kind to stop.',
    ...rows.map(row => `  ${row.pattern}\t${row.until}\t${row.reason}`),
    ...unsafe.map(row => `  not stopped: ${row.family} (${row.why})`),
    `Kept ${count(plan.kept_hand, 'hand-written row')} and ${count(plan.kept_auto, 'earlier tool row')}; removed ${count(plan.dropped_expired, 'expired tool row')}.`,
  ].join('\n'));
  return 0;
}

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

export async function cmdJobsYield(args: string[], read?: YieldLineReader, now = Date.now(), emptyWhy = false): Promise<number> {
  const usage = emptyWhy ? 'Usage: phm jobs empty-why [--since 24h] [--metrics <jobs.jsonl>] [--json]' : yieldUsage;
  if (emptyWhy && args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(`${usage}\nExplain EMPTY finishes and rank families by recorded wasted tokens. JSON: jobs.empty-why.v1. Unknown tokens remain null.`); return 0; }
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}
Which kinds of jobs are worth launching. Reads the job metrics file
(default: <fleet runs dir>/metrics/jobs.jsonl) and counts each launch in the window once.
Run phm jobs yield --by source (or --by lane) for a scoreboard per producer or lane instead of per job kind:
launches, PRs opened, merged, empty, aborted, merged per launch and median minutes to merge, lowest merged per launch first,
then one verdict line for the worst. A source is the job's src= tag, else its id prefix: leader, core (RQ-PHX), cl-stream (RQ-CL),
guardian (FIXUP), filler or other. JSON is jobs.yield-by.v1; unknown medians are null. --by family is the default view.
Run phm jobs yield --stop-list to print only the job kinds to stop, one per line.
The list includes every stop kind; no matches prints nothing. An unreadable file reports an error and exits 1.
With --json, the full report is unchanged, even with --stop-list.
Run phm jobs yield --stop-file to write those kinds to the job stop file, so the fleet skips them before any model call.
Each row is <pattern on job id><tab><until unix epoch><tab><kind>_<merged>of<launches>, followed by a "# auto:phm-yield" line.
Rows last --ttl-hours (default ${STOP_TTL_HOURS}, at most ${STOP_TTL_MAX_HOURS}). Hand-written rows and comments are kept; expired tool rows are removed.
The file is --out PATH, else ${STOP_FILE_ENV}; with neither the path is unknown and nothing is written.
--dry-run shows the rows and writes nothing. JSON is ${STOP_FILE_SCHEMA} with version 1.
A job kind is the job id minus its trailing counter (RQ-PHX-RECUTCOREC566 is RQ-PHX-RECUTCORE);
one-test filler jobs group by repo. Per kind: launches, empty, skipped before launch, merged, reverted and merged per launch.
A merge recorded as reverted (a revert event, a reverted flag or stamp, or a REVERTED outcome state) counts as reverted, never as merged.
keep: merged per launch ${JOB_KEEP_RATE} or more. stop: ${JOB_STOP_MIN_LAUNCHES} or more ended launches, merged per launch under ${JOB_STOP_RATE}
and no merge in the last ${JOB_RECENT_LAUNCHES} launches. watch: the rest.
JSON is jobs.yield.v1 with version 1. An unreadable file prints unknown, never zero.`);
    return 0;
  }
  let hours = 24, json = false, stopList = false, seenSince = false, metrics: string | null = null;
  let by: YieldBy | 'family' | null = null, stopFile = false, dryRun = false, out: string | null = null, ttl: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--by' && by === null && !emptyWhy) {
      const value = args[++i];
      if (value !== 'source' && value !== 'lane' && value !== 'family') { console.error(usage); return 2; }
      by = value;
    } else if (arg === '--stop-list' && !stopList && !emptyWhy) stopList = true;
    else if (arg === '--stop-file' && !stopFile && !emptyWhy) stopFile = true;
    else if (arg === '--dry-run' && !dryRun && !emptyWhy) dryRun = true;
    else if (arg === '--out' && out === null && !emptyWhy) {
      out = args[++i] ?? '';
      if (!out || out.startsWith('-')) { console.error(usage); return 2; }
    } else if (arg === '--ttl-hours' && ttl === null && !emptyWhy) {
      ttl = /^\d+(\.\d+)?$/.test(args[++i] ?? '') ? Number(args[i]) : NaN;
      if (!(ttl > 0 && ttl <= STOP_TTL_MAX_HOURS)) { console.error(usage); return 2; }
    } else if (arg === '--metrics' && metrics === null) {
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
  if (stopFile ? stopList : dryRun || out !== null || ttl !== null) { console.error(usage); return 2; }
  if (by === 'source' || by === 'lane') {
    if (stopList || stopFile || emptyWhy) { console.error(usage); return 2; }
    const scoreboard = await readYieldBy({ by, hours, now, ...(metrics ? { metrics: resolve(metrics) } : {}), ...(read ? { read } : {}) });
    if (json) console.log(JSON.stringify(sanitizePublicJson(scoreboard)));
    else if (!scoreboard.known) { console.error(scoreboard.verdict); return 1; }
    else console.log(yieldByLines(scoreboard).join('\n'));
    return scoreboard.known ? 0 : 1;
  }
  const parts = await readJobYieldParts(metrics ?? join(runsRoot(), 'metrics', 'jobs.jsonl'), hours, now, read, emptyWhy || json);
  if (stopFile) return writeStops(parts, { ttl: ttl ?? STOP_TTL_HOURS, out, dryRun, json, now });
  const report = parts.report;

  if (emptyWhy) {
    const why = report.empty_why ?? await readJobsEmptyWhy(null, '', hours, now);
    console.log(json ? JSON.stringify(sanitizePublicJson(why)) : emptyWhyLines(why).join('\n'));
    return why.known ? 0 : 1;
  }
  if (json) console.log(JSON.stringify(sanitizePublicJson(report)));
  else if (stopList) {
    if (!report.known) { console.error(report.summary); return 1; }
    const families = report.families.filter(row => row.verdict === 'stop').map(row => row.family);
    if (families.length) console.log(families.join('\n'));
  } else console.log(jobYieldLines(report).join('\n'));
  return 0;
}
