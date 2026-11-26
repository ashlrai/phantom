/**
 * Library pins API, an api-modules.ts route family (recovered from PR #4366,
 * RQ-PHX-LIBRARYPINS13):
 *
 *   GET    /api/verse/library/pins       → { v: 1, pins }
 *   POST   /api/verse/library/pins       → {kind, ref, title} pins, or {remove: id} unpins → { v: 1, pin | removed, pins }
 *   DELETE /api/verse/library/pins/<id>  → { v: 1, removed, pins }
 *
 * The store is core/fleet/library-pins.ts, the same file `ashlr fleet
 * library-pins` and the fleet context pack read. Writes pass the dispatch and
 * mutation-token gate like every Verse mutation (dispatchMountedModules gates
 * every non-GET before any module runs; the checks below keep the module
 * safe when invoked directly). The desktop unpins with POST because the
 * shared web client sends DELETE without a JSON content type, which that
 * gate refuses.
 *
 * Registration note (RQ-PHX-LIBRARYPINSAPIRECOVER249S): mounting this in
 * verse-api.ts's DEFAULT_API_MODULES is owner-lane — the exact module-id
 * list is pinned by test/verse-api-mount-310.test.ts and the mount grows the
 * Tier-1 closure snapshot. See BRIDGE_NOTES.md for the landing steps.
 */
import { addPin, LibraryPinError, listPins, removePin } from '../fleet/library-pins.js';
import { readMutationBody, sendInvalid } from './api-http.js';
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api-http-helpers.js';

export const VERSE_LIBRARY_PINS_PATH = '/api/verse/library/pins';

function unknownKey(body: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(body).find((key) => !allowed.includes(key));
}

export const handleLibraryPinsApi: ApiModule = async (ctx, req, res, path, method) => {
  const item = path.startsWith(`${VERSE_LIBRARY_PINS_PATH}/`) ? path.slice(VERSE_LIBRARY_PINS_PATH.length + 1) : null;
  if (path !== VERSE_LIBRARY_PINS_PATH && (item === null || item.includes('/'))) return false;
  try {
    if (item !== null) {
      if (method !== 'DELETE') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
      const body = await readMutationBody(ctx, req, res);
      if (!body) return true;
      const extra = unknownKey(body, []);
      if (extra) { sendInvalid(res, `unknown key: ${extra}`); return true; }
      const removed = removePin(decodeURIComponent(item));
      sendJson(res, 200, { v: 1, removed, pins: listPins() });
    } else if (method === 'GET') {
      sendJson(res, 200, { v: 1, pins: listPins() });
    } else if (method === 'POST') {
      const body = await readMutationBody(ctx, req, res);
      if (!body) return true;
      if ('remove' in body) {
        const extra = unknownKey(body, ['remove']);
        if (extra) { sendInvalid(res, `unknown key: ${extra}`); return true; }
        if (typeof body['remove'] !== 'string') { sendInvalid(res, 'remove must be a pin id'); return true; }
        const removed = removePin(body['remove']);
        sendJson(res, 200, { v: 1, removed, pins: listPins() });
        return true;
      }
      const extra = unknownKey(body, ['kind', 'ref', 'title']);
      if (extra) { sendInvalid(res, `unknown key: ${extra}`); return true; }
      const pin = addPin(body as { kind?: string; ref?: string; title?: string });
      sendJson(res, 200, { v: 1, pin, pins: listPins() });
    } else sendJson(res, 405, { error: 'method not allowed' });
  } catch (error) {
    if (error instanceof LibraryPinError) sendInvalid(res, error.message);
    else sendJson(res, 500, { code: 'library-pins-failed', error: 'the library pins request failed' });
  }
  return true;
};
