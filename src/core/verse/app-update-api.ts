/** Desktop self-update status for the shell: the same staged-candidate read
 * `phm app update status` performs, as one GET. Read-only — it never
 * downloads, applies or restarts anything. */
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import { defaultAppUpdateStatusDeps, readAppUpdateStatus, readInstalledBundleVersion, type AppUpdateStatus } from '../app-update-status.js';
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
  /** The status read; injected in tests. Default: the operator's own stage. */
  readStatus?: () => AppUpdateStatus;
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

export function createAppUpdateApi(deps: AppUpdateApiDeps = {}): ApiModule {
  const read = deps.readStatus ?? (() => readAppUpdateStatus(defaultAppUpdateStatusDeps()));
  const readInstalled = deps.readInstalled ?? readInstalledBundleVersion;
  const readNotes = deps.readNotes ?? ((since: string) => collectReleaseNotes(process.cwd(), since));
  return async (_ctx, _req, res, path, method) => {
    if (path === VERSE_APP_WHATS_NEW_PATH) {
      if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
      sendJson(res, 200, whatsNew(readInstalled, readNotes));
      return true;
    }
    if (path !== VERSE_APP_UPDATE_STATUS_PATH) return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    // Read-only GET: like the sibling read routes (fleet-memory, runs-history)
    // it does not check ctx.allowDispatch — dispatch gates mutations only.
    let body: AppUpdateStatusResponseV1;
    try {
      const status = read();
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
