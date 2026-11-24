/**
 * GET /api/verse/fleet/lane-supply — the Leader card's one-line read: the same typed report
 * `phm fleet lane-supply --json` prints (fleet.lane-supply.v1). Read-only.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../web/api.js';
import type { LaneSupplyReport } from '../fleet/lane-supply.js';

export async function handleLaneSupplyApi(
  _req: IncomingMessage,
  res: ServerResponse,
  method: string,
  read: () => Promise<LaneSupplyReport> = async () => (await import('../fleet/lane-supply-read.js')).readLaneSupply(),
): Promise<boolean> {
  if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
  try { sendJson(res, 200, await read()); } catch { sendJson(res, 503, { error: 'Lane supply could not be read.' }); }
  return true;
}
