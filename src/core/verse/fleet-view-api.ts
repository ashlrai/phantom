/**
 * Fleet view API: `/api/verse/fleet/view` (RQ-FLEET-VIEW-V1).
 *
 *   GET /api/verse/fleet/view → the fleet-view.v1 aggregate (core/fleet/view.ts)
 *
 * The same projection `phm fleet view` renders in the terminal, served to
 * the workbench shell and: through the phone gateway's read allowlist:
 * the remote page. Read-only: nothing here mutates, dispatches or blocks;
 * the one route answers the cached aggregate (fleet-status-cache.ts:
 * the queue snapshot is rebuilt off the request path) and the document
 * carries `readOnly: true` plus per-source provenance for honesty.
 *
 * The view's own contract does the redaction work: every field is a
 * validated identifier, a bounded title or a number: never a path, an
 * environment value, or a credential-shaped string: so the phone-safe
 * copy is the document itself.
 */
import { sendJson } from '../web/api.js';
import { getCachedFleetView } from '../web/fleet-status-cache.js';
import type { ApiModule } from './api-modules.js';

export const VERSE_FLEET_VIEW_PATH = '/api/verse/fleet/view';

/**
 * The fleet-view family handler: one GET route, nothing else.
 * Same contract as every workbench ApiModule: true when a response was
 * written (including the 405), false when `path` belongs to another
 * family so the mount's next entry can run.
 */
export const handleFleetViewApi: ApiModule = async (_ctx, req, res, path, method) => {
	if (path !== VERSE_FLEET_VIEW_PATH) return false;
	if (method !== 'GET') {
		sendJson(res, 405, { code: 'VERSE_METHOD', error: 'fleet view is read-only' });
		return true;
	}
	try {
		const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
		for (const key of params.keys()) {
			sendJson(res, 400, { code: 'VERSE_INVALID', error: `unknown query parameter: ${key}` });
			return true;
		}
	} catch {
		sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid query string' });
		return true;
	}
	sendJson(res, 200, getCachedFleetView());
	return true;
};
