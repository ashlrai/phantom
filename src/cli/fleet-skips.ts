/** Read-only: precheck skip rate per repo and lane from the tail of jobs.jsonl. */
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet skips [--hours N] [--json]';
const HOUR = 3_600_000;
const TAIL_LINES = 3000;
const TAIL_BYTES = 8 * 1024 * 1024;

/** Injected reader: the last lines of jobs.jsonl, or null when unreadable. */
export type SkipsReader = (lines: number) => Promise<string[] | null>;

export interface SkipCounts { launches: number; skips: number; skip_share: number }
export interface SkipGroup extends SkipCounts { name: string }
export interface FleetSkipsReport {
  schema: 'fleet.skips.v1';
  window_hours: number;
  known: boolean;
  totals: SkipCounts | null;
  by_repo: SkipGroup[];
  by_lane: SkipGroup[];
}

export const readJobsTail: SkipsReader = async (lines) => {
  try {
    const fh = await open(join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'), 'r');
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const all = buf.toString('utf8').split(/\r?\n/);
      if (size > len) all.shift(); // first line may be cut mid-row
      return all.filter(Boolean).slice(-lines);
    } finally { await fh.close(); }
  } catch { return null; }
};

const bump = (c: SkipCounts, skip: boolean): void => {
  if (skip) c.skips++; else c.launches++;
  c.skip_share = c.skips / (c.launches + c.skips);
};
const label = (v: unknown): string => typeof v === 'string' && v.trim() ? v.trim() : 'unknown';

export async function fleetSkips(read: SkipsReader = readJobsTail, hours = 6, now = Date.now()): Promise<FleetSkipsReport> {
  const report: FleetSkipsReport = { schema: 'fleet.skips.v1', window_hours: hours, known: false, totals: null, by_repo: [], by_lane: [] };
  let lines: string[] | null;
  try { lines = await read(TAIL_LINES); } catch { lines = null; }
  if (!lines) return report;
  report.known = true;
  report.totals = { launches: 0, skips: 0, skip_share: 0 };
  const maps = [new Map<string, SkipGroup>(), new Map<string, SkipGroup>()];
  for (const line of lines.slice(-TAIL_LINES)) {
    let row: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(line);
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      row = v as Record<string, unknown>;
    } catch { continue; }
    if (row.event !== 'launch' && row.event !== 'precheck_skip') continue;
    const at = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN;
    if (!Number.isFinite(at) || at < now - hours * HOUR || at > now) continue;
    const skip = row.event === 'precheck_skip';
    bump(report.totals, skip);
    [label(row.repo), label(row.pool ?? row.lane)].forEach((name, i) => {
      const g = maps[i]!.get(name) ?? { name, launches: 0, skips: 0, skip_share: 0 };
      maps[i]!.set(name, g);
      bump(g, skip);
    });
  }
  // Worst first: highest skip share, then most skips, then name.
  const order = (a: SkipGroup, b: SkipGroup): number => b.skip_share - a.skip_share || b.skips - a.skips || a.name.localeCompare(b.name);
  report.by_repo = [...maps[0]!.values()].sort(order);
  report.by_lane = [...maps[1]!.values()].sort(order);
  return report;
}

const line = (g: SkipGroup): string => `${g.name}: ${g.launches} launches, ${g.skips} skips, ${(g.skip_share * 100).toFixed(1)}% skipped`;

export async function cmdFleetSkips(args: string[], read: SkipsReader = readJobsTail, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nRead the last ${TAIL_LINES} lines of jobs.jsonl. Over --hours (positive number, default 6) count launches and precheck skips per repo and per lane, worst skip share first. One plain line per repo. Unreadable metrics print unknown.`);
    return 0;
  }
  let hours = 6;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (a === '--hours') {
      const v = args[++i];
      hours = v !== undefined && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
      if (!(hours > 0) || !Number.isFinite(hours)) { console.error(`${usage}\n--hours needs a positive number`); return 2; }
    } else { console.error(usage); return 2; }
  }
  const r = await fleetSkips(read, hours, now);
  console.log(sanitizePublicJson(json ? JSON.stringify(sanitizePublicJson(r)) : r.totals === null
    ? 'Skips: unknown (metrics unreadable)'
    : r.by_repo.length ? r.by_repo.map(line).join('\n') : `No launches or skips in the last ${hours} hours.`));
  return 0;
}
