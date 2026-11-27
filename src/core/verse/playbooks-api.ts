/**
 * Playbooks API (3.15) — versioned task templates every lane can run under
 * (src/core/playbooks/**). Mounted by verse-api.ts as the `playbooks` family.
 *
 *   GET  /api/verse/playbooks                  → PlaybooksListResponse
 *        (each row carries `kind`; a command workflow's row also carries
 *        its template + params, so a terminal picker needs one read)
 *   GET  /api/verse/playbooks/<id>[?version=N] → PlaybookDetailResponse
 *        (the version, rendered as an engine reads it, every version with
 *        its merged / refused / reverted / failed counts from retros)
 *   POST /api/verse/playbooks  {source, baseVersion?, note?} → PlaybookSaveResponse
 *        a new id ⇒ v1; an existing id ⇒ v<N+1>. A version is never rewritten.
 *
 * Security posture matches every Verse route: GETs sit behind the read
 * session in server.ts; a POST is 404 unless the server allows dispatch, then
 * the constant-time mutation token + JSON Content-Type gate, then the shared
 * body cap. Unknown query parameters and body keys are 400s. A playbook
 * that fails validation is `200 {ok: false, errors}` (field by field). All
 * file I/O is async (scripts/check-verse-sync-io.mjs).
 */
import type { ApiModule } from './api-modules.js';
import { hasNoQuery, readAllowedQuery, readMutationBody, sendInvalid } from './api-request-helpers.js';
import { sendJson } from '../web/api.js';
import {
  PLAYBOOK_ID_PATTERN,
  VERSE_PLAYBOOKS_PATH,
  type PlaybookDetailResponse,
  type PlaybookSaveResponse,
  type PlaybooksListResponse,
} from '../playbooks/types.js';

const SAVE_KEYS = ['source', 'baseVersion', 'note'] as const;

function owns(path: string): boolean {
  return path === VERSE_PLAYBOOKS_PATH || path.startsWith(`${VERSE_PLAYBOOKS_PATH}/`);
}

async function detail(id: string, version: number | null): Promise<PlaybookDetailResponse | null> {
  const [{ getPlaybook, listPlaybookVersions }, { renderPlaybookBlock }, { emptyOutcomes, playbookOutcomes }, { renderCommandWorkflowMarkdown }] = await Promise.all([
    import('../playbooks/store.js'),
    import('../playbooks/resolve.js'),
    import('../playbooks/stats.js'),
    import('../playbooks/command-template.js'),
  ]);
  const playbook = await getPlaybook(id, version);
  if (!playbook) return null;
  const [versions, outcomes] = await Promise.all([listPlaybookVersions(id), playbookOutcomes(id)]);
  const command = playbook.meta.kind === 'command' ? playbook.meta.command : undefined;
  return {
    v: 1,
    playbook,
    // A command workflow never reaches an engine (renderPlaybookBlock is ''
    // for one): show its command and parameters instead.
    rendered: command ? renderCommandWorkflowMarkdown(playbook.meta.name, command) : renderPlaybookBlock(playbook),
    versions: versions.map((v) => ({ ...v, outcomes: outcomes.get(v.version) ?? emptyOutcomes() })),
  };
}

/**
 * The playbooks route family. Returns false for any path outside
 * /api/verse/playbooks so the next module (or the 404) runs.
 */
export const handlePlaybooksApi: ApiModule = async (ctx, req, res, path, method) => {
  if (!owns(path)) return false;
  try {
    if (method === 'GET') {
      if (path === VERSE_PLAYBOOKS_PATH) {
        if (!hasNoQuery(req, res, 64)) return true;
        const { listPlaybookSummaries } = await import('../playbooks/store.js');
        const body: PlaybooksListResponse = { v: 1, playbooks: await listPlaybookSummaries() };
        sendJson(res, 200, body);
        return true;
      }
      const id = path.slice(VERSE_PLAYBOOKS_PATH.length + 1);
      if (!PLAYBOOK_ID_PATTERN.test(id)) {
        sendJson(res, 404, { error: `not found: ${method} ${path}` });
        return true;
      }
      const params = readAllowedQuery(req, res, ['version'], { maxKeyChars: 64 });
      if (!params) return true;
      const rawVersion = params.get('version');
      let version: number | null = null;
      if (rawVersion !== null) {
        if (!/^[1-9]\d{0,5}$/.test(rawVersion)) {
          sendInvalid(res, 'version must be a positive integer');
          return true;
        }
        version = Number(rawVersion);
      }
      const found = await detail(id, version);
      if (!found) {
        sendJson(res, 404, { error: version === null ? `no playbook named ${id}` : `no version ${version} of ${id}` });
        return true;
      }
      sendJson(res, 200, found);
      return true;
    }
    if (method !== 'POST' || path !== VERSE_PLAYBOOKS_PATH) {
      sendJson(res, 404, { error: `not found: ${method} ${path}` });
      return true;
    }
    const body = await readMutationBody(ctx, req, res, { allowedKeys: SAVE_KEYS });
    if (!body) return true;
    if (typeof body['source'] !== 'string') {
      sendInvalid(res, 'source must be the playbook markdown');
      return true;
    }
    const baseVersion = body['baseVersion'];
    if (baseVersion !== undefined && !(Number.isInteger(baseVersion) && (baseVersion as number) >= 1)) {
      sendInvalid(res, 'baseVersion must be a positive integer');
      return true;
    }
    const note = body['note'];
    if (note !== undefined && (typeof note !== 'string' || note.length > 500)) {
      sendInvalid(res, 'note must be text (at most 500 characters)');
      return true;
    }
    const { savePlaybook } = await import('../playbooks/store.js');
    const result = await savePlaybook(body['source'], {
      ...(baseVersion !== undefined ? { baseVersion: baseVersion as number } : {}),
      ...(typeof note === 'string' ? { note } : {}),
      author: 'mason',
    });
    if (!result.ok) {
      // A domain outcome, not a transport error: 200 with the field errors so
      // the editor can show each one where it belongs.
      const response: PlaybookSaveResponse = { ok: false, errors: result.errors };
      sendJson(res, 200, response);
      return true;
    }
    const response: PlaybookSaveResponse = { ok: true, playbook: result.playbook };
    sendJson(res, 200, response);
    return true;
  } catch {
    sendJson(res, 500, { error: 'playbooks request failed' });
    return true;
  }
};
