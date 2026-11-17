/** The live-sessions reader (server only): the session map, projected by live-sessions.ts. */
import { buildLiveSessions, type LiveSessionsFilter, type LiveSessionsV1 } from './live-sessions.js';
import { readFleetSessionMap, type FleetSessionMap } from './sessions-view.js';
import { sanitizePublicJson } from '../util/public-json.js';

/** The default reader: the same session map the Compute map reads. Any failure reads as "unknown", never as an empty fleet. */
export async function readLiveSessions(options: LiveSessionsFilter & {
  readMap?: (now: number) => Promise<FleetSessionMap>; now?: number;
} = {}): Promise<LiveSessionsV1> {
  const now = options.now ?? Date.now();
  const readMap = options.readMap ?? ((at: number) => readFleetSessionMap({ now: at }));
  const map = await Promise.resolve().then(() => readMap(now)).catch(() => null);
  // Sanitizing keeps the shape; it only rewrites home paths and secret-shaped strings.
  return sanitizePublicJson(buildLiveSessions(map, now, options)) as LiveSessionsV1;
}
