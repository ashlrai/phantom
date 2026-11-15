import { homedir } from 'node:os';
import { join } from 'node:path';
import { diskForecast, type DiskForecast } from '../core/fleet/disk-forecast.js';
import { readSource } from '../core/fleet/runs-parked-queue.js';

export function parseFleetDiskForecastArgs(args: Record<string, unknown> | undefined): Record<string, never> | null {
  return Object.keys(args ?? {}).length === 0 ? {} : null;
}

export async function readFleetDiskForecast(runsDir = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs')): Promise<{
  schema: 'fleet.mcp.disk-forecast.v1'; forecast: DiskForecast; advice: 'ok' | 'avoid-large-writes' | 'unknown';
}> {
  let forecast: DiskForecast;
  try {
    const [history, jobs] = await Promise.all([
      readSource(join(runsDir, 'queue', 'disk-growth-history.json'), 5 * 1024 * 1024, false),
      readSource(join(runsDir, 'metrics', 'jobs.jsonl'), 5 * 1024 * 1024, false),
    ]);
    forecast = diskForecast(history.state === 'healthy' && jobs.state === 'healthy' ? history.text : null, jobs.state === 'healthy' ? jobs.text : null);
  } catch {
    forecast = diskForecast(null, null);
  }
  const advice = forecast.status === 'unknown' ? 'unknown'
    : forecast.status === 'reached' || (forecast.status === 'projected' && forecast.hoursUntilThreshold !== null && forecast.hoursUntilThreshold < 6)
      ? 'avoid-large-writes' : 'ok';
  return { schema: 'fleet.mcp.disk-forecast.v1', forecast, advice };
}
