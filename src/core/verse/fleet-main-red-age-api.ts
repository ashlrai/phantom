/**
 * core/verse/fleet-main-red-age-api.ts — `GET /api/verse/fleet/main-red-age`
 * (mounted by verse-api.ts through the api-modules.ts contract).
 *
 * The main guardian's per-repo state, read fresh each call from
 * `guardian/state.json` under the runs dir (core/fleet/main-red-age.ts — the
 * same parse `ashlr fleet main-red-age` runs): repo, state, minutes red
 * (red_first else red_since), attempts and the current repair job.
 *
 *   GET /api/verse/fleet/main-red-age → MainRedAgeV1
 *   any other method on the path      → 405
 *   any other path                    → false (next module runs)
 *
 * A missing, unreadable or corrupt state file answers 200 with
 * `known: false` and no repos — unknown is never green. Read-only: no
 * dispatch gate, no mutation surface; the response carries repo ids, job ids
 * and timestamps only — never paths or error text.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import {
  defaultStatePath,
  mainRedAgeView,
  parseGuardianState,
} from '../fleet/main-red-age.js';

export const VERSE_FLEET_MAIN_RED_AGE_PATH = '/api/verse/fleet/main-red-age';

export interface FleetMainRedAgeApiDeps {
  /** Reads the guardian state file's text; null when absent. Injected in tests. */
  readState?: () => Promise<string | null>;
  now?: () => Date;
}

/** Descriptor-bound read of the state file, like runs-history's event tail. */
const MAX_STATE_BYTES = 1024 * 1024;
async function readGuardianStateFile(): Promise<string | null> {
  try {
    const file = await open(defaultStatePath(), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size <= 0 || info.size > MAX_STATE_BYTES) return null;
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return bytes.subarray(0, offset).toString('utf8');
    } finally { await file.close(); }
  } catch { return null; }
}

export function createFleetMainRedAgeApi(deps: FleetMainRedAgeApiDeps = {}): ApiModule {
  const read = deps.readState ?? readGuardianStateFile;
  const now = deps.now ?? (() => new Date());
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_MAIN_RED_AGE_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
      return true;
    }
    const unknown = [...new URL(req.url ?? '/', 'http://localhost').searchParams.keys()][0];
    if (unknown !== undefined) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: `unknown parameter: ${unknown.slice(0, 64)}` });
      return true;
    }
    let raw: string | null = null;
    try { raw = await read(); } catch { raw = null; }
    const state = raw === null ? null : parseGuardianState(raw);
    sendJson(res, 200, mainRedAgeView(state, now()));
    return true;
  };
}

export const handleFleetMainRedAgeApi: ApiModule = createFleetMainRedAgeApi();
