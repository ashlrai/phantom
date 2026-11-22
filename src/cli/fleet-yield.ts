/** `phm fleet yield`: merged PRs per launch for every job family, and a ready stop row for each family that wastes launches. Read-only. */
import { join } from 'node:path';
import {
  FAMILY_STOP_HOURS, FAMILY_STOP_MIN_FINISHED, FAMILY_STOP_RATE, FAMILY_WATCH_RATE,
  readFamilyYield, type FamilyYieldReport, type FamilyYieldRow,
} from '../core/fleet/family-yield.js';
import { readLedgerLines, type YieldLineReader } from '../core/fleet/ledger-lines.js';
import { laneYieldLines, LANE_YIELD_SCHEMA, readLaneYield } from '../core/fleet/lane-yield-board.js';
import { STOP_FILE_ENV } from '../core/fleet/stop-file.js';
import type { YieldRow } from '../core/fleet/slot-yield.js';
export { readLedgerLines, type YieldLineReader };
import { runsRoot } from '../core/metrics/loop-collect.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: phm fleet yield [--by lane] [--hours 24 | --since 24h] [--metrics <jobs.jsonl>] [--json]';
const MAX_HOURS = 8760;

const tokens = (value: number | null) => value === null ? 'unknown' : String(value);
const familyLine = (r: FamilyYieldRow) => `  ${r.verdict.padEnd(5)} ${r.family}: ${r.reason}; last seen ${r.last_seen}`;
const otherLine = (r: YieldRow) => `  ${r.verdict}`;

export function familyYieldLines(report: FamilyYieldReport): string[] {
  if (!report.known) return ['Family yield: unknown (job metrics file unreadable)'];
  if (!report.launches) return [`No launches in the last ${report.window_hours} hours`];
  const section = <T>(title: string, rows: T[], line: (row: T) => string) => rows.length ? [title, ...rows.map(line)] : [];
  return [
    `${report.launches} launches in the last ${report.window_hours} hours, ${report.merged} merged, ${tokens(report.wasted_tokens)}${report.wasted_tokens_partial && report.wasted_tokens !== null ? '+' : ''} tokens on unmerged runs`,
    ...section('Job families, most wasted tokens first:', report.families, familyLine),
    ...section('Single jobs:', report.single, familyLine),
    ...section(`Stop rows (pattern, until, reason; tab separated, for the job stop file ${STOP_FILE_ENV}):`, report.stops, r => r.line),
    ...section('By lane:', report.lanes, otherLine),
    ...section('By tier:', report.tiers, otherLine),
    ...section('Lowest share merged:', report.launch_families.slice(0, 5), r => r.sentence),
  ];
}

export async function cmdFleetYield(args: string[], read: YieldLineReader = readLedgerLines, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}
Merged PRs per launch for every job family in the last --hours (default 24).
Reads the job metrics file (default: <fleet runs dir>/metrics/jobs.jsonl); --since 24h or 2d also works.
A merge recorded as reverted counts as reverted, never as merged; its tokens still count as wasted.
A family is the job id with its numbers collapsed: RQ-PHX-RECUTAPIC606 and RQ-PHX-RECUTCLIC607 are RQ-PHX-RECUT*C*,
RQ-MD12A111815Q8 is RQ-MD*A*Q8. Families of one job id are listed under Single jobs.
stop: ${FAMILY_STOP_MIN_FINISHED}+ finished runs and merged per launch under ${FAMILY_STOP_RATE}. watch: under ${FAMILY_WATCH_RATE}. keep: the rest.
Families sort by tokens spent on runs that did not merge. Missing token counts print as unknown, never zero.
Each stop family prints one row: anchored pattern, until (epoch seconds, ${FAMILY_STOP_HOURS} h ahead), reason.
phm jobs yield judges finer job kinds and can write the stop file itself (--stop-file).
JSON is fleet.family-yield.v1. launch_families groups ids minus trailing digits and one optional letter,
with launches, published PRs, merges, EMPTY counts, EMPTY-only tokens and merged_per_launch (worst first).
--by lane: one row per lane instead: launches, finished, PRs opened, merged PRs, empty rate, merged per launch and median minutes to merge. A job merged twice counts once; lanes with no launches are left out. JSON is ${LANE_YIELD_SCHEMA}.`);
    return 0;
  }
  let hours: number | null = null, json = false, metrics: string | null = null, byLane = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--by' && !byLane && args[i + 1] === 'lane') { byLane = true; i++; }
    else if (arg === '--metrics' && metrics === null) {
      metrics = args[++i] ?? '';
      if (!metrics || metrics.startsWith('-')) { console.error(usage); return 2; }
    } else if (arg === '--hours' && hours === null) {
      hours = /^\d+(\.\d+)?$/.test(args[++i] ?? '') ? Number(args[i]) : NaN;
    } else if (arg === '--since' && hours === null) {
      const match = /^(\d+(?:\.\d+)?)([hd])$/.exec(args[++i] ?? '');
      hours = match ? Number(match[1]) * (match[2] === 'd' ? 24 : 1) : NaN;
    } else { console.error(usage); return 2; }
    if (hours !== null && !(hours > 0 && hours <= MAX_HOURS)) { console.error(usage); return 2; }
  }
  if (byLane) {
    const lanes = await readLaneYield(metrics ?? join(runsRoot(), 'metrics', 'jobs.jsonl'), hours ?? 24, now, read);
    console.log(json ? JSON.stringify(sanitizePublicJson(lanes)) : laneYieldLines(lanes).join('\n'));
    return 0;
  }
  const report = await readFamilyYield(metrics ?? join(runsRoot(), 'metrics', 'jobs.jsonl'), hours ?? 24, now, read);
  console.log(json ? JSON.stringify(sanitizePublicJson(report)) : familyYieldLines(report).join('\n'));
  return 0;
}
