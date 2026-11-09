/**
 * One-entry guardian verification manifest built from an observed remote head.
 *
 * `fleet guardian-verify --head-of <repo> [--branch <name>]` resolves
 * `refs/remotes/origin/<branch>` (or the `origin/HEAD` symref when `--branch`
 * is omitted) inside an existing repository, reads that head commit and its
 * first parent through local `execFile` git reads only — never a fetch — and
 * writes a single `guardian-<sha12>` manifest entry whose `mergeCommit`/
 * `candidateHead` are the observed head and `baseHead` its first parent. The
 * manifest is a private, atomically renamed scratch file under the OS temp
 * directory; the caller unlinks it through `dispose` after the verification
 * pipeline settles.
 *
 * This module grants no merge, rollback, deployment or routing authority; it
 * only prepares input for the observation-only verification loop.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { DetachedPostMergeRunnerInput } from './detached-post-merge-runner.js';

const GIT_TIMEOUT_MS = 15_000;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const MAX_REPO_PATH = 4_096;
const MAX_BRANCH_BYTES = 1_024;

function noControls(value: string): boolean {
  return [...value].every((char) => {
    const code = char.codePointAt(0)!;
    return code >= 32 && code !== 127;
  });
}

/** A refused `--head-of`/`--branch` input: bad shape, missing ref or non-repo. */
export class GuardianHeadError extends Error {}

/** Strip git env that could redirect reads; keep the process otherwise intact. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_CONFIG_COUNT',
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_SYSTEM', 'GIT_DIR',
    'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY', 'GIT_WORK_TREE',
  ]) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.LC_ALL = 'C';
  return env;
}

function git(repo: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
      env: gitEnv(),
    }, (error, stdout) => error ? reject(error) : resolvePromise(String(stdout).trim()));
  });
}

/** What `git check-ref-format --branch` accepts, without spawning it. */
function validBranchName(value: string): boolean {
  const forbidden = '~^:?*[\\';
  if (!value || value === '@' || Buffer.byteLength(value, 'utf8') > MAX_BRANCH_BYTES ||
    [...value].some((char) => {
      const code = char.codePointAt(0)!;
      return code <= 32 || code === 127 || forbidden.includes(char);
    }) || value.includes('..') || value.includes('@{') || value.startsWith('/') ||
    value.endsWith('/') || value.endsWith('.')) return false;
  return value.split('/').every((part) => Boolean(part) && !part.startsWith('.') && !part.endsWith('.lock'));
}

async function repoRoot(repo: string): Promise<string> {
  if (typeof repo !== 'string' || !isAbsolute(repo) || repo.length > MAX_REPO_PATH || !noControls(repo)) {
    throw new GuardianHeadError('--head-of requires an absolute repository path');
  }
  const root = resolve(repo);
  let top: string | null = null;
  try {
    top = await git(root, ['rev-parse', '--path-format=absolute', '--show-toplevel']);
    if (realpathSync.native(top) !== realpathSync.native(root)) top = null;
  } catch {
    top = null;
  }
  if (top === null) throw new GuardianHeadError(`--head-of is not a git repository root: ${root}`);
  return realpathSync.native(top);
}

async function defaultBranch(root: string): Promise<string> {
  let symref = '';
  try {
    symref = await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  } catch { /* resolved below */ }
  const branch = symref.startsWith('origin/') ? symref.slice('origin/'.length) : '';
  if (!validBranchName(branch)) {
    throw new GuardianHeadError('cannot determine the origin default branch: pass --branch <name>');
  }
  return branch;
}

/**
 * Resolve `origin/<branch>` head and first parent into a single
 * verification-loop manifest entry. Local reads only; never fetches.
 */
export async function buildGuardianHeadEntry(repo: string, branch?: string): Promise<DetachedPostMergeRunnerInput> {
  const root = await repoRoot(repo);
  const name = branch === undefined ? await defaultBranch(root) : branch;
  if (!validBranchName(name)) throw new GuardianHeadError('invalid --branch: not a valid git branch name');
  let head = '';
  try {
    head = await git(root, ['rev-parse', '--verify', `refs/remotes/origin/${name}^{commit}`]);
  } catch { /* reported below */ }
  if (!SHA.test(head)) throw new GuardianHeadError(`origin/${name} does not resolve to a commit`);
  let fields: string[] = [];
  try {
    fields = (await git(root, ['rev-list', '--parents', '-n', '1', head])).split(/\s+/).filter(Boolean);
  } catch { /* reported below */ }
  const parent = fields[0] === head && SHA.test(fields[1] ?? '') ? fields[1]! : '';
  if (!parent) throw new GuardianHeadError(`origin/${name} head has no first parent`);
  const id = `guardian-${head.slice(0, 12)}`;
  return {
    repo: root,
    cohortId: id,
    proposalId: id,
    baseBranch: name,
    baseHead: parent,
    candidateHead: head,
    mergeCommit: head,
  };
}

export interface GuardianHeadManifest {
  /** Absolute path of the written one-entry manifest; valid until `dispose`. */
  manifest: string;
  /** Remove the manifest file; idempotent and safe after the pipeline settles. */
  dispose: () => Promise<void>;
}

/**
 * Write the one-entry manifest atomically (`O_EXCL` temp file, mode `0o600`,
 * rename) under `os.tmpdir()` and hand back its path plus a `dispose` that
 * unlinks it. The caller keeps the file alive for the whole verification
 * pipeline — including the exclusive lock and any retry drain — then disposes.
 */
export async function writeGuardianHeadManifest(repo: string, branch?: string): Promise<GuardianHeadManifest> {
  const entry = await buildGuardianHeadEntry(repo, branch);
  const manifest = join(tmpdir(), `ashlr-guardian-head-${randomUUID()}.json`);
  const temp = `${manifest}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify([entry]), { mode: 0o600, flag: 'wx' });
    await rename(temp, manifest);
  } finally {
    await unlink(temp).catch(() => {});
  }
  return { manifest, dispose: () => unlink(manifest).catch(() => {}) };
}
