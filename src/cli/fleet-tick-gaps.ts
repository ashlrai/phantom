import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { localTimestamp } from '../core/fleet/runs-parked-queue.js';

const usage = 'Usage: ashlr fleet tick-gaps [--json]\nRead gaps over 300 seconds between dispatch log lines ending in the last 6 hours.\nTimes without a zone use local time. Full gaps are shown; no gap to now is inferred.';
export interface FleetTickGap { start: string; end: string; lengthSeconds: number; lineBefore: string }
export interface FleetTickGaps {
  schema: 'fleet.tick-gaps.v1';
  source: 'read' | 'unknown';
  windowStart: string;
  windowEnd: string;
  gaps: FleetTickGap[];
  count: number | null;
  longestGap: FleetTickGap | null;
}
export interface FleetTickGapsOptions {
  readEvents?: (path: string) => Promise<string | null>;
  now?: number;
}

/** Inspect recorded line order only. Never creates files or infers missing ticks. */
export async function readFleetTickGaps(opts: FleetTickGapsOptions = {}): Promise<FleetTickGaps> {
  const now = opts.now ?? Date.now();
  const since = now - 6 * 3_600_000;
  const report: FleetTickGaps = { schema: 'fleet.tick-gaps.v1', source: 'unknown',
    windowStart: new Date(since).toISOString(), windowEnd: new Date(now).toISOString(),
    gaps: [], count: null, longestGap: null };
  let text: string | null;
  try {
    text = await (opts.readEvents ?? (path => readFile(path, 'utf8')))(
      join(homedir(), '.ashlr-runs', 'queue', 'dispatch-events.log'));
  } catch { return report; }
  if (text === null) return report;
  report.source = 'read';
  report.count = 0;
  let previous: { ms: number; line: string } | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const prefix = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:\s|$)/.exec(line);
    const ms = prefix ? localTimestamp(prefix[1]!).ms : Number.NaN;
    // Unknown or backwards timestamps break adjacency rather than inventing a gap.
    if (!Number.isFinite(ms) || ms > now) { previous = undefined; continue; }
    if (previous && ms >= since && ms - previous.ms > 300_000) {
      const gap = { start: new Date(previous.ms).toISOString(), end: new Date(ms).toISOString(),
        lengthSeconds: (ms - previous.ms) / 1000, lineBefore: previous.line };
      report.gaps.push(gap);
      if (!report.longestGap || gap.lengthSeconds > report.longestGap.lengthSeconds) report.longestGap = gap;
    }
    previous = previous && ms < previous.ms ? undefined : { ms, line };
  }
  report.count = report.gaps.length;
  return report;
}

export async function cmdFleetTickGaps(args: string[], opts: FleetTickGapsOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(usage); return 2;
  }
  const report = await readFleetTickGaps(opts);
  console.log(args.includes('--json') ? JSON.stringify(report) : [
    `Gaps over 300 seconds in the last 6 hours: ${report.count ?? 'unknown'}`,
    `Longest gap: ${report.source === 'unknown' ? 'unknown' : `${report.longestGap?.lengthSeconds ?? 0} seconds`}`,
    ...report.gaps.map(gap => `${gap.start} to ${gap.end}: ${gap.lengthSeconds} seconds\nLine before: ${gap.lineBefore}`),
  ].join('\n'));
  return report.source === 'read' ? 0 : 1;
}
