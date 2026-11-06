/** Read-only filler job activity from the bounded jobs ledger tail. */
import { readJobsTail, type SkipsReader } from './fleet-skips.js';
import { parseTs } from './fleet-running.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

export interface FillerGroup {
  prefix: string;
  launches: number;
  skips: number;
  skips_by_code: Record<string, number>;
  empty_finishes: number;
  merged: number;
}
export interface FleetFillerReport {
  schema: 'fleet.filler.v1';
  readOnly: true;
  known: boolean;
  window_hours: 24;
  groups: FillerGroup[];
}
const USAGE = 'Usage: ashlr fleet filler [--json]';

/** Count rows, not unique jobs: repeated attempts remain visible. */
export async function fleetFiller(read: SkipsReader = readJobsTail, now = Date.now()): Promise<FleetFillerReport> {
  const report: FleetFillerReport = { schema: 'fleet.filler.v1', readOnly: true, known: false, window_hours: 24, groups: [] };
  let lines: string[] | null;
  try { lines = await read(3000); } catch { lines = null; }
  if (!lines) return report;
  report.known = true;
  const groups = new Map<string, FillerGroup>();
  for (const line of lines.slice(-3000)) {
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      row = value as Record<string, unknown>;
    } catch { continue; }
    const match = typeof row.job === 'string' ? /^(RQ-(?:PS|PLUGIN|STACK|LOCUS|LEXICON|MD))\d+A\d+Q8$/.exec(row.job) : null;
    const at = parseTs(row.ts);
    if (!match || !Number.isFinite(at) || at < now - 24 * 3_600_000 || at > now) continue;
    if (row.event !== 'launch' && row.event !== 'precheck_skip'
      && !(row.event === 'finish' && row.empty === true)
      && !(row.event === 'outcome' && row.state === 'MERGED')) continue;
    const prefix = match[1]!;
    const group = groups.get(prefix) ?? { prefix, launches: 0, skips: 0, skips_by_code: {}, empty_finishes: 0, merged: 0 };
    groups.set(prefix, group);
    if (row.event === 'launch') group.launches++;
    else if (row.event === 'precheck_skip') {
      group.skips++;
      // Codes are short machine labels, never arbitrary log text or paths.
      const code = typeof row.code === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(row.code)
        ? sanitizePublicJson(row.code) as string : 'unknown';
      Object.defineProperty(group.skips_by_code, code, {
        value: (Object.hasOwn(group.skips_by_code, code) ? group.skips_by_code[code]! : 0) + 1,
        enumerable: true, configurable: true, writable: true,
      });
    } else if (row.event === 'finish') group.empty_finishes++;
    else group.merged++;
  }
  report.groups = [...groups.values()].sort((a, b) => b.skips - a.skips || a.prefix.localeCompare(b.prefix));
  return report;
}

export async function cmdFleetFiller(args: string[], read: SkipsReader = readJobsTail, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${USAGE}\nRead-only: last 3000 ledger lines, last 24 hours. One line per filler prefix, most skips first. --json returns the same counts.`);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) { console.error(USAGE); return 2; }
  const report = await fleetFiller(read, now);
  console.log(args[0] === '--json' ? JSON.stringify(report) : !report.known
    ? 'Filler: unknown (metrics unreadable)'
    : report.groups.length === 0 ? 'No filler activity in the last 24 hours.'
      : report.groups.map(g => `${g.prefix}: ${g.launches} launches, ${g.skips} skips (${Object.entries(g.skips_by_code).sort(([a], [b]) => a.localeCompare(b)).map(([code, n]) => `${code}=${n}`).join(', ') || 'none'}), ${g.empty_finishes} empty finishes, ${g.merged} merged`).join('\n'));
  return report.known ? 0 : 1;
}
