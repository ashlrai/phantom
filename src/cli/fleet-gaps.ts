/** Lists every stretch of 15+ minutes with no dispatcher tick or no launch while jobs waited, with start, end, length and likely cause. */
import { resolve } from 'node:path';
import { defaultRunsDir } from '../core/fleet/landed-closes-read.js';
import { GAP_MIN_MINUTES, readFleetGaps, span, type FleetGapsReport, type ReadGapsOptions } from '../core/fleet/sleep-gaps.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm fleet gaps [--since <n>h|<n>d] [--min <minutes>] [--json] [--runs-dir <dir>]
Every stretch of ${GAP_MIN_MINUTES}+ minutes with no dispatcher tick, or no launch while jobs were queued: start, end, length,
likely cause (host-asleep, dispatcher-stalled, admission-blocked, queue-empty or unknown), and the jobs and plan that
could have run. A gap with an empty queue is not lost work. Read-only. Default window 24h.
Sleep is shown only when two self-tick clock samples prove it (wall time minus monotonic time); otherwise the cause is unknown.
  --json   print JSON (schema fleet.gaps.v1)
Exit 0 when the dispatch log was read, 1 when it could not be, 2 on a bad option.`;

export function parseSince(value: string): number | null {
  const m = /^(\d{1,3})([hd])$/.exec(value);
  const n = m ? Number(m[1]) * (m[2] === 'd' ? 24 : 1) : 0;
  return n >= 1 && n <= 720 ? n * 3_600_000 : null;
}

export function gapsText(report: FleetGapsReport): string[] {
  if (report.count === null) return ['Gaps: unknown (the dispatch log could not be read).'];
  const lines = [report.count === 0 ? `No gap of ${report.minMinutes}+ minutes since ${report.since.slice(0, 16)}Z.`
    : `${report.count} gap${report.count === 1 ? '' : 's'} of ${report.minMinutes}+ minutes; ${span(report.lostMinutes ?? 0)} where work waited or may have.`];
  for (const g of report.gaps) {
    const queued = g.jobsQueued === null ? 'queue unknown' : `${g.jobsQueued} queued`;
    lines.push(`${g.line} (${g.minutes} min, ${g.cause}, ${queued}${g.freeSlots === null ? '' : `, ${g.freeSlots} free slots`})`);
  }
  if (report.gaps.some(g => g.lostWork !== false)) {
    lines.push(report.claudeLeftPct === null ? 'Claude plan left: unknown.' : `Claude plan left: ${report.claudeLeftPct}% of the week.`);
  }
  if (report.sources.clock === 'unknown' && report.gaps.some(g => g.cause === 'unknown')) {
    lines.push('Sleep cannot be shown before self-tick has recorded clock samples; they start with the next applied tick.');
  }
  return lines;
}

export async function cmdFleetGaps(args: string[], deps: Partial<ReadGapsOptions> & { out?: (line: string) => void; err?: (line: string) => void } = {}): Promise<number> {
  const out = deps.out ?? console.log, err = deps.err ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(usage); return 0; }
  let json = false, since = 24 * 3_600_000, min = GAP_MIN_MINUTES, runsArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, next = args[i + 1];
    if (arg === '--json') json = true;
    else if (arg === '--since' && next && parseSince(next)) { since = parseSince(next)!; i++; }
    else if (arg === '--min' && next && /^\d{1,4}$/.test(next) && Number(next) >= 1) { min = Number(next); i++; }
    else if (arg === '--runs-dir' && runsArg === undefined && next && !next.startsWith('-')) { runsArg = next; i++; }
    else { err(`phm fleet gaps: unknown or incomplete option ${arg}\n${usage}`); return 2; }
  }
  const report = await readFleetGaps({ ...deps, runsDir: runsArg ? resolve(runsArg) : deps.runsDir ?? defaultRunsDir(), sinceMs: since, minMinutes: min });
  out(json ? JSON.stringify(sanitizePublicJson(report)) : gapsText(report).join('\n'));
  return report.count === null ? 1 : 0;
}
