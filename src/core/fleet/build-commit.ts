import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null | undefined;

/**
 * The short commit of the build running this process, read once from the git
 * checkout it was loaded from. null for an install with no checkout (npm):
 * unknown is reported as unknown, never guessed.
 */
export function readRunningCommit(): string | null {
  if (cached !== undefined) return cached;
  try {
    const out = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    cached = /^[0-9a-f]{7,40}$/.test(out) ? out : null;
  } catch {
    cached = null;
  }
  return cached;
}
