#!/usr/bin/env node
// Compare the complete worktree (including untracked files) to a reviewed path list.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

try {
  const [base, manifest] = process.argv.slice(2);
  if (!base || !manifest || process.argv.length !== 4) throw new Error('usage: node scripts/verify-recut-paths.mjs <base-commit> <paths.json>');
  const paths = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!Array.isArray(paths) || paths.some(p => typeof p !== 'string' || !p || p.startsWith('/') || p.split('/').includes('..'))) throw new Error('manifest must be an array of repository-relative paths');
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean);
  // Disable rename detection so both the old and new names require review.
  const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], { encoding: 'utf8' }).trim();
  const changed = new Set([...git('diff', '--no-renames', '--name-only', '-z', commit, '--'), ...git('diff', '--cached', '--no-renames', '--name-only', '-z', commit, '--'), ...git('ls-files', '--others', '--exclude-standard', '-z')]);
  const allowed = new Set(paths);
  const extra = [...changed].filter(p => !allowed.has(p)).sort();
  if (extra.length) throw new Error(`unplanned paths: ${JSON.stringify(extra)}`);
  process.stdout.write(`Recut paths verified: ${changed.size} changed path(s)\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
