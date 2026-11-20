/** `phm jobs tokens`: token use and coverage for one lane. Read-only. */
import { join } from 'node:path';
import { readLedgerLines, type YieldLineReader } from '../core/fleet/ledger-lines.js';
import { buildJobsCoverage, buildJobsTokens, JOB_COVERAGE_SCHEMA, JOB_TOKENS_SCHEMA, jobsCoverageLines, jobsTokensLines } from '../core/fleet/job-tokens.js';
import { runsRoot } from '../core/metrics/loop-collect.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: phm jobs tokens (--lane <lane> | --coverage) [--since 24h] [--metrics <jobs.jsonl>] [--json]';

export async function cmdJobsTokens(args: string[], read: YieldLineReader = readLedgerLines, now = Date.now()): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`${usage}
Token use of finished jobs in one lane. Reads the job metrics file (default: <fleet runs dir>/metrics/jobs.jsonl).
A job counts as measured when its finish row has tokens_total or its log (<fleet runs dir>/<job>.log) ends with a
Claude Code result object (--output-format json or stream-json) carrying usage; tokens are input + output + cache read + cache creation.
A job with no usage is unmeasured, never zero. coverage is measured / jobs.
--coverage shows every lane at once: jobs, measured, unknown and coverage. JSON is ${JOB_COVERAGE_SCHEMA} with version 1: schema, window_hours, known, total, lanes.
With --lane, JSON is ${JOB_TOKENS_SCHEMA} with version 1: schema, lane, jobs, measured, coverage, tokens_total, tokens_per_merged_pr, plus cost_usd, merged, merged_measured.`);
    return 0;
  }
  let lane: string | null = null, coverage = false, hours = 24, json = false, metrics: string | null = null, seenSince = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--coverage' && !coverage) coverage = true;
    else if (arg === '--lane' && lane === null) {
      lane = args[++i] ?? '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(lane)) { console.error(usage); return 2; }
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
  if ((lane === null) === !coverage || !(hours > 0 && hours <= 8760)) { console.error(usage); return 2; }
  const path = metrics ?? join(runsRoot(), 'metrics', 'jobs.jsonl');
  const lines: string[] = [];
  let ok = false;
  try { ok = await read(path, line => { lines.push(line); }); } catch { /* unknown below */ }
  const root = metrics ? join(path, '..', '..') : runsRoot();
  if (coverage) {
    const cov = ok ? await buildJobsCoverage(lines, root, hours, now) : { ...await buildJobsCoverage([], root, hours, now), known: false };
    console.log(json ? JSON.stringify(sanitizePublicJson(cov)) : jobsCoverageLines(cov).join('\n'));
    return cov.known ? 0 : 1;
  }
  const report = ok ? await buildJobsTokens(lines, root, lane!, hours, now) : { ...await buildJobsTokens([], root, lane!, hours, now), known: false };
  console.log(json ? JSON.stringify(sanitizePublicJson(report)) : jobsTokensLines(report).join('\n'));
  return report.known ? 0 : 1;
}
