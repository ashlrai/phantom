/** Explicit selected-data commit and exact authenticated readback, before engine creation. */
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { defaultVerseRoot } from './preferences.js';
import type { ApiModule } from './api-modules.js';
import { CONTEXT_IMPORT_PATH, CONTEXT_IMPORT_BODY_BYTES, CONTEXT_IMPORT_TRUST,
  validContextImportCommitRequest, validContextImportId } from './context-import-types.js';
import { ContextImportError, contextImportProject, readContextImport, saveContextImport } from './context-import-store.js';

interface Dependencies {
  root?: () => string; project?: typeof contextImportProject; save?: typeof saveContextImport; read?: typeof readContextImport;
}
export function createContextImportApi(deps: Dependencies = {}): ApiModule {
  const root = deps.root ?? defaultVerseRoot;
  const project = deps.project ?? contextImportProject;
  return async (ctx, req, res, path, method) => {
    const rawPath = (req.url ?? path).split(/[?#]/, 1)[0] ?? '';
    if (!rawPath.startsWith(CONTEXT_IMPORT_PATH) && !path.startsWith(CONTEXT_IMPORT_PATH)) return false;
    if (method === 'GET') {
      if (!ctx.readSession || !Number.isFinite(ctx.readSession.expiresAt) || ctx.readSession.expiresAt <= Date.now()) {
        sendJson(res, 401, { code: 'CONTEXT_IMPORT_READ_REQUIRED', error: 'A current read session is required.' }); return true;
      }
    } else {
      if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
      if (!passesMutationGate(req, res, ctx.token)) return true;
    }
    if (rawPath !== path || path !== CONTEXT_IMPORT_PATH && !path.startsWith(CONTEXT_IMPORT_PATH + '/')) {
      sendJson(res, 404, { code: 'CONTEXT_IMPORT_NOT_FOUND', error: 'Imported reference unavailable.' }); return true;
    }
    try {
      const url = new URL(req.url ?? path, 'http://localhost');
      if (url.pathname !== path || url.hash) throw new ContextImportError('invalid');
      if (method === 'GET') {
        const id = path.slice(CONTEXT_IMPORT_PATH.length + 1);
        if (path !== CONTEXT_IMPORT_PATH && !validContextImportId(id)) { sendJson(res, 404, { code: 'CONTEXT_IMPORT_NOT_FOUND', error: 'Imported reference unavailable.' }); return true; }
        const params = url.searchParams;
        if (params.size !== 1 || params.getAll('projectPath').length !== 1) throw new ContextImportError('invalid');
        const scope = await project(params.get('projectPath'));
        if (path === CONTEXT_IMPORT_PATH) {
          sendJson(res, 200, { schemaVersion: 1, projectDigest: scope.projectDigest, trust: CONTEXT_IMPORT_TRUST, authority: false, autoInject: false }); return true;
        }
        const record = (deps.read ?? readContextImport)(scope.projectDigest, id, root());
        if (!record) { sendJson(res, 404, { code: 'CONTEXT_IMPORT_NOT_FOUND', error: 'Imported reference unavailable.' }); return true; }
        sendJson(res, 200, record); return true;
      }
      if (method !== 'POST' || path !== CONTEXT_IMPORT_PATH) { sendJson(res, 404, { error: 'Context import action not found.' }); return true; }
      if (url.search) throw new ContextImportError('invalid');
      let raw: string;
      try { raw = await readBody(req, CONTEXT_IMPORT_BODY_BYTES); }
      catch { sendJson(res, 413, { code: 'CONTEXT_IMPORT_TOO_LARGE', error: 'Selected context is too large.' }); return true; }
      let input: unknown;
      try { input = JSON.parse(raw); } catch { throw new ContextImportError('invalid'); }
      if (!validContextImportCommitRequest(input)) throw new ContextImportError('invalid');
      const scope = await project(input.projectPath);
      if (scope.projectDigest !== input.projectDigest) throw new ContextImportError('conflict');
      const saved = (deps.save ?? saveContextImport)(scope.physical, input, root());
      sendJson(res, 200, saved); return true;
    } catch (error) {
      const reason = error instanceof ContextImportError ? error.reason : 'unavailable';
      sendJson(res, reason === 'invalid' ? 400 : reason === 'conflict' ? 409 : 503, {
        code: 'CONTEXT_IMPORT_REFUSED', reason, error: reason === 'invalid'
          ? 'Check the selected notes, project and fingerprints. Remove credentials and private paths before saving.'
          : reason === 'conflict' ? 'The project or selected context changed. Review it again.'
            : 'The reference could not be confirmed. Retry the same selection; it may already have been saved.',
      }); return true;
    }
  };
}
export const handleContextImportApi = createContextImportApi();
