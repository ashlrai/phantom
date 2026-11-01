/** Release PR status (GET, cached fifteen seconds per process) and the one-tap merge (POST .../merge). */
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { nameWithOwnerFromRemote } from '../fleet/repo-identity.js';
import { listEnrolled } from '../sandbox/policy.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { scrubSecrets } from '../util/scrub.js';
import type { ApiModule } from './api-modules.js';
import { mapLimited } from './folder-io.js';
import type { OpsRunner } from './ops-releases.js';
import { isReleasePrRepoName, mergeReleasePr, probeReleasePr, type ReleasePrV1 } from './ops-release-pr.js';
import type { VerseApiContext } from './verse-api.js';

export const VERSE_RELEASE_PR_PATH = '/api/verse/release-pr';
export const VERSE_RELEASE_PR_MERGE_PATH = '/api/verse/release-pr/merge';
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

function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

/** The dispatch + mutation gate and body read every Verse POST re-checks (fleet-holds-api.ts). */
async function readMutationBody(ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  if (!ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return null;
  }
  if (!passesMutationGate(req, res, ctx.token)) return null;
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'request body too large' });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : (JSON.parse(raw) as unknown);
  } catch {
    sendInvalid(res, 'invalid JSON body');
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendInvalid(res, 'body must be a JSON object');
    return null;
  }
  return parsed as Record<string, unknown>;
}

const MERGE_STATUS = { 'not-found': 404, 'not-green': 409, blocked: 409, 'gh-failed': 502 } as const;

/** Each handler owns its cache; the mounted production handler is a process singleton. */
export function createReleasePrApi(deps: ReleasePrApiDeps = {}): ApiModule {
  const run: OpsRunner = async (bin, args) => {
    try { return await (deps.run ?? realRunner)(bin, args); } catch { return null; }
  };
  /** One merge at a time: a double-click must not interleave two gh calls. */
  let mergeInFlight: Promise<unknown> | null = null;
  const handleMerge = async (ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse): Promise<true> => {
    const body = await readMutationBody(ctx, req, res);
    if (!body) return true;
    const { repo, number } = body;
    if (Object.keys(body).some((key) => key !== 'repo' && key !== 'number')
      || !isReleasePrRepoName(repo) || typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
      sendInvalid(res, 'body must be { repo: "owner/name", number: <positive integer> }');
      return true;
    }
    if (mergeInFlight) {
      sendJson(res, 409, { code: 'busy', error: 'A release PR merge is still running — try again in a moment.' });
      return true;
    }
    const work = mergeReleasePr(repo, number, run);
    mergeInFlight = work;
    try {
      const result = await work;
      if (result.ok) sendJson(res, 200, result);
      else sendJson(res, MERGE_STATUS[result.code], { code: result.code, error: result.detail });
    } catch {
      sendJson(res, 500, { code: 'release-pr-merge-failed', error: 'the release PR merge request failed' });
    } finally { mergeInFlight = null; }
    return true;
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
  return async (ctx, req, res, path, method) => {
    if (path === VERSE_RELEASE_PR_MERGE_PATH) {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return true;
      }
      return await handleMerge(ctx, req, res);
    }
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
