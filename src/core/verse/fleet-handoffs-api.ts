/** Desktop Library feed for the agent handoff folders other agents drop under
 * ~/.ashlr-runs/handoff/<folder>/*.md. Read-only: folder, name, size, times and
 * scrubbed 240-char previews. Never returns an absolute path or full file
 * content, and never reports a failed read as zero handoffs. */
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ApiModule } from './api-modules.js';
import { sendJson } from '../web/api.js';
import { readHandoffFiles, type HandoffFile, type HandoffReadResult } from '../fleet/handoff-files.js';

export const VERSE_FLEET_HANDOFFS_PATH = '/api/verse/fleet/handoffs';

export interface FleetHandoffsApiDeps {
  /** Default: ASHLR_RUNS_DIR, then ~/.ashlr-runs. */
  runsDir?: string;
  /** Reader seam for tests. */
  list?: (runsDir: string) => Promise<HandoffFile[]>;
  read?: (runsDir: string) => Promise<HandoffReadResult>;
  now?: () => Date;
}

const defaultRunsDir = (): string => process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');

/** 'absent' only when the handoff directory is plainly not there; any other failure is 'unavailable'. */
async function handoffState(runsDir: string): Promise<'present' | 'absent' | 'unavailable'> {
  try {
    return (await lstat(join(runsDir, 'handoff'))).isDirectory() ? 'present' : 'unavailable';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unavailable';
  }
}

export function createFleetHandoffsApi(deps: FleetHandoffsApiDeps = {}): ApiModule {
  const now = deps.now ?? (() => new Date());
  const runsDir = deps.runsDir ?? defaultRunsDir();
  const read = deps.read ?? (deps.list
    ? async (dir: string): Promise<HandoffReadResult> => ({ handoffs: await deps.list!(dir), state: 'complete' })
    : readHandoffFiles);

  return async (ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_HANDOFFS_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    const observedAt = now().toISOString();
    const state = await handoffState(runsDir);
    if (state !== 'present') {
      sendJson(res, 200, { v: 1, observedAt, handoffs: [], state });
      return true;
    }
    try {
      const result = await read(runsDir);
      sendJson(res, 200, { v: 1, observedAt, handoffs: result.handoffs,
        ...(result.state === 'complete' ? {} : { state: result.state }) });
    } catch {
      sendJson(res, 200, { v: 1, observedAt, handoffs: [], state: 'unavailable' });
    }
    return true;
  };
}

export const handleFleetHandoffsApi: ApiModule = createFleetHandoffsApi();
