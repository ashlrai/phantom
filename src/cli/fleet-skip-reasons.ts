/** Read-only summary of dispatcher skip evidence. */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localTimestamp } from '../core/fleet/runs-parked-queue.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = 'Usage: ashlr fleet skip-reasons [--hours N] [--json]\nSummarize skip events from the last N hours (default 24). Times without a zone use local time.';
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
// eslint-disable-next-line no-control-regex -- do not print control characters or paths from queue evidence.
const unsafe = /[/\\\x00-\x1f\x7f]/;
export interface SkipReasonCount { value: string; count: number }
export interface FleetSkipReasons {
  schema: 'fleet.skip-reasons.v1'; hours: number; total: number; malformed: number;
  actions: SkipReasonCount[]; reasons: SkipReasonCount[];
  ids: Array<{ id: string; inReady: boolean }>;
}

export function summarizeSkipReasons(skips: string, ready: string, hours: number, now = Date.now()): FleetSkipReasons {
  const readyIds = new Set(ready.split(/\r?\n/).map(line => line.split('\t')[0]!.trim())
    .filter(id => idPattern.test(id)));
  const actions = new Map<string, number>();
  const reasons = new Map<string, number>();
  const ids = new Set<string>();
  let total = 0;
  let malformed = 0;
  for (const line of skips.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split('\t');
    const [time, id, action, reason] = cells;
    const ms = localTimestamp(time ?? '').ms;
    if (cells.length !== 4 || !id || !idPattern.test(id) || !action || !reason ||
        action.length > 400 || reason.length > 400 || unsafe.test(action) || unsafe.test(reason) || !Number.isFinite(ms)) {
      malformed++;
      continue;
    }
    if (ms < now - hours * 3_600_000 || ms > now) continue;
    for (const [map, value] of [[actions, scrubSecrets(action)], [reasons, scrubSecrets(reason)]] as const) {
      map.set(value, (map.get(value) ?? 0) + 1);
    }
    ids.add(id);
    total++;
  }
  const counts = (map: Map<string, number>): SkipReasonCount[] => [...map].map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return { schema: 'fleet.skip-reasons.v1', hours, total, malformed, actions: counts(actions), reasons: counts(reasons),
    ids: [...ids].sort().map(id => ({ id, inReady: readyIds.has(id) })) };
}

export async function cmdFleetSkipReasons(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let hours = 24;
  let hasHours = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--hours' && !hasHours && /^(?:\d+\.?\d*|\.\d+)$/.test(args[i + 1] ?? '')) {
      hours = Number(args[++i]); hasHours = true;
    } else { console.error(usage); return 2; }
  }
  if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(hours * 3_600_000)) { console.error(usage); return 2; }
  const root = process.env['ASHLR_RUNS_DIR'] || join(homedir(), '.ashlr-runs');
  try {
    const [skips, ready] = await Promise.all(['skipped-empty.tsv', 'ready.tsv'].map(name => readFile(join(root, 'queue', name), 'utf8')));
    const report = summarizeSkipReasons(skips!, ready!, hours);
    console.log(json ? JSON.stringify(report) : [
      `Skip events in the last ${hours} hours: ${report.total}`,
      `Malformed rows ignored: ${report.malformed}`,
      'Actions:', ...report.actions.map(row => `  ${row.value}: ${row.count}`),
      'Reasons:', ...report.reasons.map(row => `  ${row.value}: ${row.count}`),
      'IDs:', ...report.ids.map(row => `  ${row.id}: ${row.inReady ? 'still in queue' : 'not in queue'}`),
    ].join('\n'));
    return 0;
  } catch { console.error('fleet skip-reasons: queue evidence unavailable'); return 1; }
}
