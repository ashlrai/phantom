/** Release PR status (GET, cached fifteen seconds per process) and the one-tap merge (POST .../merge). */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { nameWithOwnerFromRemote } from '../fleet/repo-identity.js';
import { listEnrolled } from '../sandbox/policy.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { scrubSecrets } from '../util/scrub.js';
import type { ApiModule } from './api-modules.js';
import { mapLimited } from './folder-io.js';
import type { OpsRunner } from './ops-releases.js';
import { isReleasePrRepoName, mergeReleasePr, probeReleasePr, type ReleasePrV1 } from './ops-release-pr.js';
import { releaseVersionLine, releaseVersionVerdict, treeVersionFromPackageJson, type ReleaseVersionVerdict } from './release-version-guard.js';
import type { VerseApiContext } from './verse-api.js';

export const VERSE_RELEASE_PR_PATH = '/api/verse/release-pr';
export const VERSE_RELEASE_PR_MERGE_PATH = '/api/verse/release-pr/merge';
export interface ReleasePrResponseV1 {
  v: 1;
  generatedAt: string;
  sourceState: 'healthy' | 'degraded';
  repos: { repo: string; path: string; pr: ReleasePrV1 | null; notes: string[];
    treeVersion: string | null; versionVerdict: ReleaseVersionVerdict }[];
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
  readTreeVersion?: (path: string) => Promise<string | null>;
}

/** Reads `<checkout>/package.json` — never a path outside the enrolled checkout. */
const readTreeVersionFile = async (path: string): Promise<string | null> => {
  try { return treeVersionFromPackageJson(await readFile(join(path, 'package.json'), 'utf8')); }
  catch { return null; }
};

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
  const treeVersion = async (path: string): Promise<string | null> => {
    try { return await (deps.readTreeVersion ?? readTreeVersionFile)(path); } catch { return null; }
  };
  /** One merge at a time: a double-click must not interleave two gh calls. */
  let mergeInFlight: Promise<unknown> | null = null;
  const handleMerge = async (ctx: VerseApiContext, req: IncomingMessage, res: ServerResponse): Promise<true> => {
    const body = await readMutationBody(ctx, req, res);
    if (!body) return true;
    const { repo, number, confirmVersion } = body;
    if (Object.keys(body).some((key) => key !== 'repo' && key !== 'number' && key !== 'confirmVersion')
      || !isReleasePrRepoName(repo) || typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0
      || (confirmVersion !== undefined && typeof confirmVersion !== 'string')) {
      sendInvalid(res, 'body must be { repo: "owner/name", number: <positive integer>, confirmVersion?: <version string> }');
      return true;
    }
    if (mergeInFlight) {
      sendJson(res, 409, { code: 'busy', error: 'A release PR merge is still running — try again in a moment.' });
      return true;
    }
    /** The version check lives inside the latch with the merge, so the tap is refused before `gh pr merge` can ship a downgrade. */
    const work = (async (): Promise<{ status: number; body: unknown }> => {
      let paths: string[] = [];
      try { paths = (deps.enrolled ?? listEnrolled)(); } catch { paths = []; }
      let checkout: string | null = null;
      for (const path of [...new Set(paths)]) {
        const origin = await run('git', ['-C', path, 'remote', 'get-url', 'origin']);
        if (origin && nameWithOwnerFromRemote(origin.trim()) === repo) { checkout = path; break; }
      }
      // An enrolled list that cannot prove this repo refuses; with no enrolled
      // checkouts there is no tree to compare, the verdict is 'unknown' and the
      // merge below keeps its own not-found answer.
      if (checkout === null && paths.length > 0) {
        return { status: 404, body: { code: 'not-found', error: `${repo} is not an enrolled checkout` } };
      }
      const tree = checkout === null ? null : await treeVersion(checkout);
      const pr = await probeReleasePr(repo, run);
      const verdict = releaseVersionVerdict(pr?.version ?? null, tree);
      if (verdict === 'downgrade' && pr !== null && confirmVersion !== pr.version) {
        return { status: 409, body: { code: 'version-downgrade',
          error: releaseVersionLine(pr.number, pr.version, tree, verdict),
          prVersion: pr.version, treeVersion: tree } };
      }
      const result = await mergeReleasePr(repo, number, run);
      if (!result.ok) return { status: MERGE_STATUS[result.code], body: { code: result.code, error: result.detail } };
      const confirmed = typeof confirmVersion === 'string' && pr !== null && confirmVersion === pr.version;
      return { status: 200, body: confirmed ? { ...result, confirmedVersion: confirmVersion } : result };
    })();
    mergeInFlight = work;
    try {
      const outcome = await work;
      sendJson(res, outcome.status, outcome.body);
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
      const tree = await treeVersion(path);
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
      const versionVerdict = releaseVersionVerdict(pr?.version ?? null, tree);
      if (versionVerdict === 'downgrade' && pr !== null) notes.push(releaseVersionLine(pr.number, pr.version, tree, versionVerdict));
      return { repo: scrubSecrets(repo ?? basename(path)).slice(0, 140), path, pr, notes, treeVersion: tree, versionVerdict };
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
