/** Immutable project-scoped reference documents. No trusted memory or session writes. */
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { readImmutablePrivateRecordPoint, writeImmutablePrivateRecord,
  type ImmutablePrivateRecordCodec, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { defaultVerseRoot, ensurePrivateDirectory } from './preferences.js';
import { checkWorkspaceRootPathAsync } from './path-guard.js';
import { withFolderIo } from './folder-io.js';
import { contextImportCanonical, CONTEXT_IMPORT_TRUST, CONTEXT_IMPORT_BODY_BYTES,
  validContextImportCommitRequest, validContextImportDigest, validContextImportId, validContextImportRecord,
  type ContextImportCommitRequest, type ContextImportRecord, type ContextImportCommitResponse } from './context-import-types.js';

const digest = (text: string) => 'sha256_' + createHash('sha256').update(text, 'utf8').digest('hex');
export class ContextImportError extends Error {
  constructor(public readonly reason: 'invalid' | 'conflict' | 'unavailable') { super('Context import unavailable.'); }
}
export async function contextImportProject(raw: unknown): Promise<{ physical: string; projectDigest: string }> {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 4096) throw new ContextImportError('invalid');
  const result = await withFolderIo(() => checkWorkspaceRootPathAsync(raw.trim()));
  if (!result.ok) throw new ContextImportError('invalid');
  return { physical: result.path, projectDigest: digest(result.path) };
}
function identity(record: Omit<ContextImportRecord, 'id' | 'importedAt' | 'trust' | 'authority' | 'autoInject'>): string {
  return 'ctx_' + createHash('sha256').update(contextImportCanonical(record), 'utf8').digest('hex');
}
function core(record: ContextImportRecord) {
  const { id: _id, importedAt: _at, trust: _trust, authority: _authority, autoInject: _autoInject, ...rest } = record;
  return rest;
}
function parseRecord(value: unknown): ContextImportRecord | null {
  if (!validContextImportRecord(value) || value.selectionDigest !== digest(contextImportCanonical(value.items)) || value.id !== identity(core(value))) return null;
  return value;
}
const codec: ImmutablePrivateRecordCodec<ContextImportRecord> = {
  parse: parseRecord, serialize: record => contextImportCanonical(record) + '\n',
  recordId: record => record.id, recordFileName: record => record.id + '.json',
  isRecordFileName: name => /^ctx_[a-f0-9]{64}\.json$/.test(name), stageToken: record => record.id,
  // First publication owns importedAt. Retrying identical content returns that
  // persisted record, never rewrites its timestamp or silently replaces data.
  equivalent: (a, b) => contextImportCanonical(core(a)) === contextImportCanonical(core(b)),
};
function config(root: string, projectDigest: string): ImmutablePrivateRecordStoreConfig<ContextImportRecord> {
  if (!validContextImportDigest(projectDigest)) throw new ContextImportError('invalid');
  return { label: 'Imported project context', anchorPath: root, rootPath: join(root, 'context-imports-' + projectDigest.slice(7)),
    lockFileName: '.context-imports.lock', maxRecordBytes: CONTEXT_IMPORT_BODY_BYTES,
    defaultMaxFiles: 256, hardMaxFiles: 256, defaultMaxBytes: 32 * 1024 * 1024, hardMaxBytes: 32 * 1024 * 1024,
    codecForRead: () => codec, codecForWrite: () => codec };
}
export function readContextImport(projectDigest: string, id: string, root = defaultVerseRoot()): ContextImportRecord | null {
  if (!validContextImportId(id) || !validContextImportDigest(projectDigest)) throw new ContextImportError('invalid');
  const read = readImmutablePrivateRecordPoint(config(root, projectDigest), id, id + '.json');
  if (read.sourceState === 'missing') return null;
  if (read.sourceState !== 'healthy' || !read.exactReadComplete || read.record && read.record.projectDigest !== projectDigest) throw new ContextImportError('unavailable');
  return read.record;
}
export function saveContextImport(physicalProject: string, input: ContextImportCommitRequest,
  root = defaultVerseRoot(), now = new Date()): ContextImportCommitResponse {
  if (!validContextImportCommitRequest(input) || input.selectionDigest !== digest(contextImportCanonical(input.items))) throw new ContextImportError('invalid');
  // The async folder guard already resolved this physical identity. Repeating
  // realpath here would block the HTTP thread on an operator folder. This
  // writer accesses only private reference storage, never the project itself.
  if (typeof physicalProject !== 'string' || physicalProject.length > 4096 || physicalProject.includes('\0')
    || !isAbsolute(physicalProject) || resolve(physicalProject) !== physicalProject) throw new ContextImportError('invalid');
  if (input.projectDigest !== digest(physicalProject)) throw new ContextImportError('conflict');
  const { projectPath: _path, ...payload } = input;
  const detached = JSON.parse(contextImportCanonical(payload)) as typeof payload;
  const record: ContextImportRecord = { ...detached, id: identity(detached), importedAt: now.toISOString(),
    trust: CONTEXT_IMPORT_TRUST, authority: false, autoInject: false };
  // Existing public readback always sanitizes. Refuse data whose displayed
  // bytes could not prove the exact selected immutable record; no raw bypass.
  if (!parseRecord(record) || contextImportCanonical(sanitizePublicJson(record)) !== contextImportCanonical(record)) throw new ContextImportError('invalid');
  const existing = readContextImport(record.projectDigest, record.id, root);
  if (existing) {
    if (!codec.equivalent(existing, record)) throw new ContextImportError('conflict');
    return { schemaVersion: 1, disposition: 'replayed', record: existing };
  }
  ensurePrivateDirectory(root);
  const disposition = writeImmutablePrivateRecord(config(root, record.projectDigest), record, { lockWaitMs: 0 });
  if (disposition === 'conflicted') throw new ContextImportError('conflict');
  if (disposition !== 'recorded' && disposition !== 'replayed') throw new ContextImportError('unavailable');
  const persisted = readContextImport(record.projectDigest, record.id, root);
  if (!persisted || !codec.equivalent(persisted, record)) throw new ContextImportError('unavailable');
  return { schemaVersion: 1, disposition, record: persisted };
}
