import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface TickProfile {
  schema: 'fleet.tick-profile.v1';
  window_hours: number;
  known: boolean;
  tick_count: number;
  launch_samples: number;
  p50_seconds: number | null;
  p90_seconds: number | null;
  launches_per_hour: number | null;
  timeout_share: number | null;
}

/** Local log timestamps; nearest-rank percentiles. Timeout share is a fraction
 * of TICK summaries with expired phases. Launch rate uses the full requested window.
 * Lowercase tick lines supply launch counts only, avoiding duplicate durations.
 */
export async function readTickProfile(path: string, hours = 2, now = Date.now()): Promise<TickProfile> {
  if (!Number.isFinite(hours) || hours <= 0 || !Number.isFinite(now)) throw new RangeError('Use positive hours and a valid time');
  const report: TickProfile = { schema: 'fleet.tick-profile.v1', window_hours: hours, known: false,
    tick_count: 0, launch_samples: 0, p50_seconds: null, p90_seconds: null, launches_per_hour: null, timeout_share: null };
  const walls: number[] = [];
  let launches = 0;
  let timeouts = 0;
  try {
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
      const match = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (.*)$/.exec(line);
      if (!match) continue;
      const date = new Date(match[1]!.replace(' ', 'T'));
      // Date normalizes impossible calendar dates; reject them instead.
      const local = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()]
        .map((n, i) => String(n).padStart(i === 0 ? 4 : 2, '0'));
      if (`${local.slice(0, 3).join('-')} ${local.slice(3).join(':')}` !== match[1]
        || date.getTime() < now - hours * 3_600_000 || date.getTime() > now) continue;
      const body = match[2]!;
      const tick = /^TICK total_s=(\d+(?:\.\d+)?) (?:[a-z_]+_s=\d+(?:\.\d+)? )*slowest=[a-z_]+ expired=(none|[a-z_]+(?:,[a-z_]+)*)$/.exec(body);
      if (tick && Number.isFinite(Number(tick[1]))) {
        walls.push(Number(tick[1]));
        if (tick[2] !== 'none') timeouts++;
      }
      const launch = /^tick run=.* q=\d+ launched=(\d+) reap=\d+ pause=(?:True|False) wall=\d+(?:\.\d+)?s$/.exec(body);
      if (launch && Number.isSafeInteger(Number(launch[1])) && Number.isSafeInteger(launches + Number(launch[1]))) {
        launches += Number(launch[1]);
        report.launch_samples++;
      }
    }
    report.known = true;
  } catch {
    return { ...report, launch_samples: 0 };
  }
  walls.sort((a, b) => a - b);
  report.tick_count = walls.length;
  if (walls.length) {
    report.p50_seconds = walls[Math.ceil(walls.length * 0.5) - 1]!;
    report.p90_seconds = walls[Math.ceil(walls.length * 0.9) - 1]!;
    report.timeout_share = timeouts / walls.length;
  }
  if (report.launch_samples) report.launches_per_hour = launches / hours;
  return report;
}
