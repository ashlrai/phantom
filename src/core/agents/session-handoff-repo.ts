import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { entireId, refuseHandoff, type SessionHandoff } from './session-handoff-schema.js';

const exec = promisify(execFile);
/** Only hashes leave this function; no diff, untracked content or Entire transcript is persisted. */
export async function handoffRepoState(worktree: string): Promise<SessionHandoff['repoState']> {
  try {
    let location = worktree;
    const git = async (...args: string[]) => (await exec('git', ['--no-optional-locks', '-C', location, ...args],
      { timeout: 5000, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' })).stdout;
    const root = await realpath((await git('rev-parse', '--show-toplevel')).toString().trim());
    location = root;
    const head = (await git('rev-parse', '--verify', 'HEAD')).toString().trim();
    const hash = createHash('sha256').update(head);
    for (const args of [['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      ['diff', '--binary', '--no-ext-diff', '--no-textconv'],
      ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv']]) hash.update(await git(...args)).update('\0');
    const untracked = (await git('ls-files', '--others', '--exclude-standard', '-z')).toString().split('\0').filter(Boolean).sort();
    if (untracked.length > 128) return refuseHandoff('Too many untracked files to checkpoint.');
    let bytes = 0;
    for (const name of untracked) {
      const path = join(root, name);
      if (relative(root, await realpath(path)).startsWith('..')) return refuseHandoff('Untracked path escapes worktree.');
      const stat = await lstat(path);
      bytes += stat.size;
      if (!stat.isFile() || stat.nlink !== 1 || bytes > 16 * 1024 * 1024) return refuseHandoff('Untracked file cannot be checkpointed.');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await file.stat();
        if (opened.ino !== stat.ino || opened.size !== stat.size) return refuseHandoff('Worktree changed during checkpoint.');
        const data = Buffer.alloc(stat.size + 1);
        const read = await file.read(data, 0, data.length, 0);
        if (read.bytesRead !== stat.size) return refuseHandoff('Worktree changed during checkpoint.');
        hash.update(name).update('\0').update(String(stat.mode)).update('\0').update(data.subarray(0, stat.size)).update('\0');
      } finally { await file.close(); }
    }
    const trailer = (await git('log', '-1', '--format=%(trailers:key=Entire-Checkpoint,valueonly)')).toString().trim();
    const checkpoint = entireId.safeParse(trailer);
    return { root, head, digest: hash.digest('hex'), entireCheckpoint: checkpoint.success ? checkpoint.data : null };
  } catch { return refuseHandoff('Cannot fingerprint worktree.'); }
}
