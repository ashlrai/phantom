#!/usr/bin/env node
/* global process, console */
// Make merge-base(base, head) resolvable in a shallow checkout.
// Deepen first. Unshallow is the last resort. Exit 1 if the range is still
// missing so a secret scan cannot shrink to a shorter diff.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function mergeBase(cwd, base, head, git = runGit) {
  try {
    const out = git(cwd, ['merge-base', base, head]);
    return SHA.test(out) ? out : null;
  } catch {
    return null;
  }
}

export function parentExists(cwd, head, git = runGit) {
  try {
    const out = git(cwd, ['rev-parse', '--verify', `${head}^1`]);
    return SHA.test(out);
  } catch {
    return false;
  }
}

/**
 * @param {{ cwd?: string, base?: string, head: string, baseRef?: string, git?: typeof runGit }} input
 * base may be empty on push and schedule events; then only HEAD^1 is required.
 */
export function ensureRange({ cwd = process.cwd(), base = '', head, baseRef = '', git = runGit }) {
  if (!SHA.test(head)) throw new Error('head must be an exact commit SHA');
  const wantBase = SHA.test(base);
  if (wantBase && mergeBase(cwd, base, head, git)) return { deepened: 0, unshallowed: false };
  if (!wantBase && parentExists(cwd, head, git)) return { deepened: 0, unshallowed: false };
  const stripped = String(baseRef).replace(/^refs\/heads\//, '');
  const ref = stripped && !stripped.includes('..') && !stripped.startsWith('-') && !stripped.includes(' ') ? stripped : '';
  let deepened = 0;
  const fetchBase = () => {
    if (ref) git(cwd, ['fetch', '--no-tags', '--filter=blob:none', '--depth=100', 'origin', ref]);
    else if (wantBase) git(cwd, ['fetch', '--no-tags', '--filter=blob:none', '--depth=100', 'origin', base]);
  };
  try { fetchBase(); } catch { /* a later deepen or unshallow still has to find the range */ }
  for (const step of [50, 100, 200]) {
    if (wantBase ? mergeBase(cwd, base, head, git) : parentExists(cwd, head, git)) return { deepened, unshallowed: false };
    git(cwd, ['fetch', '--no-tags', '--filter=blob:none', `--deepen=${step}`, 'origin']);
    deepened += step;
  }
  if (wantBase ? mergeBase(cwd, base, head, git) : parentExists(cwd, head, git)) return { deepened, unshallowed: false };
  git(cwd, ['fetch', '--no-tags', '--filter=blob:none', '--unshallow', 'origin']);
  if (wantBase ? !mergeBase(cwd, base, head, git) : !parentExists(cwd, head, git)) {
    throw new Error('commit range unavailable after unshallow');
  }
  return { deepened, unshallowed: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = ensureRange({
      base: process.env.BASE_SHA ?? '',
      head: process.env.HEAD_SHA ?? process.env.GITHUB_SHA ?? '',
      baseRef: process.env.BASE_REF ?? '',
    });
    console.log(`fetch range ready (deepened ${result.deepened}${result.unshallowed ? ', unshallowed' : ''})`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
