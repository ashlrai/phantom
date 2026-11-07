/** Report PR jobs seen more than twice by (job, url) pair in the last N hours. */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = 'Usage: ashlr fleet pr-repeats [--hours N] [--json]';
const HOUR = 3_600_000;

/** Injected reader: the raw text of metrics/jobs.jsonl, or null when unreadable. */
export type PrRepeatsReader = () => Promise<string | null>;

export interface PrRepeat { job: string; url: string; count: number }
export interface FleetPrRepeatsReport {
  schema: 'fleet.pr-repeats.v1';
  window_hours: number;
  known: boolean;
  repeats: PrRepeat[];
}

const text = (v: unknown): string => (typeof v === 'string' && v.trim() ? v.trim() : '');
const defaultRead: PrRepeatsReader = () =>
  readFile(join(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'metrics', 'jobs.jsonl'), 'utf8')
    .then(d => d)
    .catch(() => null);

/** Group rows by (job, url) and return those seen more than twice. */
export function fleetPrRepeats(jsonl: string, now: number, hours: number): FleetPrRepeatsReport {
  const report: FleetPrRepeatsReport = { schema: 'fleet.pr-repeats.v1', window_hours: hours, known: false, repeats: [] };
  const windowStart = now - hours * HOUR;
  const counts = new Map<string, { job: string; url: string; count: number }>();

  for (const line of jsonl.split(/\r?\n/)) {
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;

    const cls = text(row.class);
    if (cls !== 'pr') continue;

    const url = text(row.url ?? row.pr_url);
    if (!url) continue;

    const at = Date.parse(text(row.ts));
    if (!Number.isFinite(at) || at < windowStart || at > now) continue;

    const job = text(row.job ?? row.job_id ?? row.id);
    if (!job) continue;

    const key = job + '\t' + url;
    const entry = counts.get(key);
    if (entry) entry.count++;
    else counts.set(key, { job, url, count: 1 });
  }

  const repeats: PrRepeat[] = [];
  for (const entry of counts.values()) {
    if (entry.count > 2) repeats.push(entry);
  }
  repeats.sort((a, b) => b.count - a.count || a.url.localeCompare(b.url));
  report.repeats = repeats;
  report.known = repeats.length > 0 || jsonl.trim().length > 0;
  return report;
}

export async function cmdFleetPrRepeats(
  args: string[],
  read: PrRepeatsReader = defaultRead,
  now: number = Date.now()
): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  let hours = 6;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { console.error(USAGE); return 2; }
    seen.add(arg);
    if (arg === '--json') continue;
    if (arg === '--hours') {
      const value = args[++i] ?? '';
      hours = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(hours) || hours <= 0) { console.error(USAGE); return 2; }
    } else { console.error(USAGE); return 2; }
  }

  let data: string | null;
  try { data = await read(); } catch { data = null; }

  if (data === null) {
    const r: FleetPrRepeatsReport = { schema: 'fleet.pr-repeats.v1', window_hours: hours, known: false, repeats: [] };
    console.log(sanitizePublicJson(JSON.stringify(r)));
    return 0;
  }

  const r = fleetPrRepeats(data, now, hours);
  console.log(sanitizePublicJson(json ? JSON.stringify(r) : JSON.stringify(r)));
  return 0;
}
