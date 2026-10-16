#!/usr/bin/env node
/* global process, console */
// Only a PR modifying these existing, regular ecosystem files can skip the
// exhaustive matrix. Unknown Git state fails the classifier instead of
// producing a site qualification.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SITE_ONLY_PATHS = Object.freeze([
  'site/ecosystem.html',
  'site/assets/ecosystem.js',
  'site/assets/star-history.js',
  'site/sitemap.xml',
]);
const allowed = new Set(SITE_ONLY_PATHS);

// A PR whose every changed path matches one of these cannot change macOS
// behaviour, so the Mac jobs may be skipped. Linux and Windows still run in
// full. Anything unmatched (src, test, native, package files, workflows,
// scripts, CODEOWNERS) keeps the Mac jobs.
export const MAC_SKIP_PATH_PATTERNS = Object.freeze([
  /^docs\/.+\.(md|png|jpg|jpeg|svg|gif)$/,
  /^[A-Za-z0-9_.-]+\.md$/,
  /^site\/.+\.(html|css|js|svg|png|jpg|jpeg|ico|xml|txt|json)$/,
  /^\.github\/ISSUE_TEMPLATE\/[A-Za-z0-9_.-]+\.md$/,
  /^\.github\/PULL_REQUEST_TEMPLATE\.md$/,
]);
const shaPattern = /^[0-9a-f]{40}$/;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
}

function regularBlobAt(cwd, ref, path) {
  const tree = git(cwd, ['ls-tree', '-z', ref, '--', path]).toString('utf8');
  const entry = /^([0-7]{6}) blob [0-9a-f]+\t([^\0]+)\0$/.exec(tree);
  return entry?.[1] === '100644' && entry[2] === path;
}

function changedPaths({ base, head, cwd }) {
  if (!shaPattern.test(base ?? '') || !shaPattern.test(head ?? '')) {
    throw new Error('PR base and head must be exact commit SHAs');
  }
  const checkedOut = git(cwd, ['rev-parse', 'HEAD']).toString('utf8').trim();
  if (checkedOut !== head) throw new Error('checkout does not match PR head');
  const mergeBase = git(cwd, ['merge-base', base, head]).toString('utf8').trim();
  if (!shaPattern.test(mergeBase)) throw new Error('PR merge base is unavailable');
  const changed = git(cwd, [
    'diff', '--name-only', '-z', '--no-renames', mergeBase, head,
  ]).toString('utf8');
  if (!changed) return { mergeBase, paths: [] };
  if (!changed.endsWith('\0')) throw new Error('Git returned an incomplete path list');
  return { mergeBase, paths: changed.slice(0, -1).split('\0') };
}

export function classifySiteLane({ eventName, base, head, cwd }) {
  // Default-branch pushes and reusable release calls always qualify fully.
  if (eventName !== 'pull_request') return 'full';
  const { mergeBase, paths } = changedPaths({ base, head, cwd });
  if (paths.length === 0) return 'full';
  if (paths.some((path) => !allowed.has(path))) return 'full';
  if (paths.some((path) => !regularBlobAt(cwd, mergeBase, path) ||
      !regularBlobAt(cwd, head, path))) return 'full';
  return 'site';
}

// 'skip' only for a pull request that exclusively changes docs or site files
// and never deletes, renames to, or changes the mode of a path (a deletion of
// a docs file is fine; a mode or symlink change is not). Everything else, and
// every non-PR event, is 'run'.
export function classifyMacLane({ eventName, base, head, cwd }) {
  if (eventName !== 'pull_request') return 'run';
  const { mergeBase, paths } = changedPaths({ base, head, cwd });
  if (paths.length === 0) return 'run';
  if (!paths.every((path) => MAC_SKIP_PATH_PATTERNS.some((re) => re.test(path)))) return 'run';
  for (const path of paths) {
    for (const ref of [mergeBase, head]) {
      const tree = git(cwd, ['ls-tree', '-z', ref, '--', path]).toString('utf8');
      if (tree && !regularBlobAt(cwd, ref, path)) return 'run';
    }
  }
  return 'skip';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const lane = classifySiteLane({
      eventName: process.env.GITHUB_EVENT_NAME,
      base: process.env.ASHLR_CI_BASE_SHA,
      head: process.env.ASHLR_CI_HEAD_SHA,
      cwd: process.cwd(),
    });
    const mac = classifyMacLane({
      eventName: process.env.GITHUB_EVENT_NAME,
      base: process.env.ASHLR_CI_BASE_SHA,
      head: process.env.ASHLR_CI_HEAD_SHA,
      cwd: process.cwd(),
    });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'lane=' + lane + '\nmac=' + mac + '\n');
    console.log('CI lane: ' + lane + ', mac: ' + mac);
  } catch (error) {
    console.error('CI lane classification failed: ' + error.message);
    process.exitCode = 1;
  }
}
