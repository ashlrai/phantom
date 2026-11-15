/** Summarize the complete precheck skip log within a trailing time window. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localTimestamp, readSource } from '../core/fleet/runs-parked-queue.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = 'Usage: phm fleet precheck-repeats [--hours N] [--json]';
const HOUR = 3_600_000;
const MAX_BYTES = 64 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
// eslint-disable-next-line no-control-regex -- log fields must not contain control bytes or paths.
const UNSAFE = /[/\\\x00-\x1f\x7f]/;
type Count = { name: string; count: number };
type Repeat = { id: string; count: number; lastTime: string };
export interface PrecheckRepeatsReport {
  schema: 'fleet.precheck-repeats.v1'; hours: number; source: 'healthy' | 'missing' | 'degraded';
  total: number | null; malformed: number; byCode: Count[]; byReason: Count[]; repeats: Repeat[];
}

export async function fleetPrecheckRepeats(hours = 24, now = Date.now(), root = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs')): Promise<PrecheckRepeatsReport> {
  const source = await readSource(join(root, 'queue', 'precheck-skips.tsv'), MAX_BYTES, false);
  const report: PrecheckRepeatsReport = { schema: 'fleet.precheck-repeats.v1', hours, source: source.state,
    total: source.state === 'healthy' ? 0 : null, malformed: 0, byCode: [], byReason: [], repeats: [] };
  if (report.total === null) return report;
  const codes = new Map<string, number>(), reasons = new Map<string, number>();
  const ids = new Map<string, Repeat & { ms: number }>();
  for (const line of source.text.split('\n')) {
    if (!line.trim()) continue;
    const cells = line.replace(/\r$/, '').split('\t');
    const [time, id, code, reason] = cells;
    const timestamp = localTimestamp(time ?? '');
    if (cells.length !== 4 || !id || !ID.test(id) || !code || !reason || !Number.isFinite(timestamp.ms) ||
        [time!, code, reason].some(value => value.length > 400 || UNSAFE.test(value))) { report.malformed++; continue; }
    if (timestamp.ms < now - hours * HOUR || timestamp.ms > now) continue;
    report.total++;
    const safeCode = scrubSecrets(code), safeReason = scrubSecrets(reason), safeId = scrubSecrets(id);
    codes.set(safeCode, (codes.get(safeCode) ?? 0) + 1);
    reasons.set(safeReason, (reasons.get(safeReason) ?? 0) + 1);
    const entry = ids.get(id) ?? { id: safeId, count: 0, lastTime: time!, ms: timestamp.ms };
    entry.count++;
    if (timestamp.ms > entry.ms) { entry.ms = timestamp.ms; entry.lastTime = time!; }
    ids.set(id, entry);
  }
  const counts = (map: Map<string, number>): Count[] => [...map].map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  report.byCode = counts(codes); report.byReason = counts(reasons);
  report.repeats = [...ids.values()].filter(item => item.count > 1)
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    .map(({ id, count, lastTime }) => ({ id, count, lastTime }));
  return report;
}

export async function cmdFleetPrecheckRepeats(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nCount skip codes and reasons and list repeated IDs in the last N hours (default 24). Missing or unreadable logs are unknown.`); return 0;
  }
  let hours = 24, json = false, seenHours = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--hours' && !seenHours) {
      const value = args[++i]; seenHours = true;
      hours = value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
      if (!(hours > 0) || !Number.isFinite(hours)) { console.error(`${usage}\n--hours needs a positive number`); return 2; }
    } else { console.error(usage); return 2; }
  }
  const report = await fleetPrecheckRepeats(hours);
  if (json) console.log(JSON.stringify(report));
  else if (report.total === null) console.log(`Precheck skips: unknown (log ${report.source}).`);
  else console.log([`Precheck skips in the last ${hours} hours: ${report.total} (${report.malformed} malformed rows ignored)`,
    'Codes:', ...report.byCode.map(item => `  ${item.name}: ${item.count}`),
    'Reasons:', ...report.byReason.map(item => `  ${item.name}: ${item.count}`),
    'Repeated IDs:', ...report.repeats.map(item => `  ${item.id}: ${item.count}, last ${item.lastTime}`)].join('\n'));
  return report.total === null ? 1 : 0;
}
