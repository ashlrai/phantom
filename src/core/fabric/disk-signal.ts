/** Read-only disk measurements for a data volume and a worktree directory. */
import { statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';

function readWorktreeSize(root: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('du', ['-sk', '--', root], { timeout: 5000, maxBuffer: 4096 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export interface DiskMeasurements {
  freeBytes: number | null;
  worktreeBytes: number | null;
}

/**
 * Measure available space for the current user and allocated worktree bytes.
 * An unavailable or incomplete measurement is null, never a healthy zero.
 */
export async function measureDisk(dataPath: string, worktreeRoot: string): Promise<DiskMeasurements> {
  const [freeBytes, worktreeBytes] = await Promise.all([
    statfs(dataPath).then(({ bavail, bsize }) => {
      const bytes = bavail * bsize;
      return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
    }).catch(() => null),
    readWorktreeSize(worktreeRoot)
      .then((stdout) => {
        const match = /^(\d+)\s/.exec(stdout);
        if (!match) return null;
        const bytes = Number(match[1]) * 1024;
        return Number.isSafeInteger(bytes) ? bytes : null;
      }).catch(() => null),
  ]);
  return { freeBytes, worktreeBytes };
}
