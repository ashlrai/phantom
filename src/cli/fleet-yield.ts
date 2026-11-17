/** `phm fleet yield`: merged PRs per launch slot, by job family, lane and tier. Read-only. */
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { runsRoot } from '../core/metrics/loop-collect.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { unknownYield, yieldTally, YIELD_MIN_LAUNCHES, type YieldReport, type YieldRow } from '../core/fleet/slot-yield.js';

const usage = 'Usage: phm fleet yield [--since 24h] [--metrics <jobs.jsonl>] [--json]';

/** Streams ledger lines into the callback; false when the file is missing, not a regular file, or unreadable. */
export type YieldLineReader = (path: string, onLine: (line: string) => void) => Promise<boolean>;

export const readLedgerLines: YieldLineReader = async (path, onLine) => {
  try {
    if (!(await lstat(path)).isFile()) return false;
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) onLine(line);
    return true;
  } catch { return false; }
};

export async function readFleetYield(path: string, hours: number, now: number, read: YieldLineReader = readLedgerLines): Promise<YieldReport> {
  const tally = yieldTally(now, hours);
  return await read(path, line => tally.add(line)) ? tally.report() : unknownYield(hours);
}

export function yieldLines(report: YieldReport): string[] {
  if (!report.known) return ['Launch yield: unknown (job metrics file unreadable)'];
  const section = (title: string, rows: YieldRow[]) => rows.length ? [title, ...rows.map(r => `  ${r.verdict}`)] : [];
  const judged = report.families.filter(r => r.launches >= YIELD_MIN_LAUNCHES);
  const small = report.families.filter(r => r.launches < YIELD_MIN_LAUNCHES);
  return [
    `${report.launches} launches in the last ${report.window_hours} hours`,
    ...section(`Job families with ${YIELD_MIN_LAUNCHES}+ launches, worst yield first:`, judged),
    ...section(`Job families with fewer than ${YIELD_MIN_LAUNCHES} launches:`, small),
    ...section('By lane:', report.lanes),
    ...section('By tier:', report.tiers),
  ];
}

export async function cmdFleetYield(args: string[], read: YieldLineReader = readLedgerLines, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}
How many launches turned into merged PRs. Reads the job metrics file
(default: <fleet runs dir>/metrics/jobs.jsonl) and counts each launch in the window once.
Groups by job family (id minus its cycle number, e.g. RQ-PHX-RECUT*; leader jobs as "leader"), lane and tier.
Families with ${YIELD_MIN_LAUNCHES}+ launches print worst yield first. Missing token counts print as unknown.`);
    return 0;
  }
  let hours = 24, json = false, seenSince = false, metrics: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--metrics' && metrics === null) {
      metrics = args[++i] ?? '';
      if (!metrics || metrics.startsWith('-')) { console.error(usage); return 2; }
    } else if (arg === '--since' && !seenSince) {
      seenSince = true;
      const match = /^(\d+(?:\.\d+)?)([hd])$/.exec(args[++i] ?? '');
      if (!match) { console.error(usage); return 2; }
      hours = Number(match[1]) * (match[2] === 'd' ? 24 : 1);
    } else { console.error(usage); return 2; }
  }
  if (!Number.isFinite(hours) || hours <= 0) { console.error(usage); return 2; }
  const report = await readFleetYield(metrics ?? join(runsRoot(), 'metrics', 'jobs.jsonl'), hours, now, read);
  console.log(json ? JSON.stringify(sanitizePublicJson(report)) : yieldLines(report).join('\n'));
  return 0;
}
