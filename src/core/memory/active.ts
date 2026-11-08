/** Durable, caller-scoped evidence snapshots and live worktree verification. */
import { createHash } from 'node:crypto';
import { open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { buildMemoryContextPack } from './pack.js';
import { memoryScopeVisible } from './scope.js';
import { MEMORY_LIMITS, type MemoryContextPack, type MemoryPackQuery, type MemorySnapshot } from './types.js';
import { immutableMemorySnapshot, validMemoryPackQuery } from './validate.js';

const MAX_SOURCE_BYTES = 1024 * 1024;

/** Create an immutable private snapshot. Existing snapshots are never overwritten. */
export async function saveActiveMemory(path: string, input: unknown): Promise<void> {
  const snapshot = immutableMemorySnapshot(input);
  if (!snapshot) throw new Error('Invalid or unsafe memory snapshot.');
  const bytes = JSON.stringify(snapshot);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, 'wx', 0o600);
    await file.writeFile(bytes);
    await file.sync();
  } catch {
    if (file) await unlink(path).catch(() => {});
    throw new Error('Cannot save memory snapshot.');
  } finally { await file?.close(); }
}

export async function readActiveMemory(path: string): Promise<MemorySnapshot> {
  try {
    const file = await open(path, 'r');
    try {
      if ((await file.stat()).size > MEMORY_LIMITS.snapshotBytes) throw new Error();
      const snapshot = immutableMemorySnapshot(JSON.parse(await file.readFile('utf8')));
      if (snapshot) return snapshot;
    } finally { await file.close(); }
  } catch { /* Do not echo disk contents or paths. */ }
  throw new Error('Cannot read memory snapshot.');
}

/**
 * Recheck every in-scope citation against the current worktree. Only relative file locators
 * are supported; missing, oversized, non-file and escaping sources are stale. The digest is
 * SHA-256 of the entire file, so edits, deletions and uncommitted changes invalidate it.
 * This is a point-in-time observation, not a lock on subsequent edits.
 */
export async function activeMemoryContext(snapshot: MemorySnapshot, query: MemoryPackQuery, repo: string): Promise<MemoryContextPack> {
  const safe = immutableMemorySnapshot(snapshot);
  if (!safe || !validMemoryPackQuery(query) || query.time.mode !== 'current' || query.knownAt !== null) {
    throw new Error('Invalid active memory request.');
  }
  const root = await realpath(repo);
  const changed = new Set<string>();
  for (const event of safe.events.filter(item => memoryScopeVisible(item, query))) {
    for (const ref of event.sourceRefs) {
      try {
        if (!ref.locator.startsWith('file:')) throw new Error();
        const path = ref.locator.slice(5);
        if (!path || isAbsolute(path)) throw new Error();
        const target = await realpath(resolve(root, path));
        const rel = relative(root, target);
        if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error();
        const info = await stat(target);
        if (!info.isFile() || info.size > MAX_SOURCE_BYTES) throw new Error();
        const bytes = await readFile(target);
        if (bytes.length > MAX_SOURCE_BYTES || `sha256_${createHash('sha256').update(bytes).digest('hex')}` !== ref.digest) throw new Error();
      } catch { changed.add(ref.id); }
    }
  }
  return buildMemoryContextPack(safe, query, { changedSourceIds: [...changed] });
}
