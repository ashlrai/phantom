import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { emptyJobs, type EmptyJob } from '../core/fleet/empty-job-ledger.js';
import { classifyEmptyLog, FLEET_EMPTY_WHY_LOG_LINES, FLEET_EMPTY_WHY_REASONS, type FleetEmptyWhyReason } from '../core/fleet/empty-why-classify.js';
export { classifyEmptyLog, FLEET_EMPTY_WHY_LOG_LINES, FLEET_EMPTY_WHY_REASONS, type FleetEmptyWhyReason } from '../core/fleet/empty-why-classify.js';
export { emptyJobs, type EmptyJob } from '../core/fleet/empty-job-ledger.js';

export const FLEET_EMPTY_WHY_SCHEMA = 'fleet.empty-why.v1';
export const FLEET_EMPTY_WHY_DEFAULT_HOURS = 24;

export interface FleetEmptyWhyReport {
  schema: typeof FLEET_EMPTY_WHY_SCHEMA;
  readOnly: true;
  hours: number;
  total: number;
  by_reason: Record<FleetEmptyWhyReason, number>;
  by_lane: Record<string, Record<FleetEmptyWhyReason, number>>;
  /** Job ids per reason, in ledger order. */
  ids: Record<FleetEmptyWhyReason, string[]>;
}


const USAGE = `Usage: ashlr fleet empty-why [--hours N] [--json]
Tag each job that finished empty in the last N hours (default ${FLEET_EMPTY_WHY_DEFAULT_HOURS}) with one reason from the last ${FLEET_EMPTY_WHY_LOG_LINES} lines of its log: lint-env, interrupted, blocked, limit or other.
Prints counts per reason and lane, plus the job ids. Reads jobs.jsonl and <id>.log under ~/.ashlr-runs (ASHLR_RUNS_DIR overrides). Read-only.`;

const zero = (): Record<FleetEmptyWhyReason, number> => ({ 'lint-env': 0, interrupted: 0, blocked: 0, limit: 0, other: 0 });

/** Pure: build the report from jobs and a log lookup (null when missing). */
export function summarizeEmptyWhy(jobs: EmptyJob[], logs: Map<string, string | null>, hours: number): FleetEmptyWhyReport {
  const report: FleetEmptyWhyReport = {
    schema: FLEET_EMPTY_WHY_SCHEMA, readOnly: true, hours, total: jobs.length,
    by_reason: zero(), by_lane: {},
    ids: { 'lint-env': [], interrupted: [], blocked: [], limit: [], other: [] },
  };
  for (const { id, lane } of jobs) {
    const reason = classifyEmptyLog(logs.get(id) ?? null);
    report.by_reason[reason]++;
    (report.by_lane[lane] ??= zero())[reason]++;
    report.ids[reason].push(id);
  }
  report.by_lane = Object.fromEntries(Object.entries(report.by_lane).sort(([a], [b]) => a.localeCompare(b)));
  return report;
}

export type FleetEmptyWhyReader = (path: string) => Promise<string | null>;

const readOrNull: FleetEmptyWhyReader = path => readFile(path, 'utf8').catch(() => null);

function parseHours(args: string[]): { hours: number; json: boolean } | null {
  let hours = FLEET_EMPTY_WHY_DEFAULT_HOURS;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--hours' || arg.startsWith('--hours=')) {
      const raw = arg === '--hours' ? args[++i] : arg.slice('--hours='.length);
      if (raw === undefined || !/^\d+(\.\d+)?$/.test(raw) || Number(raw) <= 0) return null;
      hours = Number(raw);
    } else return null;
  }
  return { hours, json };
}

/** Read-only. The injected reader and clock are the only outside inputs. */
export async function cmdFleetEmptyWhy(
  args: string[],
  reader: FleetEmptyWhyReader = readOrNull,
  now: () => number = Date.now,
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const parsed = parseHours(args);
  if (!parsed) {
    console.error(USAGE);
    return 2;
  }
  const { hours, json } = parsed;
  const root = process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs');
  const ledger = await reader(join(root, 'metrics', 'jobs.jsonl'));
  if (ledger === null) {
    const msg = 'Jobs ledger is unreadable.';
    console.log(json ? JSON.stringify({ schema: FLEET_EMPTY_WHY_SCHEMA, readOnly: true, error: msg }) : msg);
    return 2;
  }
  const jobs = emptyJobs(ledger, now(), hours);
  const logs = new Map<string, string | null>();
  await Promise.all(jobs.map(async j => logs.set(j.id, await reader(join(root, `${j.id}.log`)))));
  const report = summarizeEmptyWhy(jobs, logs, hours);
  if (json) {
    console.log(JSON.stringify(report));
    return 0;
  }
  if (report.total === 0) console.log(`No empty jobs in the last ${hours} hours.`);
  else {
    console.log(`${report.total} empty jobs in the last ${hours} hours`);
    for (const r of FLEET_EMPTY_WHY_REASONS) if (report.by_reason[r]) console.log(`${r} ${report.by_reason[r]}: ${report.ids[r].join(' ')}`);
    for (const [lane, c] of Object.entries(report.by_lane)) {
      console.log(`${lane}: ${FLEET_EMPTY_WHY_REASONS.filter(r => c[r]).map(r => `${r} ${c[r]}`).join(', ')}`);
    }
  }
  return 0;
}
