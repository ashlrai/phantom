import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

type Operation = 'worktree_add' | 'worktree_remove' | 'fetch' | 'push';

export function recordGitOperation(lane: string, operation: Operation | undefined, elapsed_ms: number, ts: string, indexLocked: boolean): void {
  if (!operation && !indexLocked) return;
  try {
    const dir = join(homedir(), '.ashlr-runs', 'metrics');
    const base = { event: 'git_operation', machine: hostname(), lane, ts };
    const rows = [];
    if (operation) rows.push({ ...base, operation, elapsed_ms, ...(
      operation === 'fetch' || operation === 'push' ? { retries: 0 } : {}) });
    // The diagnostic proves failure, not how much time Git spent on the lock.
    if (indexLocked) rows.push({ ...base, operation: 'index.lock', failed: true });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, 'jobs.jsonl'), rows.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 });
  } catch { /* telemetry must not affect Git */ }
}

export function observeGit(lane: string, args: readonly string[]) {
  let i = 0;
  while (args[i]?.startsWith('-')) {
    i += args[i] === '-c' || args[i] === '-C' || args[i] === '--git-dir' || args[i] === '--work-tree' ? 2 : 1;
  }
  const verb = args[i], sub = args[i + 1];
  const operation = verb === 'fetch' || verb === 'push' ? verb
    : verb === 'worktree' && (sub === 'add' || sub === 'remove') ? `worktree_${sub}` as const : undefined;
  const start = performance.now();
  return (stderr?: string | Buffer | null) => recordGitOperation(lane, operation, Math.round(performance.now() - start),
    new Date().toISOString(), /\bindex\.lock\b/.test(typeof stderr === 'string' || Buffer.isBuffer(stderr) ? stderr.toString() : ''));
}

export function observeGitSync<T>(lane: string, args: readonly string[], run: () => T): T {
  const finish = observeGit(lane, args);
  try {
    const result = run();
    finish();
    return result;
  } catch (error) {
    finish((error as { stderr?: string | Buffer } | null)?.stderr);
    throw error;
  }
}

export async function observeGitAsync<T>(lane: string, args: readonly string[], run: () => Promise<T>): Promise<T> {
  const finish = observeGit(lane, args);
  try {
    const result = await run();
    finish();
    return result;
  } catch (error) {
    finish((error as { stderr?: string | Buffer } | null)?.stderr);
    throw error;
  }
}
