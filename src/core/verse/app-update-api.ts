/** Desktop self-update status for the shell: the same staged-candidate read
 * `phm app update status` performs, as one GET. Read-only — it never
 * downloads, applies or restarts anything. */
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import type { AppUpdateStatus } from '../app-update-status.js';

export const VERSE_APP_UPDATE_STATUS_PATH = '/api/verse/app/update-status';

export interface AppUpdateStatusResponseV1 {
  v: 1;
  available: string | null;
  deferredReason: string | null;
  runningJobCount: number | null;
  unknownJobs: number | null;
}

export interface AppUpdateApiDeps {
  /** The status read; injected in tests. Default: the operator's own stage,
   * loaded lazily so mounting this family never pays the desktop-update
   * inspection graph (qualified-update, tar, authority surface) at import. */
  readStatus?: () => AppUpdateStatus | Promise<AppUpdateStatus>;
}

// Versions and hold reasons are the only strings on the wire; anything the
// inspection produced that is not a short token (a path, a sentence, binary)
// degrades to null rather than reaching the desktop.
const SAFE_TEXT = /^[\w.\- ]{1,80}$/;
const text = (value: string | null): string | null => (value !== null && SAFE_TEXT.test(value) ? value : null);
const count = (value: number | null): number | null =>
  (value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null);

const unavailable = (): AppUpdateStatusResponseV1 =>
  ({ v: 1, available: null, deferredReason: 'native-status-unavailable', runningJobCount: null, unknownJobs: null });

export function createAppUpdateApi(deps: AppUpdateApiDeps = {}): ApiModule {
  const read = deps.readStatus ?? (async () => {
    const status = await import('../app-update-status.js');
    return status.readAppUpdateStatus(status.defaultAppUpdateStatusDeps());
  });
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_APP_UPDATE_STATUS_PATH) return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    // Read-only GET: like the sibling read routes (fleet-memory, runs-history)
    // it does not check ctx.allowDispatch — dispatch gates mutations only.
    let body: AppUpdateStatusResponseV1;
    try {
      const status = await read();
      body = { v: 1, available: text(status.available), deferredReason: text(status.deferredReason),
        runningJobCount: count(status.runningJobCount), unknownJobs: count(status.unknownJobs) };
    } catch { body = unavailable(); }
    sendJson(res, 200, body);
    return true;
  };
}

export const handleAppUpdateApi: ApiModule = createAppUpdateApi();
