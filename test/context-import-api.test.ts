/** Real private HTTP fixtures and injected storage; no native sessions or provider transport. */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/core/cloud/cloud-api.js', () => { throw new Error('Cloud scheduler must not load for context import'); });
vi.mock('../src/core/devin/devin-api.js', () => { throw new Error('Devin scheduler must not load for context import'); });
import { createContextImportApi } from '../src/core/verse/context-import-api.js';
import { CONTEXT_IMPORT_BODY_BYTES, CONTEXT_IMPORT_PATH, type ContextImportCommitRequest } from '../src/core/verse/context-import-types.js';
import { contextImportProject } from '../src/core/verse/context-import-store.js';
import { contextImportSelectionDigest, previewContextImport } from '../src/core/verse/context-import-preview.js';
import { handleVerseApi, peekVerseEngine, type VerseApiContext } from '../src/core/verse/verse-api.js';
import { handleApi } from '../src/core/web/api.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function call(method: string, url: string, body = '', token = false, read = true, allowDispatch = true) {
  const req = Readable.from([body]) as unknown as IncomingMessage; req.url = url; req.method = method;
  req.headers = { 'content-type': 'application/json', ...(token ? { 'x-ashlr-token': 'x'.repeat(64) } : {}) };
  let output = '';
  const res = { statusCode: 0, headersSent: false, setHeader: vi.fn(), writeHead(status: number) { this.statusCode = status; this.headersSent = true; }, end(text: string) { output = text; } } as unknown as ServerResponse;
  const ctx = { token: 'x'.repeat(64), allowDispatch, ...(read ? { readSession: { id: 'fixture-read', expiresAt: Date.now() + 60_000 } } : {}) } as VerseApiContext;
  return { req, res, ctx, path: new URL(url, 'http://localhost').pathname, output: () => JSON.parse(output) };
}
async function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'context-import-api-'))); roots.push(base);
  const project = join(base, 'project'); const root = join(base, 'verse'); mkdirSync(project, { mode: 0o700 });
  const scope = await contextImportProject(project); const preview = await previewContextImport({ text: 'Selected local reference.', kind: 'paste', claimedProvider: 'chatgpt', sourceLabel: 'Pasted notes' });
  const request: ContextImportCommitRequest = { schemaVersion: 1, projectPath: project, projectDigest: scope.projectDigest, claimedProvider: preview.claimedProvider,
    provenance: preview.provenance, sourceLabel: preview.sourceLabel, sourceDigest: preview.sourceDigest, selectionDigest: await contextImportSelectionDigest(preview.items), items: preview.items, transformations: preview.transformations };
  return { root, project, scope, request, url: CONTEXT_IMPORT_PATH + '?projectPath=' + encodeURIComponent(project) };
}
describe('context import authentication, selective commit and exact readback', () => {
  it.each(['absent', 'expired'])('refuses %s read authority before project or storage access', async mode => {
    const project = vi.fn(), read = vi.fn(); const c = call('GET', CONTEXT_IMPORT_PATH + '?projectPath=/fixture', '', false, mode !== 'absent');
    if (mode === 'expired') c.ctx.readSession!.expiresAt = 1;
    await createContextImportApi({ project, read })(c.ctx, c.req, c.res, c.path, 'GET');
    expect(c.res.statusCode).toBe(401); expect(project).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
  it.each([false, true])('requires mutation authorization with dispatch=%s before project, body or storage access', async allowed => {
    const project = vi.fn(), save = vi.fn(); const c = call('POST', CONTEXT_IMPORT_PATH, '{private malformed input', false, true, allowed);
    await createContextImportApi({ project, save })(c.ctx, c.req, c.res, c.path, 'POST');
    expect(c.res.statusCode).toBe(allowed ? 401 : 404); expect(project).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it('saves selected references and confirms an exact project-bound point read while retaining public sanitization', async () => {
    const f = await fixture(); const api = createContextImportApi({ root: () => f.root });
    const descriptor = call('GET', f.url); await api(descriptor.ctx, descriptor.req, descriptor.res, descriptor.path, 'GET');
    expect(descriptor.output()).toMatchObject({ projectDigest: f.scope.projectDigest, authority: false, autoInject: false });
    const save = call('POST', CONTEXT_IMPORT_PATH, JSON.stringify(f.request), true); await api(save.ctx, save.req, save.res, save.path, 'POST');
    expect(save.res.statusCode).toBe(200); const result = save.output(); expect(result.record.items).toEqual(f.request.items);
    expect(JSON.stringify(result)).not.toContain(f.project); expect(result.record.trust).toBe('untrusted-external-data');
    const get = call('GET', CONTEXT_IMPORT_PATH + '/' + result.record.id + '?projectPath=' + encodeURIComponent(f.project));
    await api(get.ctx, get.req, get.res, get.path, 'GET'); expect(get.res.statusCode).toBe(200); expect(get.output()).toEqual(result.record);
    const again = call('POST', CONTEXT_IMPORT_PATH, JSON.stringify(f.request), true); await api(again.ctx, again.req, again.res, again.path, 'POST');
    expect(again.output()).toEqual({ ...result, disposition: 'replayed' });
  });
  it.each(['extra', 'credential', 'foreign-home-text', 'foreign-home-locator', 'wrong-digest', 'wrong-project', 'unknown-transformation'])('refuses invalid selected body %s with no quoted private content', async mode => {
    const f = await fixture(); const request = structuredClone(f.request);
    if (mode === 'extra') Object.assign(request, { nativeSessionId: 'private-account' });
    if (mode === 'credential') request.items[0]!.text = 'xai-' + 'a1'.repeat(30);
    if (mode === 'foreign-home-text') request.items[0]!.text = 'Edited /Users/alice/private context.';
    if (mode === 'foreign-home-locator') request.items[0]!.sourceLocator = '/Users/alice/private';
    if (mode === 'wrong-digest') request.selectionDigest = 'sha256_' + 'b'.repeat(64);
    if (mode === 'wrong-project') request.projectDigest = 'sha256_' + 'b'.repeat(64);
    if (mode === 'unknown-transformation') request.transformations = ['execute' as never];
    const c = call('POST', CONTEXT_IMPORT_PATH, JSON.stringify(request), true); await createContextImportApi({ root: () => f.root })(c.ctx, c.req, c.res, c.path, 'POST');
    expect(c.res.statusCode).toBe(mode === 'wrong-project' ? 409 : 400); expect(JSON.stringify(c.output())).not.toContain('private-account'); expect(JSON.stringify(c.output())).not.toContain('xai-');
    expect(JSON.stringify(c.output())).not.toContain('/Users/alice');
  });
  it('bounds the expanded selected JSON body without reading a project or writing data', async () => {
    const project = vi.fn(), save = vi.fn(); const c = call('POST', CONTEXT_IMPORT_PATH, 'x'.repeat(CONTEXT_IMPORT_BODY_BYTES + 1), true);
    await createContextImportApi({ project, save })(c.ctx, c.req, c.res, c.path, 'POST'); expect(c.res.statusCode).toBe(413);
    expect(project).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it.each(['/unknown', '/ctx_invalid', '/ctx_' + 'a'.repeat(64) + '/extra'])('keeps unknown namespace %s away from project, storage and legacy modules', async suffix => {
    const project = vi.fn(), read = vi.fn(); const c = call('GET', CONTEXT_IMPORT_PATH + suffix + '?projectPath=/fixture');
    await createContextImportApi({ project, read })(c.ctx, c.req, c.res, c.path, 'GET'); expect(c.res.statusCode).toBe(404);
    expect(project).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    await handleVerseApi(c.ctx, c.req, c.res, c.path, 'GET'); expect(c.res.statusCode).toBe(404); expect(peekVerseEngine()).toBeNull();
  });
  it('rejects unexpected/duplicate query keys and wrong-method requests without effects', async () => {
    const project = vi.fn(), save = vi.fn(); const api = createContextImportApi({ project, save });
    for (const query of ['?projectPath=/one&projectPath=/two', '?projectPath=/one&root=/private', '?root=/private']) {
      const c = call('GET', CONTEXT_IMPORT_PATH + query); await api(c.ctx, c.req, c.res, c.path, 'GET'); expect(c.res.statusCode).toBe(400);
    }
    const c = call('DELETE', CONTEXT_IMPORT_PATH, '', true); await api(c.ctx, c.req, c.res, c.path, 'DELETE'); expect(c.res.statusCode).toBe(404);
    expect(project).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it.each(['/../unknown', '/%2E%2E/unknown', '/../../snapshot', '/foo/../ctx_' + 'a'.repeat(64), '/foo/%2e%2e/ctx_' + 'a'.repeat(64), '%2Funknown', 'extra'])('refuses raw namespace alias %s before normalized legacy routes or project access', async suffix => {
    const project = vi.fn(), read = vi.fn(), save = vi.fn();
    for (const method of ['GET', 'POST']) {
      const c = call(method, CONTEXT_IMPORT_PATH + suffix + '?projectPath=/fixture', '{}', true);
      const api = createContextImportApi({ project, read, save });
      expect(await api(c.ctx, c.req, c.res, c.path, method)).toBe(true); expect(c.res.statusCode).toBe(404);
      expect(await handleVerseApi(c.ctx, c.req, c.res, c.path, method)).toBe(true); expect(c.res.statusCode).toBe(404);
      expect(await handleApi(c.req, c.res, {} as VerseApiContext['cfg'], c.ctx)).toBe(true); expect(c.res.statusCode).toBe(404);
      expect(c.output()).toEqual({ code: 'CONTEXT_IMPORT_NOT_FOUND', error: 'Imported reference unavailable.' });
      expect(peekVerseEngine()).toBeNull();
    }
    expect(project).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it('serves the actual early descriptor route without constructing the engine or loading schedulers', async () => {
    const f = await fixture(); const c = call('GET', f.url);
    expect(await handleVerseApi(c.ctx, c.req, c.res, c.path, 'GET')).toBe(true); expect(c.res.statusCode).toBe(200); expect(peekVerseEngine()).toBeNull();
  });
});
