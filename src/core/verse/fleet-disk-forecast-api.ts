/** Read-only disk runway for the desktop host pane; reuses the MCP reader, never throws. */
import { readFleetDiskForecast } from '../../mcp/fleet-disk-forecast.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export interface FleetDiskForecastApiDeps {
  runsDir?: string;
  now?: () => number;
  read?: typeof readFleetDiskForecast;
}
const CACHE_MS = 30_000;
export function createFleetDiskForecastApi(deps: FleetDiskForecastApiDeps = {}): ApiModule {
  const now = deps.now ?? Date.now;
  const read = deps.read ?? readFleetDiskForecast;
  let cached: { at: number; view: Promise<object> } | undefined;
  async function snapshot(): Promise<object> {
    try {
      const result = await read(deps.runsDir);
      return { v: 1, generatedAt: new Date(now()).toISOString(), ...result };
    } catch { return { v: 1, unavailable: true }; }
  }
  return async (_ctx, _req, res, path, method) => {
    if (path !== '/api/verse/fleet/disk-forecast') return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!cached || now() - cached.at >= CACHE_MS) cached = { at: now(), view: snapshot() };
    sendJson(res, 200, await cached.view);
    return true;
  };
}
export const handleFleetDiskForecastApi: ApiModule = createFleetDiskForecastApi();
