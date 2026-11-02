import { spawnSync } from 'node:child_process';
import type { NodeAuth } from './state.js';

/** Ask this machine's own GitHub CLI whether it is logged in. Only the exit status is read:
 * output is discarded and no token is read, copied, logged or sent anywhere. A missing
 * `gh` is 'unknown' (not 'missing') so a node without the CLI is not mistaken for a logged-out one.
 */
export function probeLocalAuth(run: typeof spawnSync = spawnSync): NodeAuth {
  const result = run('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 5_000 });
  if (result.error) return 'unknown';
  return result.status === 0 ? 'ok' : 'missing';
}
