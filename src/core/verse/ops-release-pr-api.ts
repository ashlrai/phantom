/** Read-only release PR status, cached for fifteen seconds per process. */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { nameWithOwnerFromRemote } from '../fleet/repo-identity.js';
import { listEnrolled } from '../sandbox/policy.js';
import { sendJson } from '../web/api.js';
import { scrubSecrets } from '../util/scrub.js';
import type { ApiModule } from './api-modules.js';
import { mapLimited } from './folder-io.js';
import type { OpsRunner } from './ops-releases.js';
import { probeReleasePr, type ReleasePrV1 } from './ops-release-pr.js';

export const VERSE_RELEASE_PR_PATH = '/api/verse/release-pr';
export interface ReleasePrResponseV1 {
  v: 1;
  generatedAt: string;
  sourceState: 'healthy' | 'degraded';
  repos: { repo: string; path: string; pr: ReleasePrV1 | null; notes: string[] }[];
}
const realRunner: OpsRunner = (bin, args) => new Promise((resolve) => {
  try {
    execFile(bin, [...args], {
      cwd: homedir(), timeout: 12_000, maxBuffer: 256 * 1024, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, GH_HOST: 'github.com', GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    }, (error, stdout) => resolve(error ? null : stdout.trim()));
  } catch { resolve(null); }
});
export interface ReleasePrApiDeps {
  run?: OpsRunner;
  enrolled?: () => string[];
  now?: () => number;
}

/** Each handler owns its cache; the mounted production handler is a process singleton. */
export function createReleasePrApi(deps: ReleasePrApiDeps = {}): ApiModule {
  const run: OpsRunner = async (bin, args) => {
    try { return await (deps.run ?? realRunner)(bin, args); } catch { return null; }
  };
  let cached: { at: number; value: Promise<ReleasePrResponseV1> } | undefined;
  const collect = async (now: number): Promise<ReleasePrResponseV1> => {
    let degraded = false;
    let paths: string[] = [];
    try { paths = (deps.enrolled ?? listEnrolled)(); } catch { degraded = true; }
    const repos = await mapLimited([...new Set(paths)], 2, async (path) => {
      const origin = await run('git', ['-C', path, 'remote', 'get-url', 'origin']);
      const repo = origin ? nameWithOwnerFromRemote(origin.trim()) : null;
      const notes: string[] = [];
      let pr: ReleasePrV1 | null = null;
      if (!repo) notes.push('No GitHub origin could be proven for this checkout.');
      else {
        pr = await probeReleasePr(repo, async (bin, args) => {
          const raw = await run(bin, args);
          try { if (raw === null || !Array.isArray(JSON.parse(raw))) throw new Error('unavailable'); }
          catch { degraded = true; notes.push('gh could not answer: it may be missing, unauthenticated, offline, or malformed.'); }
          return raw;
        });
      }
      return { repo: scrubSecrets(repo ?? basename(path)).slice(0, 140), path, pr, notes };
    });
    return { v: 1, generatedAt: new Date(now).toISOString(), sourceState: degraded ? 'degraded' : 'healthy', repos };
  };
  return async (_ctx, req, res, path, method) => {
    if (path !== VERSE_RELEASE_PR_PATH || method !== 'GET') return false;
    let params: URLSearchParams;
    try { params = new URL(req.url ?? path, 'http://localhost').searchParams; }
    catch {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid query string' });
      return true;
    }
    for (const key of params.keys()) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: `unknown query parameter: ${key}` });
      return true;
    }
    const now = (deps.now ?? Date.now)();
    if (!cached || now - cached.at >= 15_000) cached = { at: now, value: collect(now) };
    sendJson(res, 200, await cached.value);
    return true;
  };
}
export const handleReleasePrApi: ApiModule = createReleasePrApi();
