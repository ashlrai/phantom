import { homedir } from 'node:os';
import { join } from 'node:path';
import { localTimestamp, readSource } from '../core/fleet/runs-parked-queue.js';

const usage = 'Usage: ashlr fleet disk-trend [--hours 6] [--floor 100] [--json]\nRead local disk readings. Exit 1 when the floor is less than 6 hours away.';
export interface DiskTrendReaders {
  readEvents: (path: string) => Promise<string | null>;
  now: () => number;
}
export interface DiskTrendReport {
  schema: 'fleet.disk-trend.v1';
  hours: number;
  floorGb: number;
  samples: number;
  fallingSamples: number;
  freeGb: number | null;
  fallGbPerHour: number | null;
  hoursUntilFloor: number | null;
  status: 'red' | 'ok' | 'unknown';
}

/** A rise starts a new run; equal readings stay in it. Timestamp ties use the last row. */
export async function readDiskTrend(hours: number, floorGb: number, readers: DiskTrendReaders): Promise<DiskTrendReport> {
  if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(floorGb) || floorGb < 0) {
    throw new Error('Hours must be positive and floor must be zero or more.');
  }
  const report: DiskTrendReport = { schema: 'fleet.disk-trend.v1', hours, floorGb, samples: 0,
    fallingSamples: 0, freeGb: null, fallGbPerHour: null, hoursUntilFloor: null, status: 'unknown' };
  let text: string | null;
  try { text = await readers.readEvents(join(homedir(), '.ashlr-runs', 'queue', 'dispatch-events.log')); }
  catch { return report; }
  if (text === null) return report;
  const now = readers.now(), samples = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    const row = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) LEADER (.*)$/.exec(line);
    if (!row) continue;
    const value = /(?:^|\s)free_gb=(\d+(?:\.\d+)?)(?=\s|$)/.exec(row[2]!);
    const ms = localTimestamp(row[1]!).ms;
    if (!value || !Number.isFinite(Number(value[1])) || !Number.isFinite(ms)
      || ms < now - hours * 3_600_000 || ms > now) continue;
    samples.set(ms, Number(value[1]));
  }
  const rows = [...samples].sort((a, b) => a[0] - b[0]);
  report.samples = rows.length;
  const last = rows.at(-1);
  if (!last) return report;
  let start = rows.length - 1;
  while (start > 0 && rows[start - 1]![1] >= rows[start]![1]) start--;
  const first = rows[start]!;
  report.fallingSamples = rows.length - start;
  report.freeGb = last[1];
  if (last[0] > first[0]) report.fallGbPerHour = (first[1] - last[1]) * 3_600_000 / (last[0] - first[0]);
  report.hoursUntilFloor = last[1] <= floorGb ? 0
    : report.fallGbPerHour !== null && report.fallGbPerHour > 0 ? (last[1] - floorGb) / report.fallGbPerHour : null;
  report.status = report.hoursUntilFloor !== null && report.hoursUntilFloor < 6 ? 'red'
    : report.fallGbPerHour !== null ? 'ok' : 'unknown';
  return report;
}

export async function cmdFleetDiskTrend(args: string[], injected: Partial<DiskTrendReaders> = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let hours = 6, floor = 100, json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { console.error(usage); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if ((arg === '--hours' || arg === '--floor') && args[i + 1]?.trim()) {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || (arg === '--hours' ? value <= 0 : value < 0)) { console.error(usage); return 2; }
      if (arg === '--hours') hours = value; else floor = value;
    } else { console.error(usage); return 2; }
  }
  const report = await readDiskTrend(hours, floor, {
    readEvents: async path => {
      const source = await readSource(path, 5 * 1024 * 1024, true);
      return source.state === 'healthy' ? source.text : null;
    }, now: Date.now, ...injected,
  });
  console.log(json ? JSON.stringify(report) : `${report.status}: free ${report.freeGb ?? 'unknown'} GB; `
    + `fall ${report.fallGbPerHour ?? 'unknown'} GB per hour; `
    + `${report.hoursUntilFloor ?? 'unknown'} hours until ${floor} GB floor.`);
  return report.status === 'red' ? 1 : 0;
}
