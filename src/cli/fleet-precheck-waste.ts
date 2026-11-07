/** Read-only precheck skips over the trailing six hours. */
import { readTaskCheckJobs, type TaskCheckReader } from './fleet-task-check.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet precheck-waste [--json]';
const HOUR = 3_600_000;
export interface WasteCounts { launches: number; skips: number; skip_share: number }
export interface WasteHour extends WasteCounts { hour: string }
export interface WasteGroup extends WasteCounts { name: string; hours: WasteHour[] }
export interface PrecheckWasteReport {
  schema: 'fleet.precheck-waste.v1';
  window_hours: 6;
  known: boolean;
  totals: WasteCounts | null;
  hours: WasteHour[];
  by_code: WasteGroup[];
  by_repo: WasteGroup[];
  top_prefixes: WasteGroup[];
}
const empty = (): WasteCounts => ({ launches: 0, skips: 0, skip_share: 0 });
function add(counts: WasteCounts, skip: boolean): void {
  if (skip) counts.skips++; else counts.launches++;
  counts.skip_share = counts.skips / (counts.launches + counts.skips);
}
/** Prefix ends at the first digit, preserving queue-id separators; no digit means the whole id. */
export function precheckPrefix(id: string): string { return id.split(/\d/, 1)[0] || 'unknown'; }

export async function fleetPrecheckWaste(read: TaskCheckReader = readTaskCheckJobs, now = Date.now()): Promise<PrecheckWasteReport> {
  const report: PrecheckWasteReport = { schema: 'fleet.precheck-waste.v1', window_hours: 6,
    known: false, totals: null, hours: [], by_code: [], by_repo: [], top_prefixes: [] };
  let text: string | null;
  try { text = await read(); } catch { text = null; }
  if (text === null) return report;
  report.known = true;
  report.totals = empty();
  const hours = new Map<string, WasteHour>();
  const groups = [new Map<string, WasteGroup>(), new Map<string, WasteGroup>(), new Map<string, WasteGroup>()];
  const label = (value: unknown): string => typeof value === 'string' && value.trim() ? value : 'unknown';
  for (const line of text.split(/\r?\n/)) {
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      row = value as Record<string, unknown>;
    } catch { continue; }
    if (row.event !== 'launch' && row.event !== 'precheck_skip') continue;
    const at = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(at) || at < now - 6 * HOUR || at > now) continue;
    const skip = row.event === 'precheck_skip';
    const hour = new Date(Math.floor(at / HOUR) * HOUR).toISOString();
    add(report.totals, skip);
    const bucket = hours.get(hour) ?? { hour, ...empty() };
    hours.set(hour, bucket);
    add(bucket, skip);
    const names = [label(row.code), label(row.repo), precheckPrefix(label(row.job ?? row.job_id ?? row.id))];
    groups.forEach((map, i) => {
      // Codes describe skips; launches have no precheck code.
      if (i === 0 && !skip) return;
      const name = names[i]!;
      const group = map.get(name) ?? { name, ...empty(), hours: [] };
      map.set(name, group);
      add(group, skip);
      let h = group.hours.find(item => item.hour === hour);
      if (!h) { h = { hour, ...empty() }; group.hours.push(h); }
      add(h, skip);
    });
  }
  const sorted = groups.map(map => [...map.values()].map(group => ({ ...group,
    hours: group.hours.sort((a, b) => a.hour.localeCompare(b.hour)),
  })).sort((a, b) => b.skips - a.skips || a.name.localeCompare(b.name)));
  report.hours = [...hours.values()].sort((a, b) => a.hour.localeCompare(b.hour));
  [report.by_code, report.by_repo, report.top_prefixes] = [sorted[0]!, sorted[1]!, sorted[2]!.slice(0, 10)];
  return report;
}

export async function cmdFleetPrecheckWaste(args: string[], read: TaskCheckReader = readTaskCheckJobs, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nRead six hours of jobs.jsonl. Count precheck skips by code, repo, prefix (before the first digit) and UTC hour. Top 10 prefixes by skips. Share = skips / (launches + skips), from 0 to 1; code groups contain skips only. Unread metrics are unknown.`);
    return 0;
  }
  if (args.length > 1 || args.some(arg => arg !== '--json')) { console.error(usage); return 2; }
  const report = await fleetPrecheckWaste(read, now);
  console.log(sanitizePublicJson(args.length ? JSON.stringify(sanitizePublicJson(report)) : report.totals === null
    ? 'Precheck skips: unknown (metrics unreadable)'
    : [`Last 6 hours: ${report.totals.skips} precheck skips, ${report.totals.launches} launches (${(report.totals.skip_share * 100).toFixed(1)}% skipped).`,
      ...report.top_prefixes.map(p => `${p.name}: ${p.skips} skips, ${p.launches} launches`)].join('\n')));
  return 0;
}
