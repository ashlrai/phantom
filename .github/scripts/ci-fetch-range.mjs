#!/usr/bin/env node
/* global process, console */
// Make merge-base(base, head) resolvable in a shallow checkout.
// Deepen first. Unshallow is the last resort. Exit 1 if the range is still
// missing so a secret scan cannot shrink to a shorter diff.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const ZERO = '0'.repeat(40);

export function usableSha(value) {
  return SHA.test(value ?? '') && value !== ZERO;
}

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
 * Commits in base..head whose parent was not fetched. Membership in
 * .git/shallow is not enough: a deepen can leave a commit listed there
 * after its parent is already present, and unshallowing that range
 * downloads history the diff does not need. A missing parent is a real hole.
 */
export function shallowInRange(cwd, base, head, git = runGit) {
  if (!usableSha(base) || !usableSha(head)) return [];
  let listed;
  try {
    listed = git(cwd, ['rev-list', `${base}..${head}`]);
  } catch {
    return ['unreadable'];
  }
  return listed.split('\n').map((line) => line.trim()).filter((line) => SHA.test(line) && !parentExists(cwd, line, git));
}

/**
 * Push and merge-group bases are exact. An all-zero before is unset.
 * Anything else refuses rather than substituting HEAD~1.
 */
export function resolveScanBase({ event, prBase, mgBase, pushBefore }) {
  if (event === 'pull_request') {
    if (!usableSha(prBase)) throw new Error('pull request base is missing');
    return prBase;
  }
  if (event === 'merge_group') {
    if (!usableSha(mgBase)) throw new Error('merge group base is missing');
    return mgBase;
  }
  if (event === 'push') {
    if (!usableSha(pushBefore)) throw new Error('push before is missing');
    return pushBefore;
  }
  throw new Error('secret scan range is incomplete');
}

function settle(cwd, base, head, git, deepened) {
  if (!usableSha(base)) return { deepened, unshallowed: false };
  if (shallowInRange(cwd, base, head, git).length === 0) return { deepened, unshallowed: false };
  git(cwd, ['fetch', '--no-tags', '--filter=blob:none', '--unshallow', 'origin']);
  if (shallowInRange(cwd, base, head, git).length) throw new Error('commit range still shallow after unshallow');
  return { deepened, unshallowed: true };
}

/**
 * @param {{ cwd?: string, base?: string, head: string, baseRef?: string, git?: typeof runGit }} input
 * An all-zero or empty base only requires HEAD^1. A real base must be a
 * complete base..head range: shallow commits inside it are unshallowed or fail.
 */
export function ensureRange({ cwd = process.cwd(), base = '', head, baseRef = '', git = runGit }) {
  if (!usableSha(head)) throw new Error('head must be an exact commit SHA');
  const wantBase = usableSha(base);
  const ready = () => (wantBase ? mergeBase(cwd, base, head, git) : parentExists(cwd, head, git));
  if (ready()) return settle(cwd, base, head, git, 0);
  let deepened = 0;
  const deepen = (step) => {
    git(cwd, ['fetch', '--no-tags', '--filter=blob:none', `--deepen=${step}`, 'origin']);
    deepened += step;
  };
  // A pull request is usually a short stack on the already checked-out
  // candidate. Deepen that stack before downloading the base ref window.
  for (const step of [20, 40]) {
    try { deepen(step); } catch { /* the wider fetch below still has to run */ }
    if (ready()) return settle(cwd, base, head, git, deepened);
  }
  const stripped = String(baseRef).replace(/^refs\/heads\//, '');
  const ref = stripped && !stripped.includes('..') && !stripped.startsWith('-') && !stripped.includes(' ') ? stripped : '';
  const fetchBase = () => {
    if (ref) git(cwd, ['fetch', '--no-tags', '--filter=blob:none', '--depth=100', 'origin', ref]);
    else if (wantBase) git(cwd, ['fetch', '--no-tags', '--filter=blob:none', '--depth=100', 'origin', base]);
  };
  try { fetchBase(); } catch { /* a later deepen or unshallow still has to find the range */ }
  for (const step of [50, 100, 200]) {
    if (ready()) return settle(cwd, base, head, git, deepened);
    git(cwd, ['fetch', '--no-tags', '--filter=blob:none', `--deepen=${step}`, 'origin']);
    deepened += step;
  }
  if (ready()) return settle(cwd, base, head, git, deepened);
  git(cwd, ['fetch', '--no-tags', '--filter=blob:none', '--unshallow', 'origin']);
  if (!ready()) throw new Error('commit range unavailable after unshallow');
  return settle(cwd, base, head, git, deepened);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv[2] === 'scan-base') {
      const base = resolveScanBase({
        event: process.env.EVENT_NAME,
        prBase: process.env.PR_BASE,
        mgBase: process.env.MG_BASE,
        pushBefore: process.env.PUSH_BEFORE,
      });
      process.stdout.write(`${base}\n`);
      process.exit(0);
    }
    const rawBase = process.env.BASE_SHA ?? '';
    const result = ensureRange({
      base: usableSha(rawBase) ? rawBase : '',
      head: process.env.HEAD_SHA ?? process.env.GITHUB_SHA ?? '',
      baseRef: process.env.BASE_REF ?? '',
    });
    console.log(`fetch range ready (deepened ${result.deepened}${result.unshallowed ? ', unshallowed' : ''})`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
