/** Read-only disk runway: free disk against the lines that stop launches. No repair or dispatch authority. */
import { diskForecast, type DiskForecast } from '../fleet/disk-forecast.js';
import { DISKGUARD_REUSE_ONLY_GB } from '../disk-maint/plan.js';
import { readFleetDiskForecast } from '../../mcp/fleet-disk-forecast.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const VERSE_FLEET_DISK_RUNWAY_PATH = '/api/verse/fleet/disk-runway';
/** Mirrors DISK_HARD_STOP_GB in contrib/mac/dispatchd.py (see contrib/mac/README.md): below it no job launches. */
export const DISK_HARD_STOP_GB = 30;

export interface FleetDiskRunwayResponseV1 {
  schema: 'fleet.disk-runway.v1';
  forecast: DiskForecast;
  lines: { reuseOnlyGb: number; hardStopGb: number };
  hoursToReuseOnly: number | null;
  hoursToHardStop: number | null;
}
export interface FleetDiskRunwayApiDeps {
  /** Reads the disk forecast; injected in tests. Default reads the runs dir. */
  readForecast?: () => Promise<{ forecast: DiskForecast }>;
}

/** Hours until free disk reaches `line`: 0 when already at or below it, null without a falling rate. */
export function hoursToLine(freeGb: number | null, ratePerHour: number | null, line: number): number | null {
  if (freeGb === null || !Number.isFinite(freeGb)) return null;
  if (freeGb <= line) return 0;
  if (ratePerHour === null || !Number.isFinite(ratePerHour) || ratePerHour <= 0) return null;
  return (freeGb - line) / ratePerHour;
}

export function createFleetDiskRunwayApi(deps: FleetDiskRunwayApiDeps = {}): ApiModule {
  const read = deps.readForecast ?? (() => readFleetDiskForecast());
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_DISK_RUNWAY_PATH) return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    let forecast: DiskForecast;
    try { forecast = (await read()).forecast; } catch { forecast = diskForecast(null, null); }
    const body: FleetDiskRunwayResponseV1 = {
      schema: 'fleet.disk-runway.v1', forecast,
      lines: { reuseOnlyGb: DISKGUARD_REUSE_ONLY_GB, hardStopGb: DISK_HARD_STOP_GB },
      hoursToReuseOnly: hoursToLine(forecast.freeGb, forecast.consumptionGbPerHour, DISKGUARD_REUSE_ONLY_GB),
      hoursToHardStop: hoursToLine(forecast.freeGb, forecast.consumptionGbPerHour, DISK_HARD_STOP_GB),
    };
    sendJson(res, 200, body);
    return true;
  };
}
export const handleFleetDiskRunwayApi: ApiModule = createFleetDiskRunwayApi();
