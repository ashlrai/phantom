/** Real private immutable fixtures only. No user exports, engines or providers. */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/core/verse/preferences.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/core/verse/preferences.js')>();
  return { ...actual, canonicalProjectPath: vi.fn(() => { throw new Error('No synchronous operator project resolution is permitted after the async guard'); }) };
});
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { contextImportProject, ContextImportError, readContextImport, saveContextImport } from '../src/core/verse/context-import-store.js';
import { contextImportSelectionDigest, previewContextImport } from '../src/core/verse/context-import-preview.js';
import type { ContextImportCommitRequest } from '../src/core/verse/context-import-types.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'context-import-store-'))); roots.push(base);
  const project = join(base, 'project'); const root = join(base, 'verse'); mkdirSync(project, { mode: 0o700 });
  const scope = await contextImportProject(project);
  const preview = await previewContextImport({ text: 'Reviewed reference note.', kind: 'paste', claimedProvider: 'claude', sourceLabel: 'Pasted notes' });
  const request: ContextImportCommitRequest = { schemaVersion: 1, projectPath: project, projectDigest: scope.projectDigest,
    claimedProvider: preview.claimedProvider, provenance: preview.provenance, sourceLabel: preview.sourceLabel,
    sourceDigest: preview.sourceDigest, selectionDigest: await contextImportSelectionDigest(preview.items), items: preview.items, transformations: preview.transformations };
  return { base, root, project, request, scope };
}
function tree(path: string): string {
  const rows: unknown[] = [];
  const visit = (file: string) => { const stat = lstatSync(file); rows.push([file, stat.mode, stat.size, stat.mtimeMs, stat.isFile() ? readFileSync(file).toString('base64') : null]);
    if (stat.isDirectory()) for (const name of readdirSync(file).sort()) visit(join(file, name)); };
  visit(path); return JSON.stringify(rows);
}

describe('immutable untrusted project references', () => {
  it('uses the already guarded physical project identity without synchronously resolving or reading the operator folder', async () => {
    const f = await fixture(); rmSync(f.project, { recursive: true });
    const saved = saveContextImport(f.scope.physical, f.request, f.root);
    expect(saved.record.projectDigest).toBe(f.scope.projectDigest);
    expect(readContextImport(f.scope.projectDigest, saved.record.id, f.root)).toEqual(saved.record);
    const before = tree(f.base);
    for (const malformed of ['relative', f.project + '/..', f.project + '\0', '/x'.repeat(2050)]) {
      expect(() => saveContextImport(malformed, f.request, f.root)).toThrow(ContextImportError);
    }
    expect(tree(f.base)).toBe(before);
  });
  it('reads a missing exact ID without creating directories or altering the project', async () => {
    const f = await fixture(); const before = tree(f.base);
    expect(readContextImport(f.scope.projectDigest, 'ctx_' + 'a'.repeat(64), f.root)).toBeNull(); expect(tree(f.base)).toBe(before);
  });
  it('saves only selected notes, returns exact persisted bytes, and replays without rewriting timestamps or files', async () => {
    const f = await fixture(); const projectBefore = tree(f.project);
    const saved = saveContextImport(f.project, f.request, f.root, new Date('2026-10-14T00:00:00.000Z'));
    expect(saved).toMatchObject({ disposition: 'recorded', record: { items: f.request.items, authority: false, autoInject: false, trust: 'untrusted-external-data' } });
    const file = join(f.root, 'context-imports-' + f.scope.projectDigest.slice(7), 'records', saved.record.id + '.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(saved.record); expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(f.root, 'context-imports-' + f.scope.projectDigest.slice(7))).mode & 0o777).toBe(0o700);
    const beforeReplay = tree(f.base);
    const replay = saveContextImport(f.project, structuredClone(f.request), f.root, new Date('2026-10-15T00:00:00.000Z'));
    expect(replay).toEqual({ ...saved, disposition: 'replayed' }); expect(tree(f.base)).toBe(beforeReplay);
    expect(readContextImport(f.scope.projectDigest, saved.record.id, f.root)).toEqual(saved.record); expect(tree(f.project)).toBe(projectBefore);
    expect(readContextImport('sha256_' + 'b'.repeat(64), saved.record.id, f.root)).toBeNull();
  });
  it('appends a different reviewed selection rather than replacing an existing reference or trusted memory', async () => {
    const f = await fixture(); mkdirSync(f.root, { mode: 0o700 }); const memory = join(f.root, 'MEMORY.md'); writeFileSync(memory, 'Existing trusted decisions.\n', { mode: 0o600 });
    const first = saveContextImport(f.project, f.request, f.root);
    const next = structuredClone(f.request); next.items[0]!.text = 'Different reviewed context.'; next.selectionDigest = await contextImportSelectionDigest(next.items);
    const second = saveContextImport(f.project, next, f.root); expect(second.record.id).not.toBe(first.record.id);
    expect(readContextImport(f.scope.projectDigest, first.record.id, f.root)).toEqual(first.record);
    expect(readFileSync(memory, 'utf8')).toBe('Existing trusted decisions.\n');
  });
  it.each(['selection-digest', 'project-digest', 'extra-authority', 'credential'])('refuses %s before storage effects', async mode => {
    const f = await fixture(); const before = tree(f.base); const input = structuredClone(f.request);
    if (mode === 'selection-digest') input.selectionDigest = 'sha256_' + 'a'.repeat(64);
    if (mode === 'project-digest') input.projectDigest = 'sha256_' + 'a'.repeat(64);
    if (mode === 'extra-authority') Object.assign(input, { authority: true });
    if (mode === 'credential') input.items[0]!.text = 'sk-proj-' + 'a1'.repeat(20);
    expect(() => saveContextImport(f.project, input, f.root)).toThrow(ContextImportError); expect(tree(f.base)).toBe(before);
  });
  it('does not read a record through a replaced symlink or a broadened file mode', async () => {
    const f = await fixture(); const saved = saveContextImport(f.project, f.request, f.root);
    const file = join(f.root, 'context-imports-' + f.scope.projectDigest.slice(7), 'records', saved.record.id + '.json');
    chmodSync(file, 0o644); expect(() => readContextImport(f.scope.projectDigest, saved.record.id, f.root)).toThrow(ContextImportError); chmodSync(file, 0o600);
    const outside = join(f.base, 'other.json'); writeFileSync(outside, readFileSync(file), { mode: 0o600 }); rmSync(file); symlinkSync(outside, file);
    const before = tree(f.base); expect(() => readContextImport(f.scope.projectDigest, saved.record.id, f.root)).toThrow(ContextImportError); expect(tree(f.base)).toBe(before);
  });
  it('refuses changed record contents rather than treating a corrupted read as missing or overwriting it', async () => {
    const f = await fixture(); const saved = saveContextImport(f.project, f.request, f.root);
    const file = join(f.root, 'context-imports-' + f.scope.projectDigest.slice(7), 'records', saved.record.id + '.json');
    const corrupted = { ...saved.record, authority: true }; writeFileSync(file, JSON.stringify(corrupted) + '\n'); const before = tree(f.base);
    expect(() => readContextImport(f.scope.projectDigest, saved.record.id, f.root)).toThrow(ContextImportError);
    expect(() => saveContextImport(f.project, f.request, f.root)).toThrow(ContextImportError); expect(tree(f.base)).toBe(before);
  });
  it('refuses concurrent owned storage, keeps the exact bytes, then safely replays after release', async () => {
    const f = await fixture(); const saved = saveContextImport(f.project, f.request, f.root);
    const directory = join(f.root, 'context-imports-' + f.scope.projectDigest.slice(7));
    const lock = acquireLocalStoreLock(join(directory, '.context-imports.lock'), 0, { anchorPath: f.root, exactPrivateStorage: true }); expect(lock).not.toBeNull();
    try { const before = tree(f.base); expect(() => saveContextImport(f.project, f.request, f.root)).toThrow(ContextImportError); expect(tree(f.base)).toBe(before); }
    finally { releaseLocalStoreLock(lock); }
    expect(saveContextImport(f.project, f.request, f.root).record).toEqual(saved.record);
  });
  it('rejects a symlinked store anchor without changing its target', async () => {
    const f = await fixture(); const other = join(f.base, 'other'); mkdirSync(other, { mode: 0o700 }); symlinkSync(other, f.root);
    const before = tree(f.base); expect(() => saveContextImport(f.project, f.request, f.root)).toThrow(); expect(tree(f.base)).toBe(before);
  });
});
