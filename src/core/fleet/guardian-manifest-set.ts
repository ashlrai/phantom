/**
 * Multi-repo guardian manifest feed.
 *
 * Companion to guardian-manifest.ts: where that verb feeds one repo branch's
 * newest first-parent commits into a manifest, this folds 1..20 repo+branch
 * specs (decoded from a caller-supplied JSON file) into a single bounded
 * manifest the same `guardian-verify` loop accepts. Merge binding, ordering
 * and the atomic write stay entirely in the existing helpers. Observation-only:
 * it reads `git log`, writes one JSON file, and grants no merge, deploy or
 * routing authority.
 */

import { isAbsolute, resolve } from 'node:path';
import {
  guardianManifestEntries,
  readFirstParentCommits,
  writeGuardianManifest,
  type GuardianManifestEntry,
} from './guardian-manifest.js';

export const GUARDIAN_MANIFEST_SET_MAX_REPOS = 20;
export const GUARDIAN_MANIFEST_SET_MAX_ENTRIES = 100;
export const GUARDIAN_MANIFEST_SET_DEFAULT_BRANCH = 'master';
export const GUARDIAN_MANIFEST_SET_DEFAULT_LIMIT = 5;

/** A validated spec: repo is resolved to an absolute path, branch defaulted. */
export interface GuardianManifestSetSpec {
  repo: string;
  branch: string;
}

// eslint-disable-next-line no-control-regex -- repo strings must not contain control bytes
const REPO_CONTROL_RE = /[\x00-\x1f\x7f]/;
// eslint-disable-next-line no-control-regex -- branch names must not contain control bytes
const BRANCH_BAD_RE = /[\s\x00-\x1f\x7f]/;

function validRepo(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && value.length <= 4096 && !REPO_CONTROL_RE.test(value);
}

function validBranch(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 256
    && !value.startsWith('-') && !BRANCH_BAD_RE.test(value);
}

/**
 * Validate the decoded --repos-file JSON: an array of 1..20 objects shaped
 * {repo: absolutePath, branch?: string}, no other keys. Throws on malformed
 * input, invalid repos or branches, and duplicate resolved repo+branch
 * identities (`/a/b` and `/a/b/.` name one repo).
 */
export function parseGuardianManifestSetSpecs(raw: unknown): GuardianManifestSetSpec[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > GUARDIAN_MANIFEST_SET_MAX_REPOS) {
    throw new Error('repos file must be an array of 1 to 20 entries');
  }
  const seen = new Set<string>();
  const specs: GuardianManifestSetSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('repos file entries must be objects');
    }
    const keys = Object.keys(item).sort().join(',');
    if (keys !== 'repo' && keys !== 'branch,repo') {
      throw new Error('repos file entries take repo and optional branch only');
    }
    const { repo, branch = GUARDIAN_MANIFEST_SET_DEFAULT_BRANCH } = item as { repo: unknown; branch?: unknown };
    if (!validRepo(repo)) throw new Error('repos file repo must be an absolute path');
    if (!validBranch(branch)) throw new Error('repos file branch is invalid');
    const resolved = resolve(repo);
    const identity = `${resolved}${branch}`;
    if (seen.has(identity)) throw new Error('duplicate repository and branch in repos file');
    seen.add(identity);
    specs.push({ repo: resolved, branch });
  }
  return specs;
}

export interface GuardianManifestSetOptions {
  specs: ReadonlyArray<GuardianManifestSetSpec>;
  limitPerRepo: number;
  out: string;
}

export interface GuardianManifestSetDeps {
  read?: typeof readFirstParentCommits;
  write?: typeof writeGuardianManifest;
}

export interface GuardianManifestSetSummary {
  written: number;
  out: string;
  repos: { repo: string; branch: string; entries: number }[];
  entries: GuardianManifestEntry[];
}

/**
 * Build one bounded manifest across several repos. The configured entry
 * budget (spec count x limitPerRepo) is validated before any git read; specs
 * are then read sequentially in input order, each repo's entries stay
 * oldest-first, and the whole operation fails — with nothing written — when a
 * repo cannot be read or yields no eligible entries. One atomic write at the
 * end keeps any pre-existing output intact on failure.
 */
export async function runGuardianManifestSet(
  options: GuardianManifestSetOptions,
  deps: GuardianManifestSetDeps = {},
): Promise<GuardianManifestSetSummary> {
  const { read = readFirstParentCommits, write = writeGuardianManifest } = deps;
  const { specs, limitPerRepo, out } = options;
  if (specs.length < 1 || specs.length > GUARDIAN_MANIFEST_SET_MAX_REPOS
    || !Number.isSafeInteger(limitPerRepo) || limitPerRepo < 1
    || limitPerRepo > GUARDIAN_MANIFEST_SET_MAX_ENTRIES
    || specs.length * limitPerRepo > GUARDIAN_MANIFEST_SET_MAX_ENTRIES
    || !isAbsolute(out)) {
    throw new Error('invalid guardian-manifest-set input');
  }
  const entries: GuardianManifestEntry[] = [];
  const repos: GuardianManifestSetSummary['repos'] = [];
  // The verify reader refuses a repeated repo+mergeCommit identity; a repo
  // listed under two branches can produce the same merge twice, so first
  // occurrence wins across the whole set.
  const bound = new Set<string>();
  for (const spec of specs) {
    const commits = await read(spec.repo, spec.branch, limitPerRepo);
    const mine = guardianManifestEntries(commits, { repo: spec.repo, branch: spec.branch });
    let kept = 0;
    for (const entry of mine) {
      const identity = `${entry.repo}${entry.mergeCommit}`;
      if (bound.has(identity)) continue;
      bound.add(identity);
      entries.push(entry);
      kept++;
    }
    if (kept === 0) throw new Error('repository produced no eligible entries');
    repos.push({ repo: spec.repo, branch: spec.branch, entries: kept });
  }
  await write(out, entries);
  return { written: entries.length, out, repos, entries };
}
