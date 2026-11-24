/** Desktop self-update status for the shell: the same staged-candidate read
 * `phm app update status` performs, as one GET. Read-only — it never
 * downloads, applies or restarts anything. */
// Helpers module, not the web/api.js barrel: the barrel statically pulls the whole
// web graph, including the native app-update status inspection.
import { sendJson } from '../web/api-http-helpers.js';
import type { ApiModule } from './api-modules.js';
import type { AppUpdateStatus } from '../app-update-status.js';
import { collectReleaseNotes, type NoteSection, type ReleaseNotes } from '../release/notes.js';

export const VERSE_APP_UPDATE_STATUS_PATH = '/api/verse/app/update-status';
export const VERSE_APP_WHATS_NEW_PATH = '/api/verse/app/whats-new';

/** What changed since the installed version, in plain words. Unknown is unknown: no notes and a short reason, never a guess. */
export interface WhatsNewResponseV1 {
  v: 1;
  installed: string | null;
  headline: string[];
  sections: NoteSection[];
  reason: 'installed-version-unknown' | 'history-unavailable' | null;
}

export interface AppUpdateStatusResponseV1 {
  v: 1;
  available: string | null;
  deferredReason: string | null;
  runningJobCount: number | null;
  unknownJobs: number | null;
}

export interface AppUpdateApiDeps {
  /** The status read; injected in tests, sync or async. Default: the operator's own stage, loaded on first request
   * so mounting this family never imports the desktop-update inspection graph. */
  readStatus?: () => AppUpdateStatus | Promise<AppUpdateStatus>;
  /** The installed app version and the notes since its tag; injected in tests. Default: the app bundle and local git history. */
  readInstalled?: () => string | null;
  readNotes?: (since: string) => ReleaseNotes;
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

/** The native app-update module, imported only when a route needs it. */
const loadNativeStatus = () => import('../app-update-status.js');

async function defaultReadStatus(): Promise<AppUpdateStatus> {
  const native = await loadNativeStatus();
  return native.readAppUpdateStatus(native.defaultAppUpdateStatusDeps());
}

/** Default installed-version reader for whats-new. A failed load reads as unknown, which whatsNew already reports. */
async function defaultReadInstalled(): Promise<() => string | null> {
  try { return (await loadNativeStatus()).readInstalledBundleVersion; }
  catch { return () => null; }
}

export function createAppUpdateApi(deps: AppUpdateApiDeps = {}): ApiModule {
  const read = deps.readStatus ?? defaultReadStatus;
  const readNotes = deps.readNotes ?? ((since: string) => collectReleaseNotes(process.cwd(), since));
  return async (_ctx, _req, res, path, method) => {
    if (path === VERSE_APP_WHATS_NEW_PATH) {
      if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
      const readInstalled = deps.readInstalled ?? await defaultReadInstalled();
      sendJson(res, 200, whatsNew(readInstalled, readNotes));
      return true;
    }
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

/** Notes since the installed version's tag (`v<version>`), read from local git history only. */
export function whatsNew(readInstalled: () => string | null, readNotes: (since: string) => ReleaseNotes): WhatsNewResponseV1 {
  let installed: string | null = null;
  try { installed = text(readInstalled()); } catch { /* unknown stays unknown */ }
  if (!installed) return { v: 1, installed: null, headline: [], sections: [], reason: 'installed-version-unknown' };
  try {
    const notes = readNotes(`v${installed}`);
    return { v: 1, installed, headline: notes.headline, sections: notes.sections, reason: null };
  } catch { return { v: 1, installed, headline: [], sections: [], reason: 'history-unavailable' }; }
}

export const handleAppUpdateApi: ApiModule = createAppUpdateApi();
