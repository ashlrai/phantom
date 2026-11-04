/** Read-only yield per lane from the host jobs ledger. Exit 1 when any lane is red. */
import { readTaskCheckJobs, type TaskCheckReader } from './fleet-task-check.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet lane-yield [--hours 2] [--json]';
const RED_MIN_ROWS = 10;

export interface LaneYieldRow {
  lane: string;
  launches: number;
  /** precheck_skip rows keyed by their code ("none" when a row has no code). */
  skips_by_code: Record<string, number>;
  skips: number;
  empty_finishes: number;
  merged: number;
  /** All rows seen for the lane in the window, of any event; the red test uses this. */
  rows: number;
  /** merged / (launches + skips); null when there are neither. */
  yield: number | null;
  red: boolean;
}
export interface LaneYieldReport {
  schema: 'fleet.lane-yield.v1';
  window_hours: number;
  /** false when the ledger could not be read; lanes is then empty and red false. */
  known: boolean;
  red: boolean;
  lanes: LaneYieldRow[];
}

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;

/** Counts merged once per job, since outcome rows repeat; a row's lane comes from itself or its job's launch row. */
export async function fleetLaneYield(read: TaskCheckReader = readTaskCheckJobs, hours = 2, now = Date.now()): Promise<LaneYieldReport> {
  if (!Number.isFinite(hours) || hours <= 0) throw new RangeError('Hours must be positive.');
  const report: LaneYieldReport = { schema: 'fleet.lane-yield.v1', window_hours: hours, known: false, red: false, lanes: [] };
  let raw: string | null;
  try { raw = await read(); } catch { raw = null; }
  if (raw === null) return report;
  const parsed: { row: Record<string, unknown>; id: string | null; at: number }[] = [];
  const launchLane = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const r = row as Record<string, unknown>;
    const at = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
    if (!Number.isFinite(at)) continue;
    const id = text(r.job ?? r.job_id ?? r.id);
    const lane = text(r.lane);
    if (r.event === 'launch' && id !== null && lane !== null) launchLane.set(id, lane);
    parsed.push({ row: r, id, at });
  }
  const lanes = new Map<string, LaneYieldRow>();
  const mergedJobs = new Set<string>();
  for (const { row, id, at } of parsed) {
    if (at > now || at < now - hours * 3_600_000) continue;
    const name = text(row.lane) ?? (id === null ? null : launchLane.get(id)) ?? 'unknown';
    const entry = lanes.get(name) ?? { lane: name, launches: 0, skips_by_code: {}, skips: 0, empty_finishes: 0, merged: 0, rows: 0, yield: null, red: false };
    lanes.set(name, entry);
    entry.rows++;
    if (row.event === 'launch') entry.launches++;
    else if (row.event === 'precheck_skip') {
      const code = row.code === undefined || row.code === null ? 'none' : String(row.code);
      entry.skips_by_code[code] = (entry.skips_by_code[code] ?? 0) + 1;
      entry.skips++;
    } else if (row.event === 'finish' && row.empty === true) entry.empty_finishes++;
    else if (row.event === 'outcome' && row.state === 'MERGED' && id !== null && !mergedJobs.has(id)) { mergedJobs.add(id); entry.merged++; }
  }
  for (const entry of lanes.values()) {
    const attempts = entry.launches + entry.skips;
    entry.yield = attempts > 0 ? entry.merged / attempts : null;
    entry.red = entry.rows >= RED_MIN_ROWS && entry.skips * 2 > entry.rows;
  }
  report.known = true;
  report.lanes = [...lanes.values()].sort((a, b) => a.lane.localeCompare(b.lane));
  report.red = report.lanes.some(entry => entry.red);
  return report;
}

export async function cmdFleetLaneYield(args: string[], read: TaskCheckReader = readTaskCheckJobs, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nPer lane, count launches, precheck skips by code, empty finishes and MERGED outcomes (joined to the lane through the job's launch row) in the window. Yield is merged over launches plus skips. A lane is red when skips are over half of its ${RED_MIN_ROWS}+ rows; exit 1 on red. Reads ~/.ashlr-runs/metrics/jobs.jsonl; unreadable metrics are unknown (exit 0).`);
    return 0;
  }
  let hours = 2, json = false, seenHours = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--hours' && !seenHours) { seenHours = true; hours = Number(args[++i]); }
    else { console.error(usage); return 2; }
  }
  if (!Number.isFinite(hours) || hours <= 0) { console.error(usage); return 2; }
  const report = await fleetLaneYield(read, hours, now);
  const pct = (value: number | null) => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
  const codes = (r: LaneYieldRow) => Object.entries(r.skips_by_code).sort(([a], [b]) => a.localeCompare(b)).map(([c, n]) => `${c}:${n}`).join(',');
  console.log(json ? JSON.stringify(sanitizePublicJson(report)) : sanitizePublicJson(!report.known ? 'Lane yield: unknown (metrics unreadable)'
    : report.lanes.length === 0 ? `Lane yield: no rows in the last ${hours} hours`
    : report.lanes.map(r => `${r.lane}: yield ${pct(r.yield)} (${r.merged} merged / ${r.launches} launches + ${r.skips} skips${r.skips ? ` [${codes(r)}]` : ''}), ${r.empty_finishes} empty finishes${r.red ? ' RED' : ''}`).join('\n')));
  return report.red ? 1 : 0;
}
