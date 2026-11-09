import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const usage = `Usage: ashlr fleet pr-wait [--hours N] [--max-hours N] [--json]
List unmerged PR-OPEN jobs, oldest first. Age is measured from the first dated PR or OPEN outcome in the jobs ledger; missing age is unknown. Merge percentiles use outcome rows in the last N hours (median and nearest-rank p90). Exit 1 when a known age exceeds max-hours.`;
type Row = Record<string, unknown>;

export function fleetPrWait(queue: string, jobs: string, hours: number, maxHours: number, now: number) {
  const ids = new Set<string>();
  for (const line of queue.split(/\r?\n/)) {
    const match = /^- PR-OPEN ([A-Za-z0-9][A-Za-z0-9._-]*) \(/.exec(line);
    if (match) ids.add(match[1]!);
  }
  const merged = new Set<string>(), opened = new Map<string, number>(), times: number[] = [];
  for (const line of jobs.split(/\r?\n/)) {
    let row: Row;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      row = value as Row;
    } catch { continue; }
    const id = row.job ?? row.job_id ?? row.jobId;
    const at = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
    if (row.event === 'outcome' && row.state === 'MERGED') {
      if (typeof id === 'string') merged.add(id);
      if (Number.isFinite(at) && at <= now && at >= now - hours * 3_600_000 &&
          typeof row.ttm_s === 'number' && Number.isFinite(row.ttm_s) && row.ttm_s >= 0) times.push(row.ttm_s);
    }
    if (typeof id === 'string' && Number.isFinite(at) && at <= now &&
        (row.class === 'pr' || (row.event === 'outcome' && row.state === 'OPEN'))) {
      opened.set(id, Math.min(opened.get(id) ?? Infinity, at));
    }
  }
  times.sort((a, b) => a - b);
  const n = times.length;
  const waiting = [...ids].filter(id => !merged.has(id)).map(id => {
    const at = opened.get(id);
    const age_hours = at === undefined ? null : (now - at) / 3_600_000;
    return { id, opened_at: at === undefined ? null : new Date(at).toISOString(), age_hours,
      overdue: age_hours !== null && age_hours > maxHours };
  }).sort((a, b) => (b.age_hours ?? -1) - (a.age_hours ?? -1) || a.id.localeCompare(b.id));
  return { schema: 'fleet.pr-wait.v1', readOnly: true, hours, max_hours: maxHours, waiting,
    merged_rows: n, p50_ttm_s: n ? (times[Math.floor((n - 1) / 2)]! / 2 + times[Math.floor(n / 2)]! / 2) : null,
    p90_ttm_s: n ? times[Math.ceil(n * 0.9) - 1]! : null };
}

export async function cmdFleetPrWait(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let hours = 24, maxHours = 6, json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { console.error(usage); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if ((arg === '--hours' || arg === '--max-hours') && args[i + 1] &&
      Number.isFinite(Number(args[i + 1])) && Number(args[i + 1]) > 0) {
      const value = Number(args[++i]);
      if (arg === '--hours') hours = value; else maxHours = value;
    } else { console.error(usage); return 2; }
  }
  const root = process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs');
  try {
    const [queue, jobs] = await Promise.all(['queue/router-queue.md', 'metrics/jobs.jsonl']
      .map(path => readFile(join(root, path), 'utf8')));
    const report = fleetPrWait(queue!, jobs!, hours, maxHours, Date.now());
    console.log(json ? JSON.stringify(report) : [
      ...report.waiting.map(row => `${row.id}: ${row.age_hours === null ? 'age unknown' : `${row.age_hours.toFixed(2)} hours${row.overdue ? ' (overdue)' : ''}`}`),
      ...(report.waiting.length ? [] : ['No PR-OPEN jobs waiting.']),
      `Last ${hours} hours: p50 ${report.p50_ttm_s ?? 'unknown'}s, p90 ${report.p90_ttm_s ?? 'unknown'}s (${report.merged_rows} merged rows).`,
    ].join('\n'));
    return report.waiting.some(row => row.overdue) ? 1 : 0;
  } catch { console.error('fleet pr-wait: queue or metrics evidence unavailable'); return 1; }
}
