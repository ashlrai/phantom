#!/usr/bin/env node
/* global process, console */
// Release version provenance (pull_request only, read-only).
//
// release-please owns version bumps: its PR merge leaves the
// `chore(<scope>): release X.Y.Z` commit that the release train admits
// (src/core/release/train.ts isReleasePleaseCommit). A version bump that lands
// through any other PR still gets a tag and draft from auto-tag, but the train
// refuses it as release_message_mismatch and it waits as an orphan draft until
// the next release-please tag supersedes it. That happened twice: #4098
// (3.30.25) and #4735 (3.30.32), both hand-cut by RQ-UPKEEP-REL bridge jobs.
// This check stops the bump at review time instead.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
export const RELEASE_PLEASE_BRANCH = 'release-please--';
export const CANONICAL_REPOSITORY = 'ashlrai/phantom';

/** Read the release version carriers that release-please owns. */
export function versionCarriers(packageJson, manifestJson) {
  const pkg = packageJson === null ? null : JSON.parse(packageJson);
  const manifest = manifestJson === null ? null : JSON.parse(manifestJson);
  return { version: typeof pkg?.version === 'string' ? pkg.version : null, manifest: typeof manifest?.['.'] === 'string' ? manifest['.'] : null };
}

/**
 * Decide whether a PR may change the release version.
 * Unchanged carriers always pass. A change passes only from a same-repository
 * `release-please--*` branch, the branch the train also requires.
 */
export function judgeVersionProvenance({ base, head, headRef, headRepository }) {
  const changed = [];
  if (base.version !== head.version) changed.push(`package.json version ${base.version ?? 'missing'} -> ${head.version ?? 'missing'}`);
  if (base.manifest !== head.manifest) changed.push(`.release-please-manifest.json "." ${base.manifest ?? 'missing'} -> ${head.manifest ?? 'missing'}`);
  if (changed.length === 0) return { ok: true, reason: 'version-unchanged', changed };
  if (typeof headRef === 'string' && headRef.startsWith(RELEASE_PLEASE_BRANCH) && headRepository === CANONICAL_REPOSITORY) {
    return { ok: true, reason: 'release-please-pr', changed };
  }
  return { ok: false, reason: 'version-bump-outside-release-please', changed };
}

function show(cwd, rev, path) {
  try {
    return execFileSync('git', ['show', `${rev}:${path}`], { cwd, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
  } catch {
    return null;
  }
}

/** Compare the merge base with the PR head in a full-history checkout. */
export function checkPullRequest({ base, head, headRef, headRepository, cwd }) {
  if (!SHA.test(base ?? '') || !SHA.test(head ?? '')) throw new Error('base and head must be exact commit SHAs');
  const mergeBase = execFileSync('git', ['merge-base', base, head], { cwd }).toString('utf8').trim();
  if (!SHA.test(mergeBase)) throw new Error('merge base unavailable');
  const carriers = (rev) => versionCarriers(show(cwd, rev, 'package.json'), show(cwd, rev, '.release-please-manifest.json'));
  return judgeVersionProvenance({ base: carriers(mergeBase), head: carriers(head), headRef, headRepository });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const verdict = checkPullRequest({
      base: process.env.BASE_SHA, head: process.env.HEAD_SHA,
      headRef: process.env.HEAD_REF, headRepository: process.env.HEAD_REPOSITORY, cwd: process.cwd(),
    });
    if (verdict.ok) {
      console.log(`release version provenance: ${verdict.reason}`);
    } else {
      console.error(`::error::${verdict.changed.join('; ')}. Only the release-please PR may change the release version; `
        + 'the release train refuses any other tag (release_message_mismatch) and leaves it an orphan draft. '
        + 'Drop the version bump and keep release notes under the changelog Unreleased section. See docs/RELEASING.md.');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`release version provenance check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
