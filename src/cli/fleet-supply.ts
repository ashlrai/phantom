/** Read-only: counts what each batch did in the last 24 h, per hour. Never changes dispatch or merge authority. */
import { readTaskCheckJobs, taskBatch, type TaskCheckReader } from './fleet-task-check.js';

const usage = 'Usage: ashlr fleet supply [--json]';
const HOUR_MS = 3_600_000;
const WINDOW_HOURS = 24;
const COUNTS = ['launch', 'skipped_empty', 'precheck_skip', 'pr_opened', 'merged'] as const;
type Count = (typeof COUNTS)[number];
const LABELS: Record<Count, string> = {
  launch: 'launched', skipped_empty: 'skipped empty', precheck_skip: 'precheck skipped', pr_opened: 'PRs opened', merged: 'merged',
};

export type SupplyReader = TaskCheckReader;
export type SupplyCounts = Record<Count, number>;
export interface SupplyHour extends SupplyCounts { hour: string }
export interface SupplyBatch { batch: string; total: SupplyCounts; hours: SupplyHour[] }
export interface SupplyReport {
  schema: 'fleet.supply.v1';
  /** false when the metrics file could not be read; batches is then 'unknown', never an empty list. */
  known: boolean;
  window_hours: 24;
  batches: SupplyBatch[] | 'unknown';
}

const empty = (): SupplyCounts => ({ launch: 0, skipped_empty: 0, precheck_skip: 0, pr_opened: 0, merged: 0 });

/** Which counts one metrics row adds to. A row can be both a launch-style and a PR row only if it says so. */
function classify(row: Record<string, unknown>): Count[] {
  const kinds = [row.event, row.outcome, row.state];
  const hit: Count[] = [];
  if (kinds.includes('launch')) hit.push('launch');
  if (kinds.includes('skipped_empty')) hit.push('skipped_empty');
  else if (kinds.includes('precheck_skip')) hit.push('precheck_skip');
  if (typeof row.url === 'string' && row.url !== '' && 'class' in row) hit.push('pr_opened');
  if (row.event === 'outcome' && typeof row.state === 'string' && row.state.toUpperCase() === 'MERGED') hit.push('merged');
  return hit;
}

export async function fleetSupply(read: SupplyReader, now = Date.now()): Promise<SupplyReport> {
  const base = { schema: 'fleet.supply.v1', window_hours: WINDOW_HOURS } as const;
  let text: string | null;
  try { text = await read(); } catch { text = null; }
  if (text === null) return { ...base, known: false, batches: 'unknown' };
  const byBatch = new Map<string, Map<string, SupplyHour>>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      row = parsed as Record<string, unknown>;
    } catch { continue; }
    const id = row.job ?? row.job_id ?? row.id;
    if (typeof id !== 'string' || id === '') continue;
    const at = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(at) || at > now || now - at > WINDOW_HOURS * HOUR_MS) continue;
    const hit = classify(row);
    if (!hit.length) continue;
    const batch = taskBatch(id);
    const hour = new Date(Math.floor(at / HOUR_MS) * HOUR_MS).toISOString();
    const hours = byBatch.get(batch) ?? new Map<string, SupplyHour>();
    byBatch.set(batch, hours);
    const bucket = hours.get(hour) ?? { hour, ...empty() };
    hours.set(hour, bucket);
    for (const key of hit) bucket[key]++;
  }
  const batches = [...byBatch].map(([batch, hours]): SupplyBatch => {
    const list = [...hours.values()].sort((a, b) => a.hour.localeCompare(b.hour));
    const total = empty();
    for (const h of list) for (const key of COUNTS) total[key] += h[key];
    return { batch, total, hours: list };
  }).sort((a, b) => a.batch.localeCompare(b.batch));
  return { ...base, known: true, batches };
}

/** One plain line per batch: "RQ-X-FILLQ: 5 launched, 2 skipped empty, ...". */
export function formatSupply(report: SupplyReport): string {
  if (report.batches === 'unknown') return 'unknown (metrics unreadable)';
  if (!report.batches.length) return 'no batch activity in the last 24 hours';
  return report.batches.map(b => `${b.batch}: ${COUNTS.map(key => `${b.total[key]} ${LABELS[key]}`).join(', ')}`).join('\n');
}

export async function cmdFleetSupply(args: string[], read: SupplyReader = readTaskCheckJobs, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nCounts launches, skipped_empty, precheck_skip, opened PRs and MERGED outcomes per batch (job id minus its trailing number) and hour over the last 24 hours. Reads ~/.ashlr-runs/metrics/jobs.jsonl; an unreadable file prints unknown, never zero. --json adds the per-hour rows.`);
    return 0;
  }
  if (args.some(arg => arg !== '--json') || args.length > 1) {
    console.error(`error: invalid fleet supply arguments\n${usage}`);
    return 2;
  }
  const report = await fleetSupply(read, now);
  console.log(args.length ? JSON.stringify(report) : formatSupply(report));
  return 0;
}
