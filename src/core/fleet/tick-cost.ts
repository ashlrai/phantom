/** Local timestamps and nearest-rank percentiles, matching dispatcher log format. */
import { join } from 'node:path';
import { readTail, runsRoot } from '../metrics/loop-collect.js';

export interface TickCostReport {
  schema: 'fleet.tick-cost.v1';
  known: boolean;
  truncated: boolean;
  windowHours: number;
  tickCount: number;
  tickWallP50: number | null;
  tickWallP95: number | null;
  slowCount: number;
  slowByHour: Record<string, number>;
  slowPerHour: number | null;
}
export function parseTickCost(text: string | null, now = Date.now(), hours = 2, truncated = false): TickCostReport {
  const walls: number[] = [];
  let slowCount = 0;
  const slowByHour: Record<string, number> = {};
  for (const line of (text ?? '').split('\n')) {
    const match = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (.*)$/.exec(line);
    if (!match) continue;
    const at = Date.parse(match[1]!.replace(' ', 'T')), body = match[2]!;
    if (!Number.isFinite(at) || at < now - hours * 3_600_000 || at > now) continue;
    if (/^SLOW\b/.test(body)) { slowCount++; const hour = match[1]!.slice(0, 13); slowByHour[hour] = (slowByHour[hour] ?? 0) + 1; }
    const tick = /^tick\b.*\bwall=(\d+(?:\.\d+)?)s\s*$/.exec(body);
    if (tick && Number.isFinite(Number(tick[1]))) walls.push(Number(tick[1]));
  }
  walls.sort((a, b) => a - b);
  return { schema: 'fleet.tick-cost.v1', known: text !== null, truncated, windowHours: hours,
    tickCount: walls.length, tickWallP50: walls[Math.ceil(walls.length * 0.5) - 1] ?? null,
    tickWallP95: walls[Math.ceil(walls.length * 0.95) - 1] ?? null, slowCount, slowByHour,
    slowPerHour: text === null || truncated ? null : slowCount / hours };
}
export async function readTickCost(root = runsRoot()): Promise<TickCostReport> {
  const tail = await readTail(join(root, 'dispatchd.log'), 256 * 1024);
  return parseTickCost(tail?.text ?? null, Date.now(), 2, tail?.truncated ?? false);
}
