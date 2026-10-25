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

// A PR whose every changed path is Markdown (anywhere) or lives under docs/
// cannot change runtime behaviour on any OS, so it takes the docs lane:
// documentation checks plus the tests that read Markdown, on Ubuntu only.
// Anything else (src, test, scripts, workflows, package files, CODEOWNERS,
// .github config) keeps the full Ubuntu, Windows and Mac matrix.
export const DOCS_ONLY_PATH_PATTERNS = Object.freeze([
  /^docs\/[^\0]+$/,
  /^(?:[^/\0]+\/)*[^/\0]+\.md$/,
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

export function classifySiteLane({ eventName, base, head, cwd }) {
  // Default-branch pushes and reusable release calls always qualify fully.
  if (eventName !== 'pull_request') return 'full';
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
  if (!changed) return 'full';
  if (!changed.endsWith('\0')) throw new Error('Git returned an incomplete path list');
  const paths = changed.slice(0, -1).split('\0');
  if (paths.some((path) => !allowed.has(path))) return 'full';
  if (paths.some((path) => !regularBlobAt(cwd, mergeBase, path) ||
      !regularBlobAt(cwd, head, path))) return 'full';
  return 'site';
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

export function isDocsOnlyPath(path) {
  // Markdown under code, test, or config trees can be a fixture or template.
  if (/^(?:\.github|src|test|tests|scripts|native|packages|bin)\//.test(path)) return false;
  return DOCS_ONLY_PATH_PATTERNS.some((re) => re.test(path));
}

// 'docs' only for a pull request that exclusively changes docs-only paths,
// each of which is absent or a regular non-executable file at both ends (so a
// mode change, symlink, or submodule keeps full CI). Everything else, and every
// non-PR event (master pushes, merge queue, schedule, reusable calls), is 'full'.
export function classifyDocsLane({ eventName, base, head, cwd }) {
  if (eventName !== 'pull_request') return 'full';
  const { mergeBase, paths } = changedPaths({ base, head, cwd });
  if (paths.length === 0) return 'full';
  if (!paths.every(isDocsOnlyPath)) return 'full';
  for (const path of paths) {
    for (const ref of [mergeBase, head]) {
      const tree = git(cwd, ['ls-tree', '-z', ref, '--', path]).toString('utf8');
      if (tree && !regularBlobAt(cwd, ref, path)) return 'full';
    }
  }
  return 'docs';
}

export function classifyLane(input) {
  const site = classifySiteLane(input);
  if (site !== 'full') return site;
  return classifyDocsLane(input);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const lane = classifyLane({
      eventName: process.env.GITHUB_EVENT_NAME,
      base: process.env.ASHLR_CI_BASE_SHA,
      head: process.env.ASHLR_CI_HEAD_SHA,
      cwd: process.cwd(),
    });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'lane=' + lane + '\n');
    console.log('CI lane: ' + lane);
  } catch (error) {
    console.error('CI lane classification failed: ' + error.message);
    process.exitCode = 1;
  }
}
