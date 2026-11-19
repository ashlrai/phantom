/** Read-only lane supply scoreboard: merged PRs per start, empty share and held launches per lane. */
import { readTaskCheckJobs, type TaskCheckReader } from './fleet-task-check.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: phm fleet lane-supply [--hours 24] [--json]';
/** Fewer starts than this is too small a sample to call a lane zero-merge or empty-heavy. */
const MIN_STARTS = 3;
const EMPTY_HEAVY = 0.5;
/** Jobs-ledger events that mean a launch was refused because the lane is held or backed off. */
const HELD_EVENTS = new Set(['autobackoff_hold', 'autobackoff_skip', 'authbackoff_skip']);

export type LaneSupplyStatus = 'healthy' | 'low-sample' | 'zero-merge' | 'empty-heavy' | 'held' | 'no-start';
export interface LaneSupplyRow {
  lane: string;
  starts: number;
  merged: number;
  /** Distinct jobs that finished in the window, and how many of them finished empty. */
  finishes: number;
  empty_finishes: number;
  held_launches: number;
  /** merged / starts; null with no starts. */
  merged_per_start: number | null;
  /** empty_finishes / finishes; null with no finishes. */
  empty_share: number | null;
  status: LaneSupplyStatus;
}
export interface LaneSupplyRecommendation { lane: string; status: LaneSupplyStatus; text: string }
export interface LaneSupplyReport {
  schema: 'fleet.lane-supply.v1';
  window_hours: number;
  /** false when the ledger could not be read; lanes is then empty. */
  known: boolean;
  lanes: LaneSupplyRow[];
  recommendations: LaneSupplyRecommendation[];
}

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const pct = (value: number | null): string => value === null ? 'n/a' : `${(value * 100).toFixed(0)}%`;

function statusOf(r: LaneSupplyRow): LaneSupplyStatus {
  if (r.starts === 0) return r.held_launches > 0 ? 'held' : 'no-start';
  if (r.starts < MIN_STARTS) return r.merged > 0 ? 'healthy' : 'low-sample';
  if (r.merged === 0) return 'zero-merge';
  return r.empty_share !== null && r.empty_share >= EMPTY_HEAVY ? 'empty-heavy' : 'healthy';
}

/** One plain sentence and one next command per lane that needs attention; healthy lanes get none. */
export function recommendLaneSupply(r: LaneSupplyRow): string | null {
  switch (r.status) {
    case 'held': return `${r.lane} started nothing and had ${r.held_launches} held launches. Run "phm fleet held" to see the hold, then release it.`;
    case 'no-start': return `${r.lane} started nothing and nothing is holding it. Run "phm fleet lane-idle" to see whether it has a target and queued work.`;
    case 'zero-merge': return `${r.lane} made ${r.starts} starts and none merged. Run "phm fleet empty-why" to see where the work is lost.`;
    case 'empty-heavy': return `${r.lane} finished empty ${pct(r.empty_share)} of the time. Run "phm fleet empty-causes", and queue real work for it.`;
    default: return null;
  }
}

/** Merged is counted once per job and a row's lane comes from itself or its job's launch row, as in lane-yield. */
export async function fleetLaneSupply(read: TaskCheckReader = readTaskCheckJobs, hours = 24, now = Date.now()): Promise<LaneSupplyReport> {
  if (!Number.isFinite(hours) || hours <= 0) throw new RangeError('Hours must be positive.');
  const report: LaneSupplyReport = { schema: 'fleet.lane-supply.v1', window_hours: hours, known: false, lanes: [], recommendations: [] };
  let raw: string | null;
  try { raw = await read(); } catch { raw = null; }
  if (raw === null) return report;
  const parsed: { row: Record<string, unknown>; id: string | null; at: number }[] = [];
  const launchLane = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const at = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(at)) continue;
    const id = text(row.job ?? row.job_id ?? row.id);
    const lane = text(row.lane);
    if (row.event === 'launch' && id !== null && lane !== null) launchLane.set(id, lane);
    parsed.push({ row, id, at });
  }
  const lanes = new Map<string, LaneSupplyRow>();
  const seen = new Set<string>();
  const finished = new Map<string, { lane: string; empty: boolean; at: number }>();
  const entryFor = (name: string): LaneSupplyRow => {
    let entry = lanes.get(name);
    if (!entry) {
      entry = { lane: name, starts: 0, merged: 0, finishes: 0, empty_finishes: 0, held_launches: 0, merged_per_start: null, empty_share: null, status: 'no-start' };
      lanes.set(name, entry);
    }
    return entry;
  };
  for (const { row, id, at } of parsed) {
    if (at > now || at < now - hours * 3_600_000) continue;
    const name = text(row.lane) ?? (id === null ? null : launchLane.get(id)) ?? 'unknown';
    // Any in-window row names the lane, so a lane that logged only skips still shows up as no-start.
    if (name !== 'unknown') entryFor(name);
    if (row.event === 'launch') entryFor(name).starts++;
    else if (typeof row.event === 'string' && HELD_EVENTS.has(row.event)) entryFor(name).held_launches++;
    else if (row.event === 'finish' && id !== null) {
      // Finish rows repeat; the latest one for a job decides whether it was empty.
      const prior = finished.get(id);
      if (!prior || at >= prior.at) finished.set(id, { lane: name, empty: row.empty === true, at });
    } else if (row.event === 'outcome' && row.state === 'MERGED' && id !== null && !seen.has(id)) { seen.add(id); entryFor(name).merged++; }
  }
  for (const f of finished.values()) {
    const entry = entryFor(f.lane);
    entry.finishes++;
    if (f.empty) entry.empty_finishes++;
  }
  for (const entry of lanes.values()) {
    entry.merged_per_start = entry.starts > 0 ? entry.merged / entry.starts : null;
    entry.empty_share = entry.finishes > 0 ? entry.empty_finishes / entry.finishes : null;
    entry.status = statusOf(entry);
  }
  report.known = true;
  report.lanes = [...lanes.values()].sort((a, b) => a.lane.localeCompare(b.lane));
  for (const entry of report.lanes) {
    const note = recommendLaneSupply(entry);
    if (note !== null) report.recommendations.push({ lane: entry.lane, status: entry.status, text: note });
  }
  return report;
}

export async function cmdFleetLaneSupply(args: string[], read: TaskCheckReader = readTaskCheckJobs, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nPer lane over the window (default 24 hours): starts, merged PRs per start, empty share of finishes and held launches (autobackoff_hold, autobackoff_skip, authbackoff_skip). Each lane is healthy, low-sample (under ${MIN_STARTS} starts), zero-merge, empty-heavy (half or more finishes empty), held (no starts, launches held) or no-start. Prints a plain recommendation for every lane that needs attention; --json prints the same as fleet.lane-supply.v1. Reads ~/.ashlr-runs/metrics/jobs.jsonl and changes nothing; unreadable metrics are unknown. Exit 0 when the report was produced.`);
    return 0;
  }
  let hours = 24, json = false, seenHours = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--hours' && !seenHours) { seenHours = true; hours = Number(args[++i]); }
    else { console.error(usage); return 2; }
  }
  if (!Number.isFinite(hours) || hours <= 0) { console.error(usage); return 2; }
  const report = await fleetLaneSupply(read, hours, now);
  if (json) { console.log(JSON.stringify(sanitizePublicJson(report))); return 0; }
  const lines = !report.known ? ['Lane supply: unknown (metrics unreadable)']
    : report.lanes.length === 0 ? [`Lane supply: no rows in the last ${hours} hours`]
    : [...report.lanes.map(r => `${r.lane}: ${r.status}; ${r.starts} starts, ${r.merged} merged (${r.merged_per_start === null ? 'n/a' : r.merged_per_start.toFixed(2)} per start), ${pct(r.empty_share)} empty, ${r.held_launches} held`),
      ...(report.recommendations.length ? ['', 'Do next:', ...report.recommendations.map(rec => `- ${rec.text}`)] : ['', 'No lane needs attention.'])];
  console.log(sanitizePublicJson(lines.join('\n')));
  return 0;
}
