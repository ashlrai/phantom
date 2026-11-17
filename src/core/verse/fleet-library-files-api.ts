/** Desktop Library feed for the Leader's own working files (VISION, PLAN-LOG,
 * INSPIRATION, drafts). Read-only: names relative to the leader directory,
 * sizes, times and scrubbed 240-char previews. Never returns an absolute path
 * or full file content, and never reports a failed read as zero files.
 * /items adds the unified Library under the existing bus and media read gates. */
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { listLeaderFiles, type LibraryFile } from '../fleet/library-files.js';
import { parseLibraryFilter, readLibrary, type LibraryFilter } from '../fleet/library.js';
import { authorizeLeaderAttachmentRead } from './leader-attachment-read-api.js';

export const VERSE_FLEET_LIBRARY_FILES_PATH = '/api/verse/fleet/library-files';

export interface FleetLibraryFilesApiDeps {
  /** Default: ASHLR_RUNS_DIR, then ~/.ashlr-runs. */
  runsDir?: string;
  /** Reader seam for tests. */
  list?: (runsDir: string) => Promise<LibraryFile[]>;
  readLibrary?: typeof readLibrary;
  now?: () => Date;
}

const defaultRunsDir = (): string => process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');

/** 'absent' only when the leader directory is plainly not there; any other failure is 'unavailable'. */
async function leaderState(runsDir: string): Promise<'present' | 'absent' | 'unavailable'> {
  try {
    return (await lstat(join(runsDir, 'leader'))).isDirectory() ? 'present' : 'unavailable';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unavailable';
  }
}

export function createFleetLibraryFilesApi(deps: FleetLibraryFilesApiDeps = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  const runsDir = deps.runsDir ?? defaultRunsDir();
  const list = deps.list ?? listLeaderFiles;

  return async (ctx, req, res, path, method) => {
    const items = path === `${VERSE_FLEET_LIBRARY_FILES_PATH}/items`;
    if (path !== VERSE_FLEET_LIBRARY_FILES_PATH && !items) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    if (items) {
      if (!ctx.readSession || !Number.isFinite(ctx.readSession.expiresAt) || ctx.readSession.expiresAt <= Date.now()) {
        sendJson(res, 401, { error: 'A current read session is required.' }); return true;
      }
      if (!authorizeLeaderAttachmentRead(ctx, req, res)) return true;
      let filter: LibraryFilter;
      try {
        const params = new URL(req.url ?? path, 'http://localhost').searchParams;
        if ([...params.keys()].some(key => params.getAll(key).length !== 1)) throw new Error();
        filter = parseLibraryFilter(Object.fromEntries(params));
      } catch { sendJson(res, 400, { error: 'Invalid Library filters.' }); return true; }
      try { sendJson(res, 200, await (deps.readLibrary ?? readLibrary)(filter, { runsDir, now })); }
      catch { sendJson(res, 503, { error: 'Library unavailable.' }); }
      return true;
    }
    const observedAt = now().toISOString();
    const state = await leaderState(runsDir);
    if (state !== 'present') {
      sendJson(res, 200, { v: 1, observedAt, files: [], state });
      return true;
    }
    try {
      sendJson(res, 200, { v: 1, observedAt, files: await list(runsDir) });
    } catch {
      sendJson(res, 200, { v: 1, observedAt, files: [], state: 'unavailable' });
    }
    return true;
  };
}

export const handleFleetLibraryFilesApi: ApiModule = createFleetLibraryFilesApi();
