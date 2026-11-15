/** Read-only report of explicit empty outcomes in the jobs ledger. */
import { readTaskCheckJobs, type TaskCheckReader } from './fleet-task-check.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: phm fleet empties [--since 24h] [--json]';
type Group = { lane: string; repo: string; reason: string; count: number };
type Reason = { reason: string; count: number; suggested_filler_rule: string };
export interface FleetEmptiesReport {
  schema: 'fleet.empties.v1'; window_hours: number; known: boolean;
  total: number | null; groups: Group[]; top_reasons: Reason[];
}
const label = (value: unknown): string => typeof value === 'string' && value.trim() ? value.trim() : 'unknown';

export async function fleetEmpties(read: TaskCheckReader = readTaskCheckJobs, hours = 24, now = Date.now()): Promise<FleetEmptiesReport> {
  if (!Number.isFinite(hours) || hours <= 0) throw new RangeError('Hours must be positive.');
  const report: FleetEmptiesReport = { schema: 'fleet.empties.v1', window_hours: hours, known: false, total: null, groups: [], top_reasons: [] };
  let text: string | null;
  try { text = await read(); } catch { text = null; }
  if (text === null) return report;
  const groups = new Map<string, Group>(), reasons = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    let row: Record<string, unknown>;
    try { const value: unknown = JSON.parse(line); if (!value || typeof value !== 'object' || Array.isArray(value)) continue; row = value as Record<string, unknown>; } catch { continue; }
    const at = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(at) || at > now || at < now - hours * 3_600_000) continue;
    if (!(row.event === 'outcome' && row.empty === true) && ![row.event, row.outcome, row.state].includes('EMPTY_DONE')) continue;
    const lane = label(row.lane), repo = label(row.repo), reason = label(row.reason);
    const key = JSON.stringify([lane, repo, reason]);
    const group = groups.get(key) ?? { lane, repo, reason, count: 0 };
    group.count++; groups.set(key, group); reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  report.known = true;
  report.groups = [...groups.values()].sort((a, b) => b.count - a.count || a.lane.localeCompare(b.lane) || a.repo.localeCompare(b.repo) || a.reason.localeCompare(b.reason));
  report.total = report.groups.reduce((sum, group) => sum + group.count, 0);
  report.top_reasons = [...reasons].map(([reason, count]) => ({ reason, count, suggested_filler_rule: reason === 'unknown'
    ? 'Record an explicit reason for empty outcomes before proposing a filler rule.'
    : 'Review this reason and add a filler precheck that prevents matching empty tasks.' }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)).slice(0, 5);
  return report;
}

export async function cmdFleetEmpties(args: string[], read: TaskCheckReader = readTaskCheckJobs, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nGroup explicit empty outcomes by lane, repo and recorded reason. Shows the five most common reasons and suggested filler rules. Reads metrics/jobs.jsonl; missing fields and unreadable metrics are unknown.`); return 0;
  }
  let hours = 24, json = false, seenSince = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--since' && !seenSince) {
      seenSince = true; const match = /^(\d+(?:\.\d+)?)h$/.exec(args[++i] ?? '');
      if (!match) { console.error(usage); return 2; } hours = Number(match[1]);
    } else { console.error(usage); return 2; }
  }
  if (!Number.isFinite(hours) || hours <= 0) { console.error(usage); return 2; }
  const report = await fleetEmpties(read, hours, now);
  const output = json ? report : report.total === null ? 'Empty jobs: unknown (metrics unreadable)' : [
    `Empty outcomes in the last ${hours} hours: ${report.total}`,
    ...report.groups.map(g => `${g.lane} / ${g.repo} / ${g.reason}: ${g.count}`),
    ...report.top_reasons.map(r => `${r.reason}: ${r.count}. Suggested filler rule: ${r.suggested_filler_rule}`),
  ].join('\n');
  console.log(json ? JSON.stringify(sanitizePublicJson(output)) : sanitizePublicJson(output));
  return 0;
}
