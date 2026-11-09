#!/usr/bin/env node

// Read-only preflight: node scripts/check-publish.mjs --base <ref> --body <file>
//   --held-path <repo-relative path> [--held-path <path> ...]
// Held paths are supplied by the caller; use --no-held-paths to explicitly
// declare that none apply. The body file must be the exact proposed PR body.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'Usage: node scripts/check-publish.mjs --base <ref> --body <file> (--held-path <path> ... | --no-held-paths)';
const lockfiles = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Cargo.lock', 'Pipfile.lock', 'poetry.lock', 'uv.lock', 'Gemfile.lock', 'composer.lock', 'go.sum', 'Package.resolved', 'deno.lock']);

export function checkPublish(paths, body, heldPaths) {
  const reasons = [];
  for (const path of [...new Set(paths)].sort()) {
    if (path === '.github' || path.startsWith('.github/')) reasons.push(`Changed .github path: ${JSON.stringify(path)}`);
    if (lockfiles.has(basename(path)) && heldPaths.some((held) => held === '.' || path === held || path.startsWith(`${held}/`))) {
      reasons.push(`Lockfile in held path: ${JSON.stringify(path)}`);
    }
  }
  if (body.includes('\u2014')) reasons.push('PR body contains an em dash');
  return reasons;
}

export function main(args, cwd = process.cwd()) {
  try {
    let base;
    let bodyFile;
    const heldPaths = [];
    let noHeldPaths = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--no-held-paths' && !noHeldPaths) { noHeldPaths = true; continue; }
      if (!['--base', '--body', '--held-path'].includes(arg) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(usage);
      const value = args[++i];
      if (arg === '--base' && !base) base = value;
      else if (arg === '--body' && !bodyFile) bodyFile = value;
      else if (arg === '--held-path') {
        if (value.startsWith('/') || value.includes('\\') || value.split('/').includes('..') || value === '') throw new Error('Held paths must be repository-relative paths');
        heldPaths.push(posix.normalize(value).replace(/\/$/, '') || '.');
      } else throw new Error(usage);
    }
    if (!base || !bodyFile || (noHeldPaths === (heldPaths.length > 0))) throw new Error(usage);
    const git = (...argv) => execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const baseCommit = git('rev-parse', '--verify', '--end-of-options', `${base}^{commit}`).trim();
    const mergeBase = git('merge-base', baseCommit, 'HEAD').trim();
    const split = (output) => output.split('\0').filter(Boolean);
    // Include committed, staged, unstaged and untracked paths. Disable rename
    // detection so both sides of a rename are checked.
    const paths = [
      ...split(git('diff', '--no-renames', '--name-only', '-z', mergeBase, 'HEAD', '--')),
      ...split(git('diff', '--cached', '--no-renames', '--name-only', '-z', 'HEAD', '--')),
      ...split(git('diff', '--no-renames', '--name-only', '-z', '--')),
      ...split(git('ls-files', '--others', '--exclude-standard', '-z')),
    ];
    const reasons = checkPublish(paths, readFileSync(bodyFile, 'utf8'), heldPaths);
    if (reasons.length) {
      for (const reason of reasons) console.error(`Refused: ${reason}`);
      return 1;
    }
    console.log('Publish preflight passed.');
    return 0;
  } catch (error) {
    // Git stderr may contain sensitive URLs or configuration; do not echo it.
    console.error(`Publish preflight failed: ${error.status !== undefined ? 'Git command failed; check the base and repository' : error.message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
