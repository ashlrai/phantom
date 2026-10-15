import { webcrypto } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { contextReferenceApi } from './context-client.js';
import { previewContextImport } from '../../../../../core/verse/context-import-preview.js';
import type { ContextImportCommitRequest, ContextImportRecord } from '../../../../../core/verse/context-import-types.js';
const f = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), token: vi.fn(), touch: vi.fn() }));
vi.mock('../../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../../data/client.js')>(), apiGet: f.get, apiPost: f.post }));
vi.mock('../../../../data/auth-store.js', () => ({ getMutationToken: f.token, touchMutationHold: f.touch }));
let saved: ContextImportRecord;
const descriptor = { schemaVersion: 1, projectDigest: 'sha256_' + 'a'.repeat(64), trust: 'untrusted-external-data', authority: false, autoInject: false };
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('crypto', webcrypto); f.token.mockReturnValue('fixture-token');
  f.post.mockImplementation(async (_path: string, request: ContextImportCommitRequest) => {
    const { projectPath: _projectPath, ...payload } = request;
    saved = { ...payload, id: 'ctx_' + 'b'.repeat(64), importedAt: '2026-10-14T01:02:03.000Z', trust: 'untrusted-external-data', authority: false, autoInject: false };
    return { schemaVersion: 1, disposition: 'recorded', record: saved };
  });
  f.get.mockImplementation(async (path: string) => path.includes('/ctx_') ? saved : descriptor);
});
afterEach(() => vi.unstubAllGlobals());
async function input() { return previewContextImport({ text: 'A reference sentence.', kind: 'paste', claimedProvider: 'claude', sourceLabel: 'Pasted context' }); }
describe('selected reference commit and exact readback', () => {
  it('binds scope, operator edits and selection digest, then verifies the exact record before extending the action hold', async () => {
    const preview = await input(); const items = preview.items.map(item => ({ ...item, text: 'An edited reference sentence.' }));
    const signal = new AbortController().signal;
    const record = await contextReferenceApi.save('/fixture/project', preview, items, signal);
    expect(record).toEqual(saved);
    expect(f.get.mock.calls.map(call => call[0])).toEqual(['/api/verse/context-imports?projectPath=%2Ffixture%2Fproject', '/api/verse/context-imports/' + saved.id + '?projectPath=%2Ffixture%2Fproject']);
    expect(f.post).toHaveBeenCalledExactlyOnceWith('/api/verse/context-imports', expect.objectContaining({ projectPath: '/fixture/project', items,
      transformations: ['operator-edited'] }), 'fixture-token', signal);
    expect(f.post.mock.calls[0]![1]).not.toHaveProperty('rawSource'); expect(f.touch).toHaveBeenCalledOnce();
  });
  it('refuses tokenless saving before any descriptor or persistence request', async () => {
    const preview = await input(); f.token.mockReturnValue(null);
    await expect(contextReferenceApi.save('/fixture/project', preview, preview.items, new AbortController().signal)).rejects.toThrow();
    expect(f.get).not.toHaveBeenCalled(); expect(f.post).not.toHaveBeenCalled(); expect(f.touch).not.toHaveBeenCalled();
  });
  it('refuses malformed descriptors before saving', async () => {
    const preview = await input(); f.get.mockResolvedValue({ ...descriptor, autoInject: true });
    await expect(contextReferenceApi.save('/fixture/project', preview, preview.items, new AbortController().signal)).rejects.toThrow();
    expect(f.post).not.toHaveBeenCalled(); expect(f.touch).not.toHaveBeenCalled();
  });
  it('rejects a different saved selection on exact readback', async () => {
    const preview = await input(); f.get.mockImplementation(async (path: string) => path.includes('/ctx_')
      ? { ...saved, items: saved.items.map(item => ({ ...item, text: 'Different text.' })) } : descriptor);
    await expect(contextReferenceApi.save('/fixture/project', preview, preview.items, new AbortController().signal)).rejects.toThrow('readback');
    expect(f.touch).not.toHaveBeenCalled();
  });
  it('does not extend the action hold if cancellation arrives while final verification is pending', async () => {
    const preview = await input(); const abort = new AbortController();
    f.get.mockImplementation(async (path: string) => { if (path.includes('/ctx_')) { abort.abort(new Error('cancelled')); return saved; } return descriptor; });
    await expect(contextReferenceApi.save('/fixture/project', preview, preview.items, abort.signal)).rejects.toThrow('cancelled');
    expect(f.touch).not.toHaveBeenCalled();
  });
});
