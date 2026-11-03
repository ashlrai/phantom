import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Deterministic filesystem-independent normalization of an absolute bus root
 * so that equivalent relative and absolute spellings always agree even when
 * the referenced host does not exist.
 */
export function normalizeRoot(path: string): string {
  // Pure string normalization: handles both absolute and relative paths,
  // resolves '..' segments deterministically without filesystem access.
  const isAbsolute = path.startsWith('/');
  let parts = path.split('/').filter(p => p !== '' && p !== '.');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') { if (resolved.length > 0 || !isAbsolute) resolved.pop(); }
    else { resolved.push(part); }
  }
  const result = (isAbsolute ? '/' : '') + resolved.join('/').toLowerCase();
  return result || '/';
}

/**
 * Read a root-scoped checkpoint (version 2) from disk.
 *
 * When `root` is not provided, behaves like the legacy unscoped reader:
 * returns 0 for a missing file, or the cursor for both version 1 (unscoped)
 * and version 2 (root-scoped) checkpoints.
 *
 * When `root` is provided the checkpoint's root must match the caller's
 * normalized root; a mismatched source returns an argument error without
 * any checkpoint mutation.  The actual path value is never included in
 * the error text.  Missing checkpoints still start at zero.
 */
export function readFollowCheckpoint(path: string, invocationId: string | undefined, root?: string): number {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw new Error('checkpoint read failed');
  }
  let record: unknown;
  try { record = JSON.parse(text); } catch { throw new Error('invalid checkpoint'); }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error('invalid checkpoint');
  const value = record as Record<string, unknown>;
  // Accept version 1 (legacy unscoped) or version 2 (root-scoped) when no root validation.
  if (value.version !== 1 && value.version !== 2 || !Number.isSafeInteger(value.cursor) || (value.cursor as number) < 0 ||
    !Object.hasOwn(value, 'invocationId') || value.invocationId !== (invocationId ?? null)) throw new Error('invalid checkpoint');
  if (root !== undefined) {
    if (value.root === undefined || value.root === null) {
      throw new Error('checkpoint requires migration to root-scoped format');
    }
    if (normalizeRoot(value.root as string) !== normalizeRoot(root)) {
      throw new Error('root does not match checkpoint');
    }
  }
  return value.cursor as number;
}

/**
 * Save a version-1 unscoped checkpoint atomically on disk.
 * This helper is retained for backward compatibility but is not used
 * in production flows (which use {@link writeFollowCheckpointWithRoot}).
 */
export function writeFollowCheckpoint(path: string, cursor: number, invocationId: string | undefined): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    created = true;
    try { writeFileSync(fd, JSON.stringify({ version: 1, cursor, invocationId: invocationId ?? null }) + '\n'); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally {
    if (created) { try { unlinkSync(temporary); } catch { /* Renamed or best-effort cleanup. */ } }
  }
}

/**
 * Atomic version-2 write that binds the cursor to the normalized
 * absolute bus root alongside the existing fields.
 */
export function writeFollowCheckpointWithRoot(path: string, cursor: number, invocationId: string | undefined, root: string): void {
  const normalized = normalizeRoot(root);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    created = true;
    try { writeFileSync(fd, JSON.stringify({ version: 2, cursor, invocationId: invocationId ?? null, root: normalized }) + '\n'); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally {
    if (created) { try { unlinkSync(temporary); } catch { /* Renamed or best-effort cleanup. */ } }
  }
}
