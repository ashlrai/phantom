/**
 * core/fleet/dirty-union-collect.ts — the git plumbing the union preview and
 * union apply share. Given a temporary bare repository, one PR's pinned
 * head/base refs and a remote, fetch exactly those refs, run merge-tree and
 * return each conflicting file's three stage texts plus its `merge-file
 * --diff3` rendering. Git objects and scratch files stay in the caller's
 * disposable directory; the host repository is never touched.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultGitRunner } from '../verse/git-ops.js';

const SHA = /^[0-9a-f]{40}$/;
const BLOB_MAX_BYTES = 4 * 1024 * 1024;

export interface UnionPrRef {
  number: number;
  headSha: string;
  baseRef: string;
}

export interface UnionConflictFile {
  path: string;
  /** Shared stage mode — collection verifies all three stages carry the same text mode. */
  mode: string;
  base: string;
  ours: string;
  theirs: string;
  /** The `git merge-file --diff3` rendering used for classification. */
  diff3: string;
}

export type UnionConflictCollect =
  | { ok: true; base: string; files: UnionConflictFile[] }
  | { ok: false; reason: string; files?: string[] };

async function git(cwd: string, args: string[], maxStdoutBytes = 16 * 1024 * 1024) {
  return defaultGitRunner('git', args, { cwd, timeoutMs: 60_000, maxStdoutBytes });
}

export function parseConflictEntry(entry: string): { mode: string; oid: string; stage: string; path: string } | null {
  const [, mode, oid, stage, path] = /^(\d{6}) ([0-9a-f]{40}) ([123])\t([\s\S]+)$/.exec(entry) ?? [];
  if (!mode || !oid || !stage || !path) return null;
  return { mode, oid, stage, path };
}

export async function collectPrConflicts(dir: string, pr: UnionPrRef, remote: string): Promise<UnionConflictCollect> {
  const fail = (reason: string, files?: string[]): UnionConflictCollect => ({ ok: false, reason, ...(files ? { files } : {}) });
  // Fetch only into the disposable repository. A moved head is never classified.
  const baseRef = `refs/heads/${pr.baseRef}`;
  if ((await git(dir, ['check-ref-format', baseRef])).code !== 0) return fail('invalid base ref');
  const fetch = await git(dir, ['-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags', '--no-write-fetch-head',
    remote, `+${baseRef}:refs/preview/base`, `+refs/pull/${pr.number}/head:refs/preview/head`]);
  if (fetch.code !== 0 || fetch.timedOut || fetch.truncated) return fail('fetch failed');
  const head = (await git(dir, ['rev-parse', 'refs/preview/head'])).stdout.trim();
  const base = (await git(dir, ['rev-parse', 'refs/preview/base'])).stdout.trim();
  if (head !== pr.headSha || !SHA.test(base)) return fail('head moved or base unavailable');
  const merge = await git(dir, ['-c', 'core.hooksPath=/dev/null', 'merge-tree', '--write-tree', '-z', base, head]);
  if (merge.code !== 1 || merge.timedOut || merge.truncated) return fail('merge-tree did not produce a conflict');
  const parts = merge.stdout.split('\0');
  if (!SHA.test(parts.shift() ?? '')) return fail('invalid merge-tree output');
  const stages = new Map<string, Map<number, { mode: string; oid: string }>>();
  while (parts.length && parts[0] !== '') {
    const entry = parts.shift()!;
    const parsed = parseConflictEntry(entry);
    if (!parsed) return fail('unreadable conflict entry');
    const { mode, oid, stage, path } = parsed;
    const group = stages.get(path) ?? new Map();
    if (group.has(Number(stage))) return fail('duplicate conflict stage');
    group.set(Number(stage), { mode, oid }); stages.set(path, group);
  }
  parts.shift();
  const paths = [...stages.keys()];
  if (!paths.length) return fail('no conflicting files');
  // Git's structured messages identify non-content conflicts such as renames and binaries.
  while (parts[0]) {
    const count = Number(parts.shift());
    if (!Number.isSafeInteger(count) || count < 1 || parts.length < count + 2) return fail('unreadable conflict message', paths);
    parts.splice(0, count);
    const kind = parts.shift(); parts.shift();
    if (kind !== 'CONFLICT (contents)' && kind !== 'Auto-merging') return fail('non-content conflict', paths);
  }
  const files: UnionConflictFile[] = [];
  for (const [path, group] of stages) {
    const entries = [group.get(1), group.get(2), group.get(3)];
    if (entries.some(entry => !entry || !['100644', '100755'].includes(entry.mode)) ||
        entries.some(entry => entry!.mode !== entries[0]!.mode)) return fail('non-text or structural conflict', paths);
    const blobs: string[] = [];
    for (const entry of entries) {
      const blob = await git(dir, ['cat-file', 'blob', entry!.oid], BLOB_MAX_BYTES);
      if (blob.code !== 0 || blob.truncated || blob.timedOut || /\0|\ufffd/.test(blob.stdout) ||
          (blob.stdout !== '' && !blob.stdout.endsWith('\n')) || /^(<{7}|\|{7}|={7}|>{7})/m.test(blob.stdout)) {
        return fail('unsupported file content', paths);
      }
      blobs.push(blob.stdout);
    }
    const names = ['base', 'ours', 'theirs'].map(name => join(dir, `preview-${name}`));
    await Promise.all(names.map((name, i) => writeFile(name, blobs[i]!)));
    const merged = await git(dir, ['merge-file', '-p', '--diff3', '-L', 'ours', '-L', 'base', '-L', 'theirs', names[1]!, names[0]!, names[2]!]);
    if (merged.code === null || merged.code < 0 || merged.code >= 127 || merged.timedOut || merged.truncated) {
      return fail('merge-file failed', paths);
    }
    files.push({ path, mode: entries[0]!.mode, base: blobs[0]!, ours: blobs[1]!, theirs: blobs[2]!, diff3: merged.stdout });
  }
  return { ok: true, base, files };
}
