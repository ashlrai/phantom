/** Read-only dispatcher tick duration and slow-line summary. */
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const USAGE = 'Usage: ashlr fleet tick-wall [--hours N] [--json]';
export interface TickWallReport {
  schema: 'fleet.tick-wall.v1';
  window_hours: number;
  known: boolean;
  tick_count: number;
  slow_count: number;
  p50_seconds: number | null;
  p90_seconds: number | null;
  max_seconds: number | null;
}

/** Timestamps in dispatchd.log are local time; percentiles use nearest rank. */
export async function fleetTickWall(hours = 2, now = Date.now(), path = join(process.env.ASHLR_RUNS_DIR || join(homedir(), '.ashlr-runs'), 'dispatchd.log')): Promise<TickWallReport> {
  const report: TickWallReport = { schema: 'fleet.tick-wall.v1', window_hours: hours, known: false, tick_count: 0, slow_count: 0, p50_seconds: null, p90_seconds: null, max_seconds: null };
  const walls: number[] = [];
  try {
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
      const match = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (.*)$/.exec(line);
      if (!match) continue;
      const at = Date.parse(match[1]!.replace(' ', 'T'));
      if (!Number.isFinite(at) || at < now - hours * 3_600_000 || at > now) continue;
      const body = match[2]!;
      if (body.includes('SLOW')) report.slow_count++;
      const tick = /^tick\b.*\bwall=(\d+(?:\.\d+)?)s\s*$/.exec(body);
      if (tick && Number.isFinite(Number(tick[1]))) walls.push(Number(tick[1]));
    }
    report.known = true;
  } catch {
    return { ...report, slow_count: 0 };
  }
  walls.sort((a, b) => a - b);
  report.tick_count = walls.length;
  if (walls.length) {
    report.p50_seconds = walls[Math.ceil(walls.length * 0.5) - 1]!;
    report.p90_seconds = walls[Math.ceil(walls.length * 0.9) - 1]!;
    report.max_seconds = walls[walls.length - 1]!;
  }
  return report;
}

export async function cmdFleetTickWall(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${USAGE}\nSummarize dispatcher tick wall times and SLOW lines from the last N hours (default 2). Percentiles use nearest rank.`);
    return 0;
  }
  let hours = 2;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--hours') {
      const value = args[++i];
      hours = value && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
      if (!Number.isFinite(hours) || hours <= 0) { console.error(`${USAGE}\n--hours needs a positive number`); return 2; }
    } else { console.error(USAGE); return 2; }
  }
  const report = await fleetTickWall(hours);
  console.log(json ? JSON.stringify(report) : !report.known ? 'Tick wall: unknown (dispatcher log unreadable)' :
    `Ticks: ${report.tick_count}; SLOW lines: ${report.slow_count}; wall seconds: p50 ${report.p50_seconds ?? 'unknown'}, p90 ${report.p90_seconds ?? 'unknown'}, max ${report.max_seconds ?? 'unknown'}`);
  return report.known ? 0 : 1;
}
