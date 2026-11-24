/**
 * GET /api/verse/supply — the Supply card's read: the same typed report `phm doctor supply --json` prints
 * (doctor.supply.v1). Read-only; reads three files under the runs dir and never writes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../web/api.js';
import { readSupplyDoctor, type SupplyDoctorReport } from '../fleet/supply-doctor.js';

export const VERSE_SUPPLY_PATH = '/api/verse/supply';

export async function handleSupplyApi(
  _req: IncomingMessage,
  res: ServerResponse,
  method: string,
  read: () => Promise<SupplyDoctorReport> = () => readSupplyDoctor(),
): Promise<boolean> {
  if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
  try { sendJson(res, 200, await read()); } catch { sendJson(res, 503, { error: 'Self-supply could not be read.' }); }
  return true;
}
