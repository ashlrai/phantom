import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** The bridge owns branch creation, protected-path checks, commits and PRs.
 * Its interface is publish.sh JOB, with JOB.base in the bridge runs directory.
 * Never fall back to gh, git push, or a package-release script.
 */
export function publishFix({ root, plan, publisher, job, runsDir }, run = spawnSync) {
  if (plan.unresolved.length) throw new Error('Manual corrections required before publishing');
  if (!plan.changes.length) return { status: 'no-changes' };
  if (!publisher || !isAbsolute(publisher) || !runsDir || !isAbsolute(runsDir) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(job ?? '')) {
    throw new Error('Explicit publisher, bridge runs directory and job are required');
  }
  const stat = lstatSync(publisher);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022)) throw new Error('Unsafe publisher');
  root = realpathSync(root);
  const record = resolve(runsDir, `${job}.base`);
  if (!lstatSync(record).isFile() || lstatSync(record).isSymbolicLink()) throw new Error('Invalid bridge base record');
  const fields = readFileSync(record, 'utf8').trim().split(/\s+/);
  const [base, branch, worktree] = fields;
  if (fields.length !== 4 || !/^[a-f0-9]{40,64}$/.test(base) || branch !== `codex-bridge/${job}` || realpathSync(worktree) !== root) {
    throw new Error('Bridge job does not bind this fix worktree');
  }
  const git = args => {
    const result = run('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
    if (result.status !== 0 || result.error) throw new Error('Git preflight failed');
    return result.stdout.trim();
  };
  if (git(['symbolic-ref', '--short', 'HEAD']) !== branch || git(['rev-parse', 'HEAD']) !== base ||
    git(['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude)BRIDGE_NOTES.md'])) throw new Error('Fix requires a clean bridge worktree at its base');
  // Validate the whole patch before the first write. Recompute plans in the
  // same invocation; a supplied JSON file is never executable authority.
  for (const change of plan.changes) {
    if (!['README.md', 'docs/QUICKSTART.md'].includes(change.file)) throw new Error('Unfixable path');
    const path = resolve(root, change.file);
    if (realpathSync(path) !== path || !lstatSync(path).isFile() || readFileSync(path, 'utf8') !== change.before) throw new Error('Fix source changed');
  }
  for (const change of plan.changes) writeFileSync(resolve(root, change.file), change.after);
  const result = run('bash', [publisher, job], {
    cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, BRIDGE_RUNS_DIR: runsDir },
    // The publisher logs in its private runs directory. Never echo output:
    // subprocess errors can contain URLs with credentials or shell context.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status === 0 && !result.error ? 'publisher-completed' : 'publisher-failed',
    job, branch, exitCode: result.status ?? null, files: plan.changes.map(c => c.file) };
}
