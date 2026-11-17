#!/usr/bin/env node
// Merge-base path list with no imports outside .github/scripts.
// The hash jobs load this from a sparse checkout that has only .github.
import { execFileSync } from 'node:child_process';

const sha = /^[0-9a-f]{40}$/;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
}

export function changedPaths({ base, head, cwd }) {
  if (!sha.test(base ?? '') || !sha.test(head ?? '')) throw new Error('base and head must be exact commit SHAs');
  if (git(cwd, ['rev-parse', 'HEAD']).trim() !== head) throw new Error('checkout does not match head');
  const mergeBase = git(cwd, ['merge-base', base, head]).trim();
  const out = git(cwd, ['diff', '--name-only', '-z', '--no-renames', mergeBase, head]);
  if (out && !out.endsWith('\0')) throw new Error('incomplete path list');
  return out ? out.slice(0, -1).split('\0') : [];
}
