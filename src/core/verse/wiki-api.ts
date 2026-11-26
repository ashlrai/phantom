/**
 * Repo wiki API (3.15) — the private DeepWiki. Mounted by verse-api.ts as the
 * `wiki` workbench family.
 *
 *   GET  /api/verse/wiki                          → WikiReposView (enrolled repos + wiki state)
 *   GET  /api/verse/wiki/repo/<key>               → WikiRepoView (per-page staleness, job, GitHub url)
 *   GET  /api/verse/wiki/repo/<key>/page/<id>     → WikiPageView (scrubbed markdown)
 *   GET  /api/verse/wiki/repo/<key>/system-map   → commit-pinned graph (?focus=)
 *   POST /api/verse/wiki/repo/<key>/build {force?, noModel?} → 202 {job}
 *   POST /api/verse/wiki/ask  {question, repoKey?, noModel?} → WikiAskResult
 *   POST /api/verse/wiki/open {repoKey, file, line?}         → {ok}
 *
 * NEVER BUILDS ON THE REQUEST PATH: `build` starts a background job
 * (knowledge/wiki/jobs.ts) and answers 202; the UI polls the repo view. Ask
 * does call a model — it is the operator's question — but through the same
 * seat routing (local first, never Claude) and behind the mutation gate.
 *
 * Repos are addressed by wiki key and resolved ONLY against the enrolled list,
 * so a key can never name an arbitrary folder. `open` only opens files the
 * wiki listed from that repo. All IO here is async (scripts/check-verse-sync-io.mjs):
 * repos live under ~/Desktop, behind macOS privacy prompts.
 *
 * Security posture matches every Verse route: GETs sit behind the read
 * session; a POST is 404 unless dispatch is allowed, then the constant-time
 * mutation token + JSON gate, then a 16 KB body cap. Unknown query parameters
 * and body keys are 400s. Responses are sanitized, and page markdown / answers
 * are secret-scrubbed again on the way out.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { realpath } from 'node:fs/promises';

import type { ApiModule } from './api-modules.js';
import { hasNoQuery, readMutationBody, sendInvalid, sendRefused } from './api-request-helpers.js';
import type { AshlrConfig } from '../types.js';
import { sendJson } from '../web/api.js';
import { askWiki, type AskWikiOptions } from '../knowledge/wiki/ask.js';
import { queryWikiEcosystem } from '../knowledge/wiki/ecosystem.js';
import { buildWikiGraph } from '../knowledge/wiki/graph.js';
import { startWikiJob, wikiJob, type WikiJob } from '../knowledge/wiki/jobs.js';
import { githubNameWithOwner, isWikiReadable } from '../knowledge/wiki/scan.js';
import { scrubWikiText } from '../knowledge/wiki/scrub.js';
import { listWikiRepos, statusFromManifest, wikiCandidateRepos, wikiStatus } from '../knowledge/wiki/status.js';
import { querySystemMap } from '../knowledge/wiki/system-map.js';
import { isPageId, isWikiKey, readFileIndex, readManifest, readPage, wikiKey } from '../knowledge/wiki/store.js';
import { VERSE_WIKI_PATH, type WikiAskResult, type WikiJobView, type WikiPageView, type WikiRepoView, type WikiReposView } from '../knowledge/wiki/types.js';
import { sanitizePublicJson } from '../util/public-json.js';

const MAX_BODY_BYTES = 16 * 1024;

export interface WikiApiDeps {
  candidates(): string[];
  startJob(repo: string, opts: { cfg: AshlrConfig; force: boolean; noModel: boolean }): { ok: true; job: WikiJob } | { ok: false; reason: string };
  job(key: string): WikiJob | null;
  ask(opts: AskWikiOptions): Promise<WikiAskResult>;
  openInEditor(absPath: string, line: number, cfg: AshlrConfig): void;
  github(repo: string): Promise<string | null>;
}

async function defaultOpenInEditor(absPath: string, line: number, cfg: AshlrConfig): Promise<void> {
  const open = await import('../../cli/open.js');
  open.openInEditorAt(absPath, line, cfg);
}

export const DEFAULT_WIKI_API_DEPS: WikiApiDeps = {
  candidates: () => wikiCandidateRepos(),
  startJob: (repo, opts) => startWikiJob(repo, { cfg: opts.cfg, force: opts.force, noModel: opts.noModel }),
  job: (key) => wikiJob(key),
  ask: (opts) => askWiki(opts),
  openInEditor: (absPath, line, cfg) => {
    void defaultOpenInEditor(absPath, line, cfg).catch(() => undefined);
  },
  github: (repo) => githubNameWithOwner(repo),
};

function sendNotFound(res: ServerResponse, what: string): void {
  sendJson(res, 404, { error: `not found: ${what}` });
}

async function sendSystemMap(req: IncomingMessage, res: ServerResponse, repo: string): Promise<void> {
  const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const focuses = params.getAll('focus');
  const focus = focuses[0];
  if ([...params.keys()].some(key => key !== 'focus') || focuses.length > 1 || focus === '' || (focus?.length ?? 0) > 1200) {
    sendInvalid(res, 'Only one nonempty focus of at most 1200 characters is supported.');
    return;
  }
  const map = await querySystemMap(repo, focus);
  const body = sanitizePublicJson(map) as typeof map;
  // Git-produced object IDs are provenance, not credentials (including SHA-256).
  if ('commit' in map && 'commit' in body) {
    body.commit = map.commit;
    for (const item of [...body.nodes, ...body.edges]) item.anchor.commit = map.commit;
  }
  const payload = 'requestedCommit' in map
    ? { ...body, requestedCommit: map.requestedCommit, indexedCommit: map.indexedCommit }
    : body;
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}

/**
 * Paths the render-time scrub keeps intact: every file the wiki listed and
 * every directory above one (module names). Listings, never file contents.
 */
async function knownPaths(key: string | null): Promise<Set<string>> {
  const known = new Set<string>();
  if (!key) return known;
  for (const file of Object.keys(await readFileIndex(key))) {
    known.add(file);
    let dir = path.posix.dirname(file);
    while (dir !== '.' && dir !== '/' && !known.has(dir)) {
      known.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  return known;
}

function jobView(job: WikiJob | null): WikiJobView | null {
  if (!job) return null;
  const { state, startedAt, finishedAt, progress, summary, error, trigger } = job;
  return { state, startedAt, finishedAt, progress, summary, error, trigger };
}

function optionalBool(v: unknown): boolean | null {
  return v === undefined ? false : typeof v === 'boolean' ? v : null;
}

/** The enrolled repo a key names, or null. Keys never resolve outside enrollment. */
function repoForKey(deps: WikiApiDeps, key: string): string | null {
  if (!isWikiKey(key)) return null;
  return deps.candidates().find((r) => wikiKey(r) === key) ?? null;
}

/** Split `/api/verse/wiki/repo/<key>[/page/<id>|/build]`. */
function parseRepoPath(p: string): { key: string; rest: string[] } | null {
  const prefix = `${VERSE_WIKI_PATH}/repo/`;
  if (!p.startsWith(prefix)) return null;
  const parts = p.slice(prefix.length).split('/').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return '\u0000';
    }
  });
  const [key, ...rest] = parts;
  return key ? { key, rest } : null;
}

export function createWikiApi(deps: WikiApiDeps = DEFAULT_WIKI_API_DEPS): ApiModule {
  return async (ctx, req, res, p, method) => {
    if (p !== VERSE_WIKI_PATH && !p.startsWith(`${VERSE_WIKI_PATH}/`)) return false;
    try {
      // ── GET /api/verse/wiki ──────────────────────────────────────────────
      if (p === VERSE_WIKI_PATH) {
        if (method !== 'GET') return (sendNotFound(res, `${method} ${p}`), true);
        if (!hasNoQuery(req, res, 64)) return true;
        const repos = await listWikiRepos();
        const allowed = new Set(deps.candidates());
        const view: WikiReposView = {
          repos: repos
            .filter((r) => allowed.has(r.repo))
            .map((r) => ({ ...r, building: deps.job(r.key)?.state === 'running' }))
            .sort((a, b) => Number(b.exists) - Number(a.exists) || a.name.localeCompare(b.name)),
        };
        sendJson(res, 200, view);
        return true;
      }

      if (p === `${VERSE_WIKI_PATH}/ecosystem`) {
        if (method !== 'GET') return (sendNotFound(res, `${method} ${p}`), true);
        if (!hasNoQuery(req, res, 64)) return true;
        const graph = await queryWikiEcosystem();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify(graph));
        return true;
      }

      // ── POST /api/verse/wiki/ask ─────────────────────────────────────────
      if (p === `${VERSE_WIKI_PATH}/ask`) {
        if (method !== 'POST') return (sendNotFound(res, `${method} ${p}`), true);
        const body = await readMutationBody(ctx, req, res, { allowedKeys: ['question', 'repoKey', 'noModel'], maxBytes: MAX_BODY_BYTES });
        if (!body) return true;
        const noModel = optionalBool(body['noModel']);
        if (typeof body['question'] !== 'string' || !body['question'].trim() || body['question'].length > 1000 || noModel === null) {
          sendInvalid(res, 'question (1–1000 characters) is required; noModel must be a boolean');
          return true;
        }
        let repo: string | undefined;
        if (body['repoKey'] !== undefined) {
          const found = typeof body['repoKey'] === 'string' ? repoForKey(deps, body['repoKey']) : null;
          if (!found) {
            sendRefused(res, 'That repo is not enrolled.');
            return true;
          }
          repo = found;
        }
        const result = await deps.ask({ question: body['question'], ...(repo ? { repo } : {}), cfg: ctx.cfg, noModel });
        sendJson(res, 200, { ...result, answer: scrubWikiText(result.answer, await knownPaths(result.repoKey)) });
        return true;
      }

      // ── POST /api/verse/wiki/open ────────────────────────────────────────
      if (p === `${VERSE_WIKI_PATH}/open`) {
        if (method !== 'POST') return (sendNotFound(res, `${method} ${p}`), true);
        const body = await readMutationBody(ctx, req, res, { allowedKeys: ['repoKey', 'file', 'line'], maxBytes: MAX_BODY_BYTES });
        if (!body) return true;
        const line = body['line'] === undefined ? 1 : body['line'];
        if (typeof body['repoKey'] !== 'string' || typeof body['file'] !== 'string' || typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
          sendInvalid(res, 'repoKey and file (strings) are required; line must be a positive integer');
          return true;
        }
        const repo = repoForKey(deps, body['repoKey']);
        if (!repo) {
          sendRefused(res, 'That repo is not enrolled.');
          return true;
        }
        const file = body['file'];
        // Only files the wiki or its local map actually read may be opened.
        const index = await readFileIndex(body['repoKey']);
        let lines: number | undefined = index[file];
        if (lines === undefined && isWikiReadable(file)) {
          const graph = await buildWikiGraph(repo);
          lines = graph.nodes.flatMap((node) => node.files).find((f) => f.file === file)?.lines;
        }
        if (!isWikiReadable(file) || lines === undefined) {
          sendRefused(res, 'That file is not part of this repo’s wiki.');
          return true;
        }
        const abs = path.resolve(repo, file);
        let real: string;
        let realRepo: string;
        try {
          [real, realRepo] = await Promise.all([realpath(abs), realpath(repo)]);
        } catch {
          sendRefused(res, 'That file no longer exists.');
          return true;
        }
        if (!real.startsWith(realRepo + path.sep)) {
          sendRefused(res, 'That file resolves outside the repo.');
          return true;
        }
        deps.openInEditor(real, Math.min(line, lines), ctx.cfg);
        sendJson(res, 200, { ok: true });
        return true;
      }

      // ── /api/verse/wiki/repo/<key>[/…] ───────────────────────────────────
      const parsed = parseRepoPath(p);
      if (!parsed) return (sendNotFound(res, `${method} ${p}`), true);
      const repo = repoForKey(deps, parsed.key);
      if (!repo) {
        sendNotFound(res, 'wiki repo');
        return true;
      }

      if (parsed.rest.length === 1 && parsed.rest[0] === 'graph') {
        if (method !== 'GET') return (sendNotFound(res, `${method} ${p}`), true);
        if (!hasNoQuery(req, res, 64)) return true;
        sendJson(res, 200, await buildWikiGraph(repo));
        return true;
      }

      if (parsed.rest.length === 1 && parsed.rest[0] === 'system-map') {
        if (method !== 'GET') return (sendNotFound(res, `${method} ${p}`), true);
        await sendSystemMap(req, res, repo);
        return true;
      }

      if (parsed.rest.length === 0) {
        if (method !== 'GET') return (sendNotFound(res, `${method} ${p}`), true);
        if (!hasNoQuery(req, res, 64)) return true;
        const manifest = await readManifest(parsed.key);
        const [status, nameWithOwner] = await Promise.all([manifest ? statusFromManifest(manifest) : wikiStatus(repo), deps.github(repo)]);
        const view: WikiRepoView = {
          status,
          job: jobView(deps.job(parsed.key)),
          githubUrl: nameWithOwner ? `https://github.com/${nameWithOwner}` : null,
        };
        sendJson(res, 200, view);
        return true;
      }

      if (parsed.rest.length === 2 && parsed.rest[0] === 'page') {
        if (method !== 'GET') return (sendNotFound(res, `${method} ${p}`), true);
        if (!hasNoQuery(req, res, 64)) return true;
        const id = parsed.rest[1]!;
        if (!isPageId(id)) return (sendNotFound(res, 'wiki page'), true);
        const [manifest, markdown] = await Promise.all([readManifest(parsed.key), readPage(parsed.key, id)]);
        const meta = manifest?.pages.find((x) => x.id === id);
        if (!manifest || !meta || markdown === null) return (sendNotFound(res, 'wiki page'), true);
        const view: WikiPageView = {
          meta: {
            id: meta.id,
            title: meta.title,
            kind: meta.kind,
            purpose: meta.purpose,
            ...(meta.parent ? { parent: meta.parent } : {}),
            commit: meta.commit,
            generatedAt: meta.generatedAt,
            model: meta.model,
            citations: meta.citations,
            droppedCitations: meta.droppedCitations,
          },
          // Scrubbed when stored; scrubbed again on the way out (defence in depth).
          markdown: scrubWikiText(markdown, await knownPaths(parsed.key)),
        };
        sendJson(res, 200, view);
        return true;
      }

      if (parsed.rest.length === 1 && parsed.rest[0] === 'build') {
        if (method !== 'POST') return (sendNotFound(res, `${method} ${p}`), true);
        const body = await readMutationBody(ctx, req, res, { allowedKeys: ['force', 'noModel'], maxBytes: MAX_BODY_BYTES });
        if (!body) return true;
        const force = optionalBool(body['force']);
        const noModel = optionalBool(body['noModel']);
        if (force === null || noModel === null) {
          sendInvalid(res, 'force and noModel must be booleans');
          return true;
        }
        const started = deps.startJob(repo, { cfg: ctx.cfg, force, noModel });
        if (!started.ok) sendRefused(res, started.reason);
        else sendJson(res, 202, { job: jobView(started.job) });
        return true;
      }

      sendNotFound(res, `${method} ${p}`);
      return true;
    } catch {
      sendJson(res, 500, { error: 'wiki request failed' });
      return true;
    }
  };
}

export const handleWikiApi: ApiModule = createWikiApi();
