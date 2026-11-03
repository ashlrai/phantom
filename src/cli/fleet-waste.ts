/** Read-only waste counts from the host jobs ledger. */
import { readTaskCheckJobs, type TaskCheckReader } from './fleet-task-check.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet waste [--hours 6] [--json]';
export interface FleetWasteCounts {
  precheck_skip: Record<string, number>;
  empty: number;
  pool_error: number;
  no_pr: number;
}
export interface FleetWasteReport {
  schema: 'fleet.waste.v1'; window_hours: number; known: boolean;
  totals: FleetWasteCounts | null;
  by_lane: { name: string; counts: FleetWasteCounts }[];
  by_repo: { name: string; counts: FleetWasteCounts }[];
  top_prefixes: { prefix: string; count: number }[];
}
const counts = (): FleetWasteCounts => ({ precheck_skip: {}, empty: 0, pool_error: 0, no_pr: 0 });
const label = (v: unknown): string => typeof v === 'string' && v.trim() ? v : 'unknown';
export function wastePrefix(id: string): string { return id.replace(/A\d{6}/g, '').replace(/\d+$/, '') || 'unknown'; }

/** Row counts can overlap; prefix counts count each waste row once, plus each job without a PR. */
export async function fleetWaste(read: TaskCheckReader = readTaskCheckJobs, hours = 6, now = Date.now()): Promise<FleetWasteReport> {
  if (!Number.isFinite(hours) || hours <= 0) throw new RangeError('Hours must be positive.');
  const report: FleetWasteReport = { schema: 'fleet.waste.v1', window_hours: hours, known: false,
    totals: null, by_lane: [], by_repo: [], top_prefixes: [] };
  let text: string | null;
  try { text = await read(); } catch { text = null; }
  if (text === null) return report;
  const rows: { row: Record<string, unknown>; at: number; id: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const r = row as Record<string, unknown>;
      const at = typeof r.ts === 'string' ? Date.parse(r.ts) : NaN;
      if (Number.isFinite(at) && at <= now) rows.push({ row: r, at, id: label(r.job ?? r.job_id ?? r.id) });
    } catch { /* Ignore partial or malformed ledger lines. */ }
  }
  rows.sort((a, b) => a.at - b.at);
  const launches = new Map<string, Record<string, unknown>>();
  const prs = new Set<string>();
  for (const { row, id } of rows) {
    if (id === 'unknown') continue;
    if (row.event === 'launch') launches.set(id, row);
    if ([row.url, row.pr_url].some(url => typeof url === 'string' && /^https?:\/\/\S+\/pull\/\d+\/?$/.test(url))) prs.add(id);
  }
  report.known = true;
  report.totals = counts();
  const lanes = new Map<string, FleetWasteCounts>(), repos = new Map<string, FleetWasteCounts>(), prefixes = new Map<string, number>();
  const add = (row: Record<string, unknown>, id: string, skip: boolean, empty: boolean, error: boolean, noPr = false) => {
    const launch = launches.get(id);
    const buckets = [report.totals!];
    for (const [map, name] of [[lanes, label(row.lane ?? launch?.lane)], [repos, label(row.repo ?? launch?.repo)]] as const) {
      const bucket = map.get(name) ?? counts(); map.set(name, bucket); buckets.push(bucket);
    }
    for (const bucket of buckets) {
      if (skip) {
        const code = typeof row.code === 'number' ? String(row.code) : label(row.code);
        Object.defineProperty(bucket.precheck_skip, code, { value: (Object.hasOwn(bucket.precheck_skip, code) ? bucket.precheck_skip[code]! : 0) + 1, enumerable: true, configurable: true });
      }
      bucket.empty += Number(empty); bucket.pool_error += Number(error); bucket.no_pr += Number(noPr);
    }
    if (skip || empty || error || noPr) { const prefix = wastePrefix(id); prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1); }
  };
  for (const { row, at, id } of rows) {
    if (at < now - hours * 3_600_000) continue;
    if (row.event === 'precheck_skip') add(row, id, true, false, false);
    if (row.event === 'finish') add(row, id, false, row.empty === true, row.pool_error !== null && row.pool_error !== undefined && row.pool_error !== '' && row.pool_error !== false);
  }
  for (const [id, launch] of launches) {
    if (Date.parse(String(launch.ts)) >= now - hours * 3_600_000 && !prs.has(id)) add(launch, id, false, false, false, true);
  }
  const groups = (map: Map<string, FleetWasteCounts>) => [...map].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, counts: value }));
  report.by_lane = groups(lanes); report.by_repo = groups(repos);
  report.top_prefixes = [...prefixes].map(([prefix, count]) => ({ prefix, count })).sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix)).slice(0, 5);
  return report;
}

export async function cmdFleetWaste(args: string[], read: TaskCheckReader = readTaskCheckJobs, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nCount precheck skips by code, empty finishes, pool errors and launched jobs without a PR. Group by lane and repo; show five ID prefixes by waste count. Counts overlap. Reads ~/.ashlr-runs/metrics/jobs.jsonl; unreadable metrics are unknown.`); return 0;
  }
  let hours = 6, json = false, seenHours = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--hours' && !seenHours) { seenHours = true; hours = Number(args[++i]); }
    else { console.error(usage); return 2; }
  }
  if (!Number.isFinite(hours) || hours <= 0) { console.error(usage); return 2; }
  const report = await fleetWaste(read, hours, now);
  const describe = (c: FleetWasteCounts) => `${JSON.stringify(c.precheck_skip)} precheck skips by code, ${c.empty} empty finishes, ${c.pool_error} pool errors, ${c.no_pr} launched jobs without a PR`;
  console.log(json ? JSON.stringify(sanitizePublicJson(report)) : sanitizePublicJson(report.totals === null ? 'Fleet waste: unknown (metrics unreadable)'
    : [`Last ${hours} hours: ${describe(report.totals)}`, ...report.by_lane.map(g => `Lane ${g.name}: ${describe(g.counts)}`),
      ...report.by_repo.map(g => `Repo ${g.name}: ${describe(g.counts)}`), ...report.top_prefixes.map(g => `${g.prefix}: ${g.count}`)].join('\n')));
  return 0;
}
