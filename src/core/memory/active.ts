/** Durable, caller-scoped evidence snapshots and live worktree verification. */
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { buildMemoryContextPack } from './pack.js';
import { memoryScopeVisible } from './scope.js';
import { MEMORY_LIMITS, type MemoryContextPack, type MemoryPackQuery, type MemorySnapshot } from './types.js';
import { immutableMemorySnapshot, validMemoryId, validMemoryPackQuery } from './validate.js';

const MAX_SOURCE_BYTES = 1024 * 1024;

/** Canonical worktree identity keeps unrelated repositories apart, even with identical project labels. */
async function repositoryMemoryDirectory(repo: string, projectId: string, home: string): Promise<string> {
  if (!validMemoryId(projectId)) throw new Error('Invalid memory project.');
  const root = await realpath(repo);
  if (!(await stat(root)).isDirectory()) throw new Error('Invalid memory repository.');
  const key = createHash('sha256').update(root).digest('hex');
  return join(home, '.phantom', 'active-memory', key, projectId);
}

/** Immutable revisions: select the snapshot explicitly, rather than racing a mutable latest pointer. */
export async function saveRepositoryMemory(repo: string, input: unknown, home = homedir()): Promise<string> {
  const snapshot = immutableMemorySnapshot(input);
  const projectId = snapshot?.events[0]?.projectId;
  if (!snapshot || !projectId || snapshot.events.some(event => event.projectId !== projectId)) {
    throw new Error('Repository memory requires one nonempty project scope.');
  }
  const dir = await repositoryMemoryDirectory(repo, projectId, home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${snapshot.snapshotId}-${snapshot.revision}.json`);
  await saveActiveMemory(path, snapshot);
  return path;
}

/** Scope selects the durable store before any records are loaded or ranked. */
export async function repositoryMemoryContext(
  repo: string, snapshotId: string, revision: number, query: MemoryPackQuery, home = homedir(),
): Promise<MemoryContextPack> {
  if (!validMemoryId(snapshotId) || !Number.isSafeInteger(revision) || revision < 0 || !validMemoryPackQuery(query)) {
    throw new Error('Invalid repository memory request.');
  }
  const dir = await repositoryMemoryDirectory(repo, query.projectId, home);
  const snapshot = await readActiveMemory(join(dir, `${snapshotId}-${revision}.json`));
  if (snapshot.snapshotId !== snapshotId || snapshot.revision !== revision
    || snapshot.events.some(event => event.projectId !== query.projectId)) throw new Error('Memory scope mismatch.');
  return activeMemoryContext(snapshot, query, repo);
}

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
  return buildMemoryContextPack(safe, query, { changedSourceIds: [...changed], preferFresh: true });
}
