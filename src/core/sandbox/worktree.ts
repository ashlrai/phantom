/**
 * worktree.ts — isolated git-worktree sandbox (M21 SAFETY FOUNDATION).
 *
 * Creates an ISOLATED git worktree of a source repo on a NEW scratch branch
 * under ~/.ashlr/sandboxes/<id>/, so autonomous edits NEVER touch the user's
 * working tree, index, HEAD, or their checked-out branch. The worktree is
 * created, used, then discarded (git worktree remove + scratch-branch delete).
 *
 * ISOLATION + DESTRUCTIVE-SAFETY (the whole point):
 *  - Sandbox worktrees live ONLY under ~/.ashlr/sandboxes/.
 *  - Creating/removing them MUST NOT modify the source repo's working tree,
 *    index, HEAD, or the user's branches.
 *  - `git worktree add -b <branch> <path> <baseHead>` off the current HEAD;
 *    `git worktree remove --force` + `git branch -D` on cleanup.
 *  - NEVER `git reset --hard` / `git checkout` in the source repo. NEVER push.
 *    NEVER delete user branches. NEVER touch a repo that is not ENROLLED
 *    (except via the explicit allowAnyRepo test hatch on a tmp repo).
 *  - Every mutating op (and every refused/errored attempt) is audited.
 *  - All git invoked via node:child_process arg ARRAYS (execFile, no shell).
 *  - No new runtime deps; node builtins only.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, join, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type {
  Sandbox,
  SandboxCleanupEvidence,
  SandboxCleanupFailureClass,
  SandboxCleanupPostcondition,
  SandboxCleanupResult,
  SandboxDiff,
  SandboxInventory,
  SandboxSweepResult,
} from '../types.js';
import { isRepo } from '../git.js';
import {
  assertMayMutate,
  canonicalEnrollmentPath,
  canonicalFilesystemPathIdentity,
  killSwitchOn,
} from './policy.js';
import {
  acquireRepoLease,
  registerExecutionLease,
  type ExecutionLease,
  type RepoLease,
} from './execution-leases.js';
import { audit } from './audit.js';
import {
  acquireOutwardMutationFence,
  acquireOutwardMutationFenceAsync,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
  type OutwardMutationFence,
} from './mutation-fence.js';
import { resolveGitExecutable, safeGitConfigArgs, verifyGitTarget } from './safe-git.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GIT_TIMEOUT = 30_000; // ms — generous; worktree add can touch many files
const BRANCH_PREFIX = 'ashlr/sandbox/';
const META_FILE = 'sandbox.json';
const CLEANUP_LOCK_WAIT_MS = 2_000;
const CLEANUP_LOCK_INIT_MS = 1_000;
const RESERVATION_RECOVERY_MIN_AGE_MS = 60_000;
const MAX_RESERVATION_RECOVERIES_PER_SWEEP = 16;
const SANDBOX_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const META_TEMP_RE = /^\.sandbox\.json\.\d+\.[a-f0-9]{12}\.tmp$/;
const cleanupLockSleep = new Int32Array(new SharedArrayBuffer(4));

/**
 * Cleanup may borrow authority only from an operation that already crossed the
 * policy gate while holding this exact fence. Supplying an invalid borrowed
 * token fails closed; it never falls back to recursively acquiring the lock.
 */
const sandboxCleanupAuthorityBrand: unique symbol = Symbol('sandbox-cleanup-authority');

export interface BorrowedSandboxCleanupAuthority {
  readonly outwardFence: OutwardMutationFence;
  readonly [sandboxCleanupAuthorityBrand]: true;
}

export interface SandboxCleanupAuthorityOptions {
  borrowedAuthority?: BorrowedSandboxCleanupAuthority | null;
  authorityWaitMs?: number;
}

interface SandboxCleanupAuthorityLease {
  fence: OutwardMutationFence | null;
  token: BorrowedSandboxCleanupAuthority | null;
  borrowed: boolean;
  allowed: boolean;
  reason?: 'authority-unavailable' | 'paused';
}

function mintSandboxCleanupAuthority(
  outwardFence: OutwardMutationFence | null | undefined,
): BorrowedSandboxCleanupAuthority | null {
  if (!outwardFence || !ownsOutwardMutationFence(outwardFence) || killSwitchOn()) return null;
  const authority: BorrowedSandboxCleanupAuthority = {
    outwardFence,
    [sandboxCleanupAuthorityBrand]: true,
  };
  return Object.freeze(authority);
}

/**
 * Borrow cleanup authority from an operation that has crossed its policy gate.
 * Mint immediately after that gate and retain the outward fence until cleanup
 * returns. KILL may be armed later while pause waits on the retained fence.
 */
export function borrowSandboxCleanupAuthority(
  outwardFence: OutwardMutationFence | null | undefined,
): BorrowedSandboxCleanupAuthority | null {
  return mintSandboxCleanupAuthority(outwardFence);
}

function acquireSandboxCleanupAuthority(
  opts?: SandboxCleanupAuthorityOptions,
): SandboxCleanupAuthorityLease {
  const borrowed = opts !== undefined &&
    Object.prototype.hasOwnProperty.call(opts, 'borrowedAuthority');
  if (borrowed) {
    const token = opts?.borrowedAuthority ?? null;
    const fence = token?.outwardFence ?? null;
    const valid = token?.[sandboxCleanupAuthorityBrand] === true && ownsOutwardMutationFence(fence);
    return valid
      ? { fence, token, borrowed: true, allowed: true }
      : { fence, token: null, borrowed: true, allowed: false, reason: 'authority-unavailable' };
  }

  const fence = acquireOutwardMutationFence(opts?.authorityWaitMs);
  if (!ownsOutwardMutationFence(fence)) {
    releaseOutwardMutationFence(fence);
    return { fence: null, token: null, borrowed: false, allowed: false, reason: 'authority-unavailable' };
  }
  // KILL is installed before pause waits on the fence. Rechecking only after
  // acquisition ensures no cleanup can begin after pause reports quiescence.
  if (killSwitchOn()) {
    releaseOutwardMutationFence(fence);
    return { fence: null, token: null, borrowed: false, allowed: false, reason: 'paused' };
  }
  const token = mintSandboxCleanupAuthority(fence);
  if (!token) {
    releaseOutwardMutationFence(fence);
    return { fence: null, token: null, borrowed: false, allowed: false, reason: 'paused' };
  }
  return { fence, token, borrowed: false, allowed: true };
}

function releaseSandboxCleanupAuthority(lease: SandboxCleanupAuthorityLease): void {
  if (!lease.borrowed) releaseOutwardMutationFence(lease.fence);
}

// ---------------------------------------------------------------------------
// H5 — bounded sandbox lifecycle (LOCAL-ONLY resource guards)
// ---------------------------------------------------------------------------

/**
 * H5 CHANGE 4 — hard cap on concurrent on-disk sandboxes. Conservative default:
 * the daemon caps swarm concurrency at 8 (loop.ts) + runner MAX_PARALLEL=8, so
 * 16 leaves ~2x headroom for concurrent daemon swarms + a manual `ashlr swarm`
 * + transient overlap, while still bounding unbounded accumulation. createSandbox
 * sweeps STALE orphans first, then REFUSES (clean audited error) if still over.
 *
 * CONFIGURABLE: an operator (or a deterministic test) may override the default
 * via ASHLR_MAX_SANDBOXES (a positive integer). Resolved at CALL TIME — like the
 * HOME-sensitive path helpers — so a test can set a small cap without restarting
 * the process. An absent/blank/invalid/non-positive value falls back to the
 * conservative default; the override can only ever SET a finite positive bound
 * (it can never disable the cap), keeping this a strictly LOCAL resource guard.
 */
const MAX_SANDBOXES_DEFAULT = 16;

/** Resolve the effective sandbox cap (env override, else conservative default). */
function maxSandboxes(): number {
  const raw = process.env.ASHLR_MAX_SANDBOXES;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number.parseInt(raw, 10);
    // Only a finite, positive integer override takes effect; anything else
    // (NaN, <=0, non-numeric) falls back to the safe default. The override can
    // never remove the bound — it can only set a different finite positive one.
    if (Number.isInteger(n) && n > 0) return n;
  }
  return MAX_SANDBOXES_DEFAULT;
}

/**
 * H5 CHANGE 1 — orphan-sweep staleness threshold (ms). This is the FALLBACK
 * liveness proxy used ONLY for a sandbox that carries no usable `ownerPid`
 * marker (older metadata, or a crash fixture that models a GONE owner). The
 * PRIMARY liveness signal is the positive `ownerPid` marker (see Sandbox.ownerPid
 * + ownerAlive() below): a sandbox whose owner pid is still alive is skipped by
 * the sweep / disk-cap pre-sweep REGARDLESS of age, so a live in-flight worktree
 * is never reclaimed out from under a running swarm — even a cross-process one.
 *
 * Because there is NO hard wall-clock cap on a swarm (the runner bounds a swarm
 * by step count <= 200 and the token budget only — there is no elapsed-time
 * deadline), createdAt-age is NOT by itself a sound liveness proxy. So this
 * threshold is set FAR above any plausible 200-step run (6 hours) as a
 * belt-and-suspenders bound for the only residual gap: the rare pid-reuse case
 * where a crashed swarm's recorded pid was recycled by an unrelated live process
 * (ownerAlive() would then falsely read 'alive', so age must also have elapsed
 * before we'd ever reclaim). The cost of a too-LARGE value (a stale orphan
 * lingering a few hours longer) is far cheaper than the cost of a too-SMALL one
 * (force-removing a live worktree), so we err large. Shared by the daemon-start
 * sweep wiring (loop.ts) and the disk-cap pre-sweep below.
 *
 * CROSS-PROCESS LIVENESS LIMITATION (documented): the only way a live worktree
 * could still be reclaimed is if BOTH (a) its owner process crashed AND (b) the
 * OS recycled its exact pid for a new live process AND (c) >6h elapsed — a
 * vanishingly small window that, even if hit, only reclaims a worktree whose
 * original owner is provably dead.
 */
export const ORPHAN_STALE_MS = 6 * 60 * 60_000;

/**
 * Positive liveness check for a sandbox's recorded owner process. Returns true
 * ONLY when `ownerPid` is a positive integer AND `process.kill(ownerPid, 0)`
 * succeeds (the process exists and is signalable by us) — i.e. a swarm is
 * provably still running and holding this worktree. Any throw (ESRCH = gone,
 * EPERM = exists-but-not-ours, EINVAL, etc.) or an absent/invalid pid returns
 * false, falling back to the conservative createdAt-age staleMs guard. NEVER
 * throws and NEVER sends a real signal (signal 0 is error-check-only).
 */
function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function ownerAlive(sb: Sandbox): boolean {
  // A creation that failed and could not roll back marks its own sandbox
  // abandoned: its owner is alive but will never use or remove it, so the
  // sweeps may reclaim it now instead of after the owner exits.
  if (sb.abandonedAt !== undefined) return false;
  return pidAlive(sb.ownerPid);
}

/** True when metadata carries a well-formed owner pid (liveness is then decidable). */
function hasRecordedOwnerPid(sb: Sandbox): boolean {
  return typeof sb.ownerPid === 'number' && Number.isInteger(sb.ownerPid) && sb.ownerPid > 0;
}

// ---------------------------------------------------------------------------
// Path helpers (re-resolved at call time so tests can relocate HOME)
// ---------------------------------------------------------------------------

/** Absolute path to the sandboxes root: ~/.ashlr/sandboxes. Created lazily. */
export function sandboxesDir(): string {
  return join(homedir(), '.ashlr', 'sandboxes');
}

/** Directory holding one sandbox's worktree + metadata. */
function sandboxHome(id: string): string {
  return join(sandboxesDir(), id);
}

/** Path to a sandbox's persisted metadata file. */
function metaPath(id: string): string {
  return join(sandboxHome(id), META_FILE);
}

/** Path to the isolated worktree checkout for a sandbox. */
function worktreePathFor(id: string): string {
  return join(sandboxHome(id), 'worktree');
}

// ---------------------------------------------------------------------------
// git helper — execFile arg arrays, no shell
// ---------------------------------------------------------------------------

type SandboxGitRunFaultHookForTest = (
  cwd: string,
  args: readonly string[],
) => void;

let sandboxGitRunFaultHookForTest: SandboxGitRunFaultHookForTest | undefined;

export function _setSandboxGitRunFaultHookForTest(
  hook: SandboxGitRunFaultHookForTest | undefined,
): void {
  sandboxGitRunFaultHookForTest = hook;
}

/**
 * Run a git command inside `cwd`. Throws on failure (callers decide whether
 * to tolerate). Always uses an arg array — never a shell string.
 */
// ---------------------------------------------------------------------------
// V3.10 (INT4 — B-U6 request 5, B-U2 request to U6): daemon git on trees an
// agent may have touched never runs a configured program
// ---------------------------------------------------------------------------

const DAEMON_GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/**
 * Command-scope config forced on EVERY git call this module makes (worktree
 * add/remove/prune, branch -D, rev-parse, diff capture), directly or through
 * the pinned-worktree child scripts, which inherit it through the env.
 *
 * WHY: a sandbox worktree is LINKED to its source repo (the fleet mirror, or
 * Mason's checkout in legacy mode) and shares that repo's config and hooks
 * directory. Anything that plants `core.fsmonitor=<cmd>`, a hook or a
 * `core.hooksPath` there — between two mirror syncs, or in a legacy checkout —
 * would otherwise run as Mason, unconfined, the next time the daemon touched
 * the worktree. GIT_CONFIG_COUNT entries are COMMAND scope, which beats every
 * config file, and unlike `-c` they reach git spawned by the child scripts.
 */
export const DAEMON_GIT_FORCED_CONFIG: readonly (readonly [string, string])[] = Object.freeze([
  ['core.hooksPath', DAEMON_GIT_NULL_DEVICE],
  ['core.fsmonitor', 'false'],
  ['core.untrackedCache', 'false'],
  ['core.pager', 'cat'],
  ['credential.helper', ''],
  ['commit.gpgSign', 'false'],
  ['gc.auto', '0'],
  ['maintenance.auto', 'false'],
  ['submodule.recurse', 'false'],
  ['protocol.ext.allow', 'never'],
] as const);

/**
 * `env` plus DAEMON_GIT_FORCED_CONFIG as GIT_CONFIG_COUNT entries. Existing
 * well-formed entries are kept and ours are appended AFTER them (the last
 * value wins, so ours hold); a malformed count is replaced rather than trusted.
 */
export function withDaemonGitHardening(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const raw = out.GIT_CONFIG_COUNT;
  let count = raw !== undefined && /^\d{1,3}$/.test(raw) ? Number.parseInt(raw, 10) : 0;
  for (let i = 0; i < count; i += 1) {
    if (out[`GIT_CONFIG_KEY_${i}`] === undefined || out[`GIT_CONFIG_VALUE_${i}`] === undefined) { count = 0; break; }
  }
  if (count === 0) {
    for (const key of Object.keys(out)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete out[key];
  }
  for (const [key, value] of DAEMON_GIT_FORCED_CONFIG) {
    out[`GIT_CONFIG_KEY_${count}`] = key;
    out[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  }
  out.GIT_CONFIG_COUNT = String(count);
  return out;
}

function gitRun(cwd: string, args: string[]): string {
  sandboxGitRunFaultHookForTest?.(cwd, [...args]);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  return execFileSync('git', args, {
    // hooks / fsmonitor / pager / credential helpers off (see withDaemonGitHardening).
    cwd,
    env: withDaemonGitHardening(env),
    timeout: GIT_TIMEOUT,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

/** Run a git command, returning null on any error (never throws). */
function gitTry(cwd: string, args: string[]): string | null {
  try {
    return gitRun(cwd, args);
  } catch {
    return null;
  }
}

interface PinnedWorktreeCreationResult {
  ok: boolean;
  cleanupComplete: boolean;
  error?: string;
  worktreeDev?: string;
  worktreeIno?: string;
  /** The worktree's administrative directory as REGISTER pinned it (ok results). */
  adminPath?: string;
  adminDev?: string;
  adminIno?: string;
  /** Runner step durations (ms), present only under ASHLR_SANDBOX_TIMING=1. */
  timing?: Record<string, number>;
}

const PINNED_GIT_SUPERVISOR = String.raw`
const { spawn } = require('node:child_process');
const { lstatSync } = require('node:fs');

const [cwd, repositoryContext, sourceRepo, ...gitArgs] = process.argv.slice(1);
const gitEnv = { ...process.env };
if (gitEnv.ASHLR_SUPERVISED_GIT_NODE_OPTIONS) {
  gitEnv.NODE_OPTIONS = gitEnv.ASHLR_SUPERVISED_GIT_NODE_OPTIONS;
} else {
  delete gitEnv.NODE_OPTIONS;
}
delete gitEnv.ASHLR_SUPERVISED_GIT_NODE_OPTIONS;
delete gitEnv.GIT_DIR;
delete gitEnv.GIT_WORK_TREE;
delete gitEnv.GIT_COMMON_DIR;
if (repositoryContext === 'pinned') {
  gitEnv.GIT_DIR = '.';
}

const destinationPin = gitEnv.ASHLR_PINNED_DESTINATION === '1' ? {
  parentPath: gitEnv.ASHLR_PINNED_DESTINATION_PARENT_PATH,
  parentDev: gitEnv.ASHLR_PINNED_DESTINATION_PARENT_DEV,
  parentIno: gitEnv.ASHLR_PINNED_DESTINATION_PARENT_INO,
  homePath: gitEnv.ASHLR_PINNED_DESTINATION_HOME_PATH,
  homeDev: gitEnv.ASHLR_PINNED_DESTINATION_HOME_DEV,
  homeIno: gitEnv.ASHLR_PINNED_DESTINATION_HOME_INO,
  metadataPath: gitEnv.ASHLR_PINNED_DESTINATION_METADATA_PATH,
  metadataDev: gitEnv.ASHLR_PINNED_DESTINATION_METADATA_DEV,
  metadataIno: gitEnv.ASHLR_PINNED_DESTINATION_METADATA_INO,
  worktreePath: gitEnv.ASHLR_PINNED_DESTINATION_WORKTREE_PATH,
  worktreeDev: gitEnv.ASHLR_PINNED_DESTINATION_WORKTREE_DEV,
  worktreeIno: gitEnv.ASHLR_PINNED_DESTINATION_WORKTREE_INO,
  allowWorktreeAbsence: gitEnv.ASHLR_PINNED_DESTINATION_ALLOW_WORKTREE_ABSENCE === '1',
  requireWorktreeAbsence: gitEnv.ASHLR_PINNED_DESTINATION_REQUIRE_WORKTREE_ABSENCE === '1',
} : null;
for (const key of Object.keys(gitEnv)) {
  if (key.startsWith('ASHLR_PINNED_DESTINATION')) delete gitEnv[key];
}

let sent = false;
let stdout = '';
let stderr = '';
const maxCapture = 64 * 1024;
function send(result) {
  if (sent) return;
  sent = true;
  if (typeof process.send === 'function') process.send(result);
}
function capture(current, chunk) {
  const next = current + chunk.toString('utf8');
  if (Buffer.byteLength(next, 'utf8') > maxCapture) {
    send({ status: null, stdout: '', stderr: '', error: 'git command output limit exceeded' });
    return current;
  }
  return next;
}

function samePinnedDirectory(path, dev, ino) {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() &&
      String(stat.dev) === dev && String(stat.ino) === ino;
  } catch {
    return false;
  }
}

function samePinnedFile(path, dev, ino) {
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isFile() && !stat.isSymbolicLink() &&
      String(stat.dev) === dev && String(stat.ino) === ino;
  } catch {
    return false;
  }
}

function pathAbsent(path) {
  try {
    lstatSync(path, { bigint: true });
    return false;
  } catch (error) {
    return Boolean(error && error.code === 'ENOENT');
  }
}

function destinationStillPinned() {
  if (destinationPin === null) return true;
  const worktreePinned = !destinationPin.worktreePath ||
    (destinationPin.requireWorktreeAbsence
      ? pathAbsent(destinationPin.worktreePath)
      : samePinnedDirectory(
          destinationPin.worktreePath,
          destinationPin.worktreeDev,
          destinationPin.worktreeIno,
        ) || (destinationPin.allowWorktreeAbsence && pathAbsent(destinationPin.worktreePath)));
  return (
    samePinnedDirectory(destinationPin.parentPath, destinationPin.parentDev, destinationPin.parentIno) &&
    samePinnedDirectory(destinationPin.homePath, destinationPin.homeDev, destinationPin.homeIno) &&
    samePinnedFile(destinationPin.metadataPath, destinationPin.metadataDev, destinationPin.metadataIno) &&
    worktreePinned
  );
}

let git;
try {
  if (!destinationStillPinned()) {
    send({ status: null, stdout: '', stderr: '', error: 'sandbox reservation identity changed before git command' });
  } else {
    git = spawn('git', gitArgs, {
      cwd,
      env: gitEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }
} catch (error) {
  send({ status: null, stdout: '', stderr: '', error: String(error) });
}
if (git) {
  const destinationMonitor = destinationPin === null ? null : setInterval(() => {
    if (!destinationStillPinned()) {
      send({ status: null, stdout, stderr, error: 'sandbox reservation identity changed during git command' });
    }
  }, 1);
  git.stdout.on('data', (chunk) => { stdout = capture(stdout, chunk); });
  git.stderr.on('data', (chunk) => { stderr = capture(stderr, chunk); });
  git.on('error', (error) => {
    if (destinationMonitor !== null) clearInterval(destinationMonitor);
    send({ status: null, stdout, stderr, error: error instanceof Error ? error.message : String(error) });
  });
  git.on('close', (status, signal) => {
    if (destinationMonitor !== null) clearInterval(destinationMonitor);
    send(destinationStillPinned()
      ? { status, stdout, stderr, ...(signal ? { error: 'git exited on ' + signal } : {}) }
      : { status: null, stdout, stderr, error: 'sandbox reservation identity changed during git command' });
  });
}

// The command runner owns this supervisor's process group/tree and kills it
// only after receiving a result or reaching its deadline.
setInterval(() => {}, 60_000);
`;

const PINNED_POST_CREATE_WRITER = String.raw`
const fs = require('node:fs');
const path = require('node:path');

const [sourceDev, sourceIno, sourceRepo, parentDev, parentIno, sandboxParent,
  homeDev, homeIno, sandboxHome, metadataDev, metadataIno, metadataPath,
  worktreeDev, worktreeIno, worktreePath,
  commonDev, commonIno, commonPath] = process.argv.slice(1);

function sameDirectory(value, dev, ino) {
  try {
    const stat = fs.lstatSync(value, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() &&
      String(stat.dev) === dev && String(stat.ino) === ino;
  } catch {
    return false;
  }
}

function sameFile(value, dev, ino) {
  try {
    const stat = fs.lstatSync(value, { bigint: true });
    return stat.isFile() && !stat.isSymbolicLink() &&
      String(stat.dev) === dev && String(stat.ino) === ino;
  } catch {
    return false;
  }
}

function destinationStillExact() {
  return sameDirectory(sandboxParent, parentDev, parentIno) &&
    sameDirectory(sandboxHome, homeDev, homeIno) &&
    sameFile(metadataPath, metadataDev, metadataIno) &&
    sameDirectory(worktreePath, worktreeDev, worktreeIno);
}

function safeRegularFile(value) {
  try {
    const stat = fs.lstatSync(value);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    return error && error.code === 'ENOENT';
  }
}

try {
  if (!destinationStillExact() || !sameDirectory('.', worktreeDev, worktreeIno) ||
      !sameDirectory(sourceRepo, sourceDev, sourceIno)) process.exit(0);
  const sourceModules = path.join(sourceRepo, 'node_modules');
  if (sameDirectory(sourceModules, String(fs.lstatSync(sourceModules, { bigint: true }).dev),
      String(fs.lstatSync(sourceModules, { bigint: true }).ino)) && !fs.existsSync('node_modules') &&
      destinationStillExact() && sameDirectory('.', worktreeDev, worktreeIno) &&
      sameDirectory(sourceRepo, sourceDev, sourceIno)) {
    fs.symlinkSync(sourceModules, 'node_modules', 'dir');
  }
} catch { /* node_modules linking is best effort */ }

try {
  if (!destinationStillExact() || !sameDirectory('.', worktreeDev, worktreeIno)) process.exit(0);
  const raw = fs.readFileSync('.git', 'utf8').trim();
  if (!raw.startsWith('gitdir: ')) process.exit(0);
  const rawGitdir = raw.slice('gitdir: '.length).trim();
  const gitdir = fs.realpathSync.native(path.resolve(worktreePath, rawGitdir));
  const relative = path.relative(commonPath, gitdir);
  if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    process.exit(0);
  }
  const gitdirStat = fs.lstatSync(gitdir, { bigint: true });
  if (!gitdirStat.isDirectory() || gitdirStat.isSymbolicLink() ||
      !sameDirectory(commonPath, commonDev, commonIno)) process.exit(0);
  process.chdir(gitdir);
  const gitdirDev = String(gitdirStat.dev);
  const gitdirIno = String(gitdirStat.ino);
  const authorityStillExact = () => destinationStillExact() &&
    sameDirectory(gitdir, gitdirDev, gitdirIno) && sameDirectory(commonPath, commonDev, commonIno);
  if (!authorityStillExact()) process.exit(0);
  if (!fs.existsSync('info')) fs.mkdirSync('info', { mode: 0o700 });
  const infoStat = fs.lstatSync('info', { bigint: true });
  if (!infoStat.isDirectory() || infoStat.isSymbolicLink() || !authorityStillExact()) process.exit(0);
  process.chdir('info');
  const infoDev = String(infoStat.dev);
  const infoIno = String(infoStat.ino);
  const writerAuthorityStillExact = () => authorityStillExact() && sameDirectory('.', infoDev, infoIno);
  if (!writerAuthorityStillExact() || !safeRegularFile('exclude')) process.exit(0);
  const exclude = 'exclude';
  const existing = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!existing.includes('node_modules') && writerAuthorityStillExact() && safeRegularFile(exclude)) {
    const fd = fs.openSync(exclude,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
      0o600);
    try {
      if (writerAuthorityStillExact()) {
        fs.writeSync(fd, '\n# M286: fleet-symlinked node_modules - never stage\nnode_modules\n');
      }
    } finally {
      fs.closeSync(fd);
    }
  }
} catch { /* exclude registration is best effort */ }
`;

/**
 * One read of a created worktree's state: HEAD's commit, HEAD's symbolic ref
 * (`refs/heads/<branch>`, or `HEAD` when detached), and the absolute Git
 * common directory, in that order. It answers what `rev-parse HEAD`,
 * `branch --show-current` and `rev-parse --git-common-dir` answered, from one
 * git process (and, in the pinned runner, one supervisor) instead of three.
 * Each Node supervisor costs ~50 ms of process start while the creator holds
 * the repo lease and the machine-wide outward-mutation fence.
 *
 * Equivalence: the branch check compares the full ref `refs/heads/<branch>`
 * (a detached HEAD prints `HEAD`, a non-branch symref prints its own full
 * name, so neither can match). An unborn HEAD makes rev-parse exit non-zero,
 * which the separate calls also rejected through the HEAD comparison.
 */
const WORKTREE_STATE_ARGS: readonly string[] = Object.freeze([
  'rev-parse',
  'HEAD',
  '--symbolic-full-name',
  'HEAD',
  '--path-format=absolute',
  '--git-common-dir',
]);

function parseWorktreeState(
  stdout: string | null,
): { head: string; headRef: string; commonPath: string } | null {
  if (stdout === null) return null;
  const lines = stdout.trim().split(/\r?\n/u);
  if (lines.length < 3) return null;
  const head = lines[0]!.trim();
  const headRef = lines[1]!.trim();
  // The path is last so an embedded newline stays part of it.
  const commonPath = lines.slice(2).join('\n').trim();
  return head && headRef && commonPath ? { head, headRef, commonPath } : null;
}

const PINNED_WORKTREE_RUNNER = String.raw`
const { spawn, spawnSync } = require('node:child_process');
const { lstatSync, readFileSync, realpathSync } = require('node:fs');
const path = require('node:path');
const supervisorSource = ${JSON.stringify(PINNED_GIT_SUPERVISOR)};
const postCreateWriterSource = ${JSON.stringify(PINNED_POST_CREATE_WRITER)};

const [commonDev, commonIno, expectedCommonPath, sourceDev, sourceIno, sourceRepo,
  parentDev, parentIno, sandboxParent, homeDev, homeIno, sandboxHome,
  metadataDev, metadataIno, metadataPath, worktreePath, branch, baseHead,
  mode, pinnedWorktreeDev, pinnedWorktreeIno, pinnedAdminPath, pinnedAdminDev, pinnedAdminIno] = process.argv.slice(2);
const childEnv = { ...process.env };
if (childEnv.ASHLR_PINNED_GIT_NODE_OPTIONS) {
  childEnv.NODE_OPTIONS = childEnv.ASHLR_PINNED_GIT_NODE_OPTIONS;
} else {
  delete childEnv.NODE_OPTIONS;
}
delete childEnv.ASHLR_PINNED_GIT_NODE_OPTIONS;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskkillOnce(pid) {
  return new Promise((resolve) => {
    let killer;
    try {
      killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      resolve();
      return;
    }
    killer.once('error', () => resolve());
    killer.once('close', () => resolve());
  });
}

async function joinOwnedTree(supervisor, closed) {
  const pid = supervisor.pid;
  if (typeof pid !== 'number' || pid < 1) {
    await closed;
    return;
  }
  if (process.platform === 'win32') {
    while (supervisor.exitCode === null && supervisor.signalCode === null) {
      await taskkillOnce(pid);
      if (supervisor.exitCode === null && supervisor.signalCode === null) await delay(10);
    }
    await closed;
    return;
  }

  while (true) {
    try {
      process.kill(-pid, 'SIGKILL');
      break;
    } catch (error) {
      if (error && error.code === 'ESRCH') return;
      await delay(10);
    }
  }
  await closed;
  while (true) {
    try {
      process.kill(-pid, 0);
      await delay(10);
    } catch (error) {
      if (error && error.code === 'ESRCH') return;
      await delay(10);
    }
  }
}

function run(cwd, args, options = {}) {
  return new Promise((resolve) => {
    const supervisorEnv = { ...childEnv };
    if (supervisorEnv.NODE_OPTIONS) {
      supervisorEnv.ASHLR_SUPERVISED_GIT_NODE_OPTIONS = supervisorEnv.NODE_OPTIONS;
    } else {
      delete supervisorEnv.ASHLR_SUPERVISED_GIT_NODE_OPTIONS;
    }
    delete supervisorEnv.NODE_OPTIONS;
    if (options.monitorDestination) {
      supervisorEnv.ASHLR_PINNED_DESTINATION = '1';
      supervisorEnv.ASHLR_PINNED_DESTINATION_PARENT_PATH = sandboxParent;
      supervisorEnv.ASHLR_PINNED_DESTINATION_PARENT_DEV = parentDev;
      supervisorEnv.ASHLR_PINNED_DESTINATION_PARENT_INO = parentIno;
      supervisorEnv.ASHLR_PINNED_DESTINATION_HOME_PATH = sandboxHome;
      supervisorEnv.ASHLR_PINNED_DESTINATION_HOME_DEV = homeDev;
      supervisorEnv.ASHLR_PINNED_DESTINATION_HOME_INO = homeIno;
      supervisorEnv.ASHLR_PINNED_DESTINATION_METADATA_PATH = metadataPath;
      supervisorEnv.ASHLR_PINNED_DESTINATION_METADATA_DEV = metadataDev;
      supervisorEnv.ASHLR_PINNED_DESTINATION_METADATA_INO = metadataIno;
      if (options.worktreePin || options.requireWorktreeAbsence) {
        supervisorEnv.ASHLR_PINNED_DESTINATION_WORKTREE_PATH = worktreePath;
        if (options.worktreePin) {
          supervisorEnv.ASHLR_PINNED_DESTINATION_WORKTREE_DEV = options.worktreePin.dev;
          supervisorEnv.ASHLR_PINNED_DESTINATION_WORKTREE_INO = options.worktreePin.ino;
        }
        supervisorEnv.ASHLR_PINNED_DESTINATION_ALLOW_WORKTREE_ABSENCE =
          options.allowWorktreeAbsence ? '1' : '0';
        supervisorEnv.ASHLR_PINNED_DESTINATION_REQUIRE_WORKTREE_ABSENCE =
          options.requireWorktreeAbsence ? '1' : '0';
      }
    }

    let supervisor;
    try {
      supervisor = spawn(process.execPath, [
        '-e', supervisorSource, '--', cwd,
        options.pinnedRepository ? 'pinned' : 'plain', sourceRepo, ...args,
      ], {
        cwd,
        env: supervisorEnv,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
        ...(process.platform === 'win32' ? {} : { detached: true }),
      });
    } catch (error) {
      resolve({ status: null, stdout: '', stderr: '', error: String(error) });
      return;
    }

    let finishing = false;
    const closed = new Promise((resolveClosed) => supervisor.once('close', resolveClosed));
    const finish = async (result) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      await joinOwnedTree(supervisor, closed);
      resolve(result);
    };
    const timer = setTimeout(() => {
      void finish({ status: null, stdout: '', stderr: '', error: 'git command timed out' });
    }, ${GIT_TIMEOUT});
    supervisor.once('message', (message) => {
      const result = message && typeof message === 'object'
        ? message
        : { status: null, stdout: '', stderr: '', error: 'invalid git supervisor result' };
      void finish(result);
    });
    supervisor.once('error', (error) => {
      void finish({ status: null, stdout: '', stderr: '', error: error.message });
    });
    supervisor.once('close', () => {
      if (!finishing) {
        void finish({ status: null, stdout: '', stderr: '', error: 'git supervisor exited without a result' });
      }
    });
  });
}

function sameDirectoryIdentity(stat, dev, ino) {
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    String(stat.dev) === dev && String(stat.ino) === ino;
}

function sameFileIdentity(stat, dev, ino) {
  return stat.isFile() && !stat.isSymbolicLink() &&
    String(stat.dev) === dev && String(stat.ino) === ino;
}

function sameCanonicalPath(left, right) {
  const fold = process.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value;
  return fold(path.resolve(left)) === fold(path.resolve(right));
}

const worktreeStateArgs = ${JSON.stringify(WORKTREE_STATE_ARGS)};

// Split a multi-value rev-parse result. The LAST value is a path and keeps any
// embedded newline; the earlier ones (object ids, ref names) cannot hold one.
function revParseLines(entry, count) {
  if (!entry || entry.status !== 0 || typeof entry.stdout !== 'string') return null;
  const lines = entry.stdout.trim().split(/\r?\n/);
  if (lines.length < count) return null;
  return [
    ...lines.slice(0, count - 1).map((line) => line.trim()),
    lines.slice(count - 1).join('\n').trim(),
  ];
}

function runPinned(args, options = {}) {
  return run('.', args, { ...options, pinnedRepository: true });
}

async function registrationPresent() {
  const listed = await runPinned(['worktree', 'list', '--porcelain']);
  if (listed.status !== 0 || typeof listed.stdout !== 'string') return null;
  const target = path.resolve(worktreePath);
  const fold = process.platform === 'win32' ? (value) => value.toLowerCase() : (value) => value;
  return listed.stdout.split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .some((line) => fold(path.resolve(line.slice('worktree '.length).trimEnd())) === fold(target));
}

async function branchPresent() {
  const shown = await runPinned(['show-ref', '--verify', '--quiet', 'refs/heads/' + branch]);
  return shown.status === 0 ? true : shown.status === 1 ? false : null;
}

async function rollback() {
  if (!currentDestinationIsPinned()) return false;
  let worktreePin = null;
  try {
    const stat = lstatSync(worktreePath, { bigint: true });
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      worktreePin = { dev: String(stat.dev), ino: String(stat.ino) };
    }
  } catch { /* an incomplete add may not have created the worktree */ }

  const runRollbackMutation = async (args, options = {}) => {
    if (!currentDestinationIsPinned()) return false;
    const mutation = await runPinned(args, { monitorDestination: true, ...options });
    return currentDestinationIsPinned() &&
      !(mutation.error && mutation.error.includes('sandbox reservation identity changed'));
  };

  if (!await runRollbackMutation(
    // Double force: the timed-out add this rolls back was SIGKILLed while
    // holding git's "initializing" worktree lock.
    ['worktree', 'remove', '--force', '--force', worktreePath],
    worktreePin
      ? { worktreePin, allowWorktreeAbsence: true }
      : { requireWorktreeAbsence: true },
  )) return false;
  if (!await runRollbackMutation(['worktree', 'prune'])) return false;
  if (!await runRollbackMutation(['branch', '-D', branch])) return false;
  if (!currentDestinationIsPinned()) return false;
  const registrationAbsent = await registrationPresent() === false;
  if (!currentDestinationIsPinned()) return false;
  const branchAbsent = await branchPresent() === false;
  return currentDestinationIsPinned() && registrationAbsent && branchAbsent;
}

function currentDestinationIsPinned() {
  try {
    return sameDirectoryIdentity(lstatSync(sandboxParent, { bigint: true }), parentDev, parentIno) &&
      sameDirectoryIdentity(lstatSync(sandboxHome, { bigint: true }), homeDev, homeIno) &&
      sameFileIdentity(lstatSync(metadataPath, { bigint: true }), metadataDev, metadataIno) &&
      sameCanonicalPath(path.dirname(sandboxHome), sandboxParent) &&
      sameCanonicalPath(path.dirname(metadataPath), sandboxHome) &&
      path.basename(worktreePath) === 'worktree' &&
      sameCanonicalPath(realpathSync.native(path.dirname(worktreePath)), sandboxHome);
  } catch {
    return false;
  }
}

async function currentSourceIsPinned() {
  try {
    if (!sameDirectoryIdentity(lstatSync(sourceRepo, { bigint: true }), sourceDev, sourceIno)) return false;
    const common = await run(sourceRepo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (common.status !== 0 || typeof common.stdout !== 'string' || !common.stdout.trim()) return false;
    const commonPath = realpathSync.native(common.stdout.trim());
    return sameCanonicalPath(commonPath, expectedCommonPath) &&
      sameDirectoryIdentity(lstatSync(commonPath, { bigint: true }), commonDev, commonIno);
  } catch {
    return false;
  }
}

async function retainedSourceMatchesDiscovery() {
  try {
    if (!sameDirectoryIdentity(lstatSync('.', { bigint: true }), sourceDev, sourceIno) ||
        !sameCanonicalPath(realpathSync.native('.'), sourceRepo)) return false;
    // One supervised rev-parse answers both questions (HEAD, then the common
    // directory) instead of two supervisors each paying a Node start.
    const discovered = revParseLines(
      await run('.', ['rev-parse', 'HEAD', '--path-format=absolute', '--git-common-dir']),
      2,
    );
    if (discovered === null || discovered[0] !== baseHead || !discovered[1]) return false;
    const commonPath = realpathSync.native(discovered[1]);
    return sameCanonicalPath(commonPath, expectedCommonPath) &&
      sameDirectoryIdentity(lstatSync(commonPath, { bigint: true }), commonDev, commonIno) &&
      sameDirectoryIdentity(lstatSync('.', { bigint: true }), sourceDev, sourceIno);
  } catch {
    return false;
  }
}

function runPinnedPostCreateWriter() {
  try {
    const worktree = lstatSync(worktreePath, { bigint: true });
    if (!worktree.isDirectory() || worktree.isSymbolicLink() || !currentDestinationIsPinned()) return;
    const writerEnv = { ...childEnv };
    delete writerEnv.NODE_OPTIONS;
    const result = spawnSync(process.execPath, [
      '-e', postCreateWriterSource, '--', sourceDev, sourceIno, sourceRepo,
      parentDev, parentIno, sandboxParent, homeDev, homeIno, sandboxHome,
      metadataDev, metadataIno, metadataPath,
      String(worktree.dev), String(worktree.ino), worktreePath,
      commonDev, commonIno, expectedCommonPath,
    ], {
      cwd: worktreePath,
      env: writerEnv,
      stdio: 'ignore',
      windowsHide: true,
      timeout: ${GIT_TIMEOUT},
    });
    void result;
  } catch { /* post-create writes are best effort */ }
}

async function validateCreatedWorktree() {
  let worktreePin;
  try {
    const stat = lstatSync(worktreePath, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { exact: false, reservationChanged: true };
    }
    worktreePin = { dev: String(stat.dev), ino: String(stat.ino) };
  } catch {
    return { exact: false, reservationChanged: true };
  }
  // HEAD's commit, HEAD's symbolic ref and the common directory from ONE
  // destination-monitored rev-parse (see WORKTREE_STATE_ARGS).
  const inspected = await run(worktreePath, worktreeStateArgs, {
    monitorDestination: true,
    worktreePin,
  });
  const reservationChanged = Boolean(
    inspected.error && inspected.error.includes('sandbox reservation identity changed'));
  const state = revParseLines(inspected, 3);
  if (state === null || state[0] !== baseHead || state[1] !== 'refs/heads/' + branch ||
      !state[2]) return { exact: false, reservationChanged };
  try {
    const commonPath = realpathSync.native(state[2]);
    return {
      exact: sameCanonicalPath(commonPath, expectedCommonPath) &&
        sameDirectoryIdentity(lstatSync(commonPath, { bigint: true }), commonDev, commonIno),
      reservationChanged,
    };
  } catch {
    return { exact: false, reservationChanged };
  }
}

// Step timings, reported only when ASHLR_SANDBOX_TIMING=1 (see SandboxCreationClock).
const stepTiming = childEnv.ASHLR_SANDBOX_TIMING === '1' ? { last: performance.now(), steps: { boot: performance.now() } } : null;
function markStep(name) {
  if (stepTiming === null) return;
  const now = performance.now();
  stepTiming.steps[name] = (stepTiming.steps[name] || 0) + (now - stepTiming.last);
  stepTiming.last = now;
}

// One bounded line naming what went wrong, for the caller's error and audit.
function describeError(error) {
  const text = error && typeof error === 'object'
    ? [error.code, error.message].filter(Boolean).join(' ')
    : String(error);
  return text.replace(/\s+/g, ' ').slice(0, 300) || 'unknown error';
}

function worktreeIdentityResult(admin) {
  try {
    const worktree = lstatSync(worktreePath, { bigint: true });
    return worktree.isDirectory() && !worktree.isSymbolicLink()
      ? {
          ok: true,
          cleanupComplete: false,
          worktreeDev: String(worktree.dev),
          worktreeIno: String(worktree.ino),
          adminPath: admin.path,
          adminDev: admin.dev,
          adminIno: admin.ino,
        }
      : { ok: false, cleanupComplete: false, error: 'worktree identity unavailable after creation' };
  } catch {
    return { ok: false, cleanupComplete: false, error: 'worktree identity unavailable after creation' };
  }
}

// REGISTER (caller holds the repo lease and the outward fence): verify the
// source, add the worktree WITHOUT checking it out, and validate the
// registration. Every effect on the source repository's Git state (the new
// branch ref, the worktree administrative entry) happens here, and so does
// every rollback of it.
async function registerWorktree() {
  // Both source probes are read-only rev-parses, so they run side by side
  // (one supervisor start instead of two in sequence). Both are spawned
  // before the chdir below (the retained probe's cwd is '.', the source
  // itself; the pathname probe names sourceRepo explicitly), their verdicts
  // are applied in the original order, and both are still observed before
  // the add.
  const [retainedSourceExact, sourcePathPinned] = await Promise.all([
    retainedSourceMatchesDiscovery(),
    currentSourceIsPinned(),
  ]);
  markStep('sourceProbes');
  if (!retainedSourceExact) {
    return { ok: false, cleanupComplete: true, error: 'source repository discovery identity changed before worktree creation' };
  }
  if (!currentDestinationIsPinned()) {
    return { ok: false, cleanupComplete: false, error: 'sandbox reservation identity changed before worktree creation' };
  }
  process.chdir(expectedCommonPath);
  if (!sameCanonicalPath(realpathSync.native('.'), expectedCommonPath) ||
      !sameDirectoryIdentity(lstatSync('.', { bigint: true }), commonDev, commonIno) ||
      !sourcePathPinned) {
    return { ok: false, cleanupComplete: true, error: 'repository association changed before worktree creation' };
  }
  // --no-checkout: the checkout (populate mode) touches only the new
  // worktree, so it runs after the caller drops the fence and the repo lease.
  // It is appended so the positional arguments keep their places.
  const added = await runPinned([
    'worktree', 'add', '-b', branch, worktreePath, baseHead, '--no-checkout',
  ], { monitorDestination: true });
  markStep('worktreeAdd');
  if (added.status !== 0) {
    return {
      ok: false,
      cleanupComplete: await rollback(),
      error: added.error && added.error.includes('sandbox reservation identity changed')
        ? added.error
        : 'git worktree add failed',
    };
  }
  const destinationPinnedBeforeValidation = currentDestinationIsPinned();
  const worktreeValidation = destinationPinnedBeforeValidation
    ? await validateCreatedWorktree()
    : { exact: false, reservationChanged: true };
  const worktreeExact = destinationPinnedBeforeValidation && worktreeValidation.exact;
  const destinationPinnedAfterValidation = currentDestinationIsPinned();
  markStep('validateRegistration');
  if (!destinationPinnedBeforeValidation || !worktreeExact || !destinationPinnedAfterValidation) {
    const reservationChanged = !destinationPinnedBeforeValidation ||
      !destinationPinnedAfterValidation || worktreeValidation.reservationChanged;
    return {
      ok: false,
      cleanupComplete: await rollback(),
      error: reservationChanged
        ? 'sandbox reservation identity changed during worktree creation'
        : 'sandbox reservation or repository/Git common directory identity changed during worktree creation',
    };
  }
  // Pin the administrative directory git just created: POPULATE runs its
  // checkout against exactly this inode and refuses any other.
  const admin = ownedAdministrativeDirectory();
  if (admin === null) {
    return {
      ok: false,
      cleanupComplete: await rollback(),
      error: 'worktree administrative directory identity unavailable after worktree creation',
    };
  }
  return worktreeIdentityResult(admin);
}

// The registered worktree's own administrative directory, resolved from its
// .git file and required to sit directly under the pinned common directory's
// worktrees/ (the place git worktree add created it), with its identity
// (path, dev, ino as strings). Null on any doubt.
function ownedAdministrativeDirectory() {
  try {
    const dotGit = path.join(worktreePath, '.git');
    const stat = lstatSync(dotGit);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const raw = readFileSync(dotGit, 'utf8').trim();
    if (!raw.startsWith('gitdir: ')) return null;
    const adminDir = realpathSync.native(path.resolve(worktreePath, raw.slice('gitdir: '.length).trim()));
    const relative = path.relative(path.join(expectedCommonPath, 'worktrees'), adminDir);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ||
        relative.includes(path.sep)) return null;
    const adminStat = lstatSync(adminDir, { bigint: true });
    if (!adminStat.isDirectory() || adminStat.isSymbolicLink() ||
        !sameDirectoryIdentity(lstatSync(expectedCommonPath, { bigint: true }), commonDev, commonIno)) return null;
    return { path: adminDir, dev: String(adminStat.dev), ino: String(adminStat.ino) };
  } catch {
    return null;
  }
}

// POPULATE (no fence, no repo lease; the caller holds a creation execution
// lease so kill / unenroll still wait for it): check out the registered
// worktree exactly as git worktree add itself does (reset --hard
// --no-recurse-submodules with GIT_DIR = the worktree's own administrative
// directory), run the post-create writer, and validate again. This writes
// the new worktree's files, its private index and its own HEAD reflog. The
// branch already points at baseHead, so its value does not change, but
// reset may still take a transient refs/heads/<branch>.lock in the common
// directory outside the repo lease; a concurrent pack-refs or gc on that ref
// makes the reset fail, which fails closed (rollback), never corrupts. It
// never rolls back itself: a failure is returned and the caller re-takes the
// repo lease and the fence to run ROLLBACK.
async function populateWorktree() {
  const worktreePin = { dev: pinnedWorktreeDev, ino: pinnedWorktreeIno };
  const worktreeStillPinned = () => {
    try {
      return sameDirectoryIdentity(lstatSync(worktreePath, { bigint: true }), worktreePin.dev, worktreePin.ino);
    } catch {
      return false;
    }
  };
  if (!currentDestinationIsPinned() || !worktreeStillPinned()) {
    return { ok: false, cleanupComplete: false, error: 'sandbox reservation identity changed before worktree checkout' };
  }
  // The administrative directory REGISTER pinned, and no other.
  const adminStillPinned = () => {
    const admin = ownedAdministrativeDirectory();
    return admin !== null && sameCanonicalPath(admin.path, pinnedAdminPath) &&
      admin.dev === pinnedAdminDev && admin.ino === pinnedAdminIno;
  };
  if (!adminStillPinned()) {
    return { ok: false, cleanupComplete: false, error: 'worktree administrative directory identity changed before checkout' };
  }
  const adminDir = pinnedAdminPath;
  const populated = await run(worktreePath, [
    '--git-dir=' + adminDir, '--work-tree=' + worktreePath,
    'reset', '--hard', '--no-recurse-submodules', '--quiet',
  ], { monitorDestination: true, worktreePin });
  markStep('checkout');
  if (populated.status !== 0 || !currentDestinationIsPinned() || !worktreeStillPinned() ||
      !adminStillPinned()) {
    return {
      ok: false,
      cleanupComplete: false,
      error: populated.error && populated.error.includes('sandbox reservation identity changed')
        ? populated.error
        : 'git worktree checkout failed',
    };
  }
  runPinnedPostCreateWriter();
  markStep('postCreateWriter');
  const destinationPinnedBeforePostValidation = currentDestinationIsPinned();
  const postValidation = destinationPinnedBeforePostValidation
    ? await validateCreatedWorktree()
    : { exact: false, reservationChanged: true };
  const postWorktreeExact = destinationPinnedBeforePostValidation && postValidation.exact;
  const destinationPinnedAfterPostValidation = currentDestinationIsPinned();
  markStep('validatePopulated');
  if (!destinationPinnedBeforePostValidation || !postWorktreeExact ||
      !destinationPinnedAfterPostValidation || !worktreeStillPinned() || !adminStillPinned()) {
    const reservationChanged = !destinationPinnedBeforePostValidation ||
      !destinationPinnedAfterPostValidation || postValidation.reservationChanged;
    return {
      ok: false,
      cleanupComplete: false,
      error: reservationChanged
        ? 'sandbox reservation identity changed after worktree creation'
        : 'sandbox reservation or repository/Git common directory identity changed after worktree creation',
    };
  }
  return worktreeIdentityResult({ path: pinnedAdminPath, dev: pinnedAdminDev, ino: pinnedAdminIno });
}

// ROLLBACK (caller holds the repo lease and the outward fence again): the
// same pinned rollback REGISTER uses, run from the pinned common directory.
async function rollbackWorktree() {
  process.chdir(expectedCommonPath);
  if (!sameCanonicalPath(realpathSync.native('.'), expectedCommonPath) ||
      !sameDirectoryIdentity(lstatSync('.', { bigint: true }), commonDev, commonIno)) {
    return { ok: false, cleanupComplete: false, error: 'repository association changed before rollback' };
  }
  return { ok: false, cleanupComplete: await rollback(), error: 'sandbox creation rolled back' };
}

(async () => {
  let result;
  try {
    result = mode === 'register'
      ? await registerWorktree()
      : mode === 'populate'
        ? await populateWorktree()
        : mode === 'rollback'
          ? await rollbackWorktree()
          : { ok: false, cleanupComplete: false, error: 'unknown pinned worktree runner mode' };
  } catch (error) {
    let cleanupComplete = false;
    // Only REGISTER rolls back in place; the other modes run without (populate)
    // or already are (rollback) the rollback.
    if (mode === 'register') {
      try { cleanupComplete = await rollback(); } catch { /* retain recovery metadata */ }
    }
    result = { ok: false, cleanupComplete, error: 'pinned worktree creation failed: ' + describeError(error) };
  }
  if (stepTiming !== null) result.timing = stepTiming.steps;
  process.stdout.write(JSON.stringify(result));
})().catch((error) => {
  process.stdout.write(JSON.stringify({
    ok: false,
    cleanupComplete: false,
    error: 'pinned worktree runner failed: ' + describeError(error),
  }));
});
`;

/**
 * What the pinned runner does on one invocation:
 *  - `register`: verify the source, `git worktree add --no-checkout`, validate
 *    the registration, and roll it back in place on any failure. Repo lease +
 *    outward fence held.
 *  - `populate`: check the registered worktree out, run the post-create
 *    writer, validate again. Touches only the new worktree; never rolls back.
 *    Neither lock held (a creation execution lease is).
 *  - `rollback`: the pinned rollback of a registered worktree. Repo lease +
 *    outward fence held again.
 */
type PinnedWorktreeRunnerMode = 'register' | 'populate' | 'rollback';

/** A registered worktree's administrative directory (`<common>/worktrees/<name>`), pinned at REGISTER. */
interface PinnedAdministrativeDirectory {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
}

interface PinnedWorktreeRunnerInvocation {
  argv: string[];
  /** The runner source, written to the child's stdin (`node -`). */
  script: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Windows caps a whole command line (CreateProcess lpCommandLine) at 32,767
 * characters. The runner embeds the supervisor and post-create writer and is
 * itself ~34k, so it is fed on stdin (`node -`) and only its arguments ride
 * the command line. The supervisor and writer the runner spawns with `-e`
 * must each stay under this bound (test/sandbox-create-two-phase.test.ts).
 */
export const WINDOWS_COMMAND_LINE_LIMIT = 32_767;

/** Sizes the Windows command-line bound applies to (tests only). */
export function _pinnedRunnerCommandLineSizesForTest(): {
  runnerArgvChars: number;
  supervisorScriptChars: number;
  writerScriptChars: number;
  runnerScriptOnCommandLine: boolean;
} {
  const long = 'C:\\' + 'x'.repeat(250);
  const dir = { path: long, dev: 1n, ino: 1n };
  const invocation = pinnedWorktreeRunnerInvocation(
    'populate',
    { source: dir, commonDirectory: dir },
    { parent: dir, home: dir, metadata: dir },
    { id: 'x', sourceRepo: long, worktreePath: long, branch: long, baseHead: 'f'.repeat(64), createdAt: '' },
    dir,
    { path: long, dev: '1', ino: '1' },
  );
  return {
    runnerArgvChars: [process.execPath, ...invocation.argv].reduce((n, a) => n + a.length + 3, 0),
    supervisorScriptChars: PINNED_GIT_SUPERVISOR.length,
    writerScriptChars: PINNED_POST_CREATE_WRITER.length,
    runnerScriptOnCommandLine: invocation.argv.some((a) => a.includes('registerWorktree')),
  };
}

/**
 * Bind the child to the pinned common-directory inode before Git starts. The
 * child retains that cwd through add, validation, and rollback, so pathname
 * retargeting cannot redirect any repository mutation during the Git effect.
 */
function pinnedWorktreeRunnerInvocation(
  mode: PinnedWorktreeRunnerMode,
  identity: PinnedRepositoryIdentity,
  destination: PinnedSandboxDestinationIdentity,
  sb: Sandbox,
  worktree: PinnedDirectoryIdentity | null,
  admin: PinnedAdministrativeDirectory | null,
): PinnedWorktreeRunnerInvocation {
  // The runner and its supervisors copy this env into every git they spawn,
  // so the forced config reaches `worktree add` and its validation calls too.
  const env = withDaemonGitHardening({ ...process.env });
  if (env.NODE_OPTIONS) env.ASHLR_PINNED_GIT_NODE_OPTIONS = env.NODE_OPTIONS;
  else delete env.ASHLR_PINNED_GIT_NODE_OPTIONS;
  delete env.NODE_OPTIONS;
  return {
    argv: [
      '-',
      String(identity.commonDirectory.dev),
      String(identity.commonDirectory.ino),
      identity.commonDirectory.path,
      String(identity.source.dev),
      String(identity.source.ino),
      identity.source.path,
      String(destination.parent.dev),
      String(destination.parent.ino),
      destination.parent.path,
      String(destination.home.dev),
      String(destination.home.ino),
      destination.home.path,
      String(destination.metadata.dev),
      String(destination.metadata.ino),
      destination.metadata.path,
      sb.worktreePath,
      sb.branch,
      sb.baseHead,
      mode,
      worktree ? String(worktree.dev) : '',
      worktree ? String(worktree.ino) : '',
      admin?.path ?? '',
      admin?.dev ?? '',
      admin?.ino ?? '',
    ],
    script: PINNED_WORKTREE_RUNNER,
    cwd: identity.source.path,
    env,
  };
}

/** One bounded line on why the runner process itself failed. */
function runnerFailureDetail(
  error: Error | undefined,
  status: number | null,
  signal: string | null,
  stderr: unknown,
): string {
  const parts: string[] = [];
  if (error) parts.push(`spawn ${(error as NodeJS.ErrnoException).code ?? ''} ${error.message}`.trim());
  if (status !== null && status !== 0) parts.push(`exit ${status}`);
  if (signal) parts.push(`signal ${signal}`);
  const tail = typeof stderr === 'string' ? stderr.replace(/\s+/gu, ' ').trim().slice(-300) : '';
  if (tail) parts.push(`stderr: ${tail}`);
  return parts.join('; ') || 'no result';
}

function parsePinnedWorktreeResult(
  failure: string | null,
  stdout: unknown,
): PinnedWorktreeCreationResult {
  if (failure !== null || typeof stdout !== 'string') {
    return { ok: false, cleanupComplete: false, error: `pinned worktree runner failed (${failure ?? 'no output'})` };
  }
  try {
    const parsed = JSON.parse(stdout) as Partial<PinnedWorktreeCreationResult>;
    if (typeof parsed.ok !== 'boolean' || typeof parsed.cleanupComplete !== 'boolean') {
      throw new Error('invalid pinned worktree result');
    }
    if (parsed.ok && (
      typeof parsed.worktreeDev !== 'string' || !/^\d+$/u.test(parsed.worktreeDev) ||
      typeof parsed.worktreeIno !== 'string' || !/^\d+$/u.test(parsed.worktreeIno) ||
      typeof parsed.adminPath !== 'string' || parsed.adminPath.length === 0 ||
      typeof parsed.adminDev !== 'string' || !/^\d+$/u.test(parsed.adminDev) ||
      typeof parsed.adminIno !== 'string' || !/^\d+$/u.test(parsed.adminIno)
    )) throw new Error('invalid pinned worktree identity');
    const timing = parsed.timing !== null && typeof parsed.timing === 'object' ? parsed.timing : undefined;
    return {
      ok: parsed.ok,
      cleanupComplete: parsed.cleanupComplete,
      ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}),
      ...(typeof parsed.worktreeDev === 'string' ? { worktreeDev: parsed.worktreeDev } : {}),
      ...(typeof parsed.worktreeIno === 'string' ? { worktreeIno: parsed.worktreeIno } : {}),
      ...(typeof parsed.adminPath === 'string' ? { adminPath: parsed.adminPath } : {}),
      ...(typeof parsed.adminDev === 'string' ? { adminDev: parsed.adminDev } : {}),
      ...(typeof parsed.adminIno === 'string' ? { adminIno: parsed.adminIno } : {}),
      ...(timing ? { timing } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      cleanupComplete: false,
      error: `invalid pinned worktree result (${error instanceof Error ? error.message : String(error)}: ` +
        `${stdout.replace(/\s+/gu, ' ').slice(0, 200)})`,
    };
  }
}

function runPinnedWorktreeRunner(invocation: PinnedWorktreeRunnerInvocation): PinnedWorktreeCreationResult {
  const result = spawnSync(process.execPath, invocation.argv, {
    cwd: invocation.cwd,
    encoding: 'utf8',
    env: invocation.env,
    input: invocation.script,
    maxBuffer: 64 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const failed = Boolean(result.error) || result.status !== 0;
  return parsePinnedWorktreeResult(
    failed ? runnerFailureDetail(result.error, result.status, result.signal, result.stderr) : null,
    result.stdout,
  );
}

/**
 * The same runner without blocking the event loop (populate in
 * createSandboxAsync). The runner bounds every Git command itself
 * (GIT_TIMEOUT per supervised call), and nothing kills it early: stopping it
 * mid-checkout would orphan its supervisors while the caller rolls back.
 */
function runPinnedWorktreeRunnerAsync(
  invocation: PinnedWorktreeRunnerInvocation,
): Promise<PinnedWorktreeCreationResult> {
  return new Promise((resolveResult) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, invocation.argv, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolveResult(parsePinnedWorktreeResult(
        runnerFailureDetail(error instanceof Error ? error : new Error(String(error)), null, null, ''),
        null,
      ));
      return;
    }
    let stdout = '';
    let stderr = '';
    let overflow = false;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (overflow) return;
      stdout += chunk;
      if (stdout.length > 64 * 1024) overflow = true;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4 * 1024);
    });
    // The script goes over stdin (see WINDOWS_COMMAND_LINE_LIMIT). A write
    // error surfaces as the child's own failure below.
    child.stdin?.on('error', () => { /* reported through close / error */ });
    child.stdin?.end(invocation.script);
    let settled = false;
    const settle = (error: Error | undefined, status: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      const failed = error !== undefined || status !== 0 || overflow;
      resolveResult(parsePinnedWorktreeResult(
        failed ? (overflow ? 'output limit exceeded' : runnerFailureDetail(error, status, signal, stderr)) : null,
        stdout,
      ));
    };
    child.once('error', (error) => settle(error, null, null));
    child.once('close', (status, signal) => settle(undefined, status, signal));
  });
}

// ---------------------------------------------------------------------------
// Metadata persistence
// ---------------------------------------------------------------------------

function writeMeta(sb: Sandbox): void {
  const home = sandboxHome(sb.id);
  const root = sandboxesDir();
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  }
  const expectedDirs = new Map<string, { dev: bigint; ino: bigint }>();
  for (const dir of [root, home]) {
    const stat = lstatSync(dir, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() ||
      (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid()))) {
      throw new Error('unsafe sandbox metadata directory');
    }
    chmodSync(dir, 0o700);
    expectedDirs.set(dir, { dev: stat.dev, ino: stat.ino });
  }
  const target = metaPath(sb.id);
  if (existsSync(target)) {
    const current = lstatSync(target, { bigint: true });
    if (current.isSymbolicLink() || !current.isFile() ||
      (typeof process.getuid === 'function' && current.uid !== BigInt(process.getuid()))) {
      throw new Error('unsafe sandbox metadata file');
    }
  }
  const temp = join(home, `.sandbox.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | undefined;
  let tempIdentity: { dev: bigint; ino: bigint } | null = null;
  try {
    fd = openSync(
      temp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) throw new Error('invalid sandbox metadata temporary file');
    tempIdentity = { dev: opened.dev, ino: opened.ino };
    const bytes = Buffer.from(JSON.stringify(sb, null, 2) + '\n', 'utf8');
    if (writeSync(fd, bytes) !== bytes.length) throw new Error('short sandbox metadata write');
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    for (const dir of [root, home]) {
      const expected = expectedDirs.get(dir)!;
      const current = lstatSync(dir, { bigint: true });
      if (current.isSymbolicLink() || !current.isDirectory() ||
        current.dev !== expected.dev || current.ino !== expected.ino) {
        throw new Error('sandbox metadata directory changed during write');
      }
    }
    renameSync(temp, target);
    const persisted = lstatSync(target, { bigint: true });
    if (persisted.isSymbolicLink() || !persisted.isFile() || tempIdentity === null ||
        persisted.dev !== tempIdentity.dev || persisted.ino !== tempIdentity.ino) {
      throw new Error('invalid sandbox metadata replacement');
    }
    chmodSync(target, 0o600);
    let dirFd: number | undefined;
    try {
      dirFd = openSync(home, fsConstants.O_RDONLY);
      fsyncSync(dirFd);
    } catch {
      // Some platforms/filesystems do not support fsync on directories. The
      // atomically renamed, fsynced file remains valid; directory durability is
      // a best-effort power-loss enhancement, not a sandbox availability gate.
    } finally {
      if (dirFd !== undefined) { try { closeSync(dirFd); } catch { /* best effort */ } }
    }
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
    try { unlinkSync(temp); } catch { /* renamed or absent */ }
  }
}

function parseCleanupEvidence(value: unknown): SandboxCleanupEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const p = o['postconditions'];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return undefined;
  const post = p as Record<string, unknown>;
  const states = new Set<SandboxCleanupPostcondition>(['absent', 'present', 'unknown', 'unsafe']);
  const failures = new Set<SandboxCleanupFailureClass>([
    'cleanup-locked', 'unsafe-metadata', 'source-repo-unavailable', 'worktree-remaining',
    'branch-remaining', 'postcondition-unavailable', 'home-remove-failed',
  ]);
  if (
    o['schemaVersion'] !== 1 ||
    typeof o['attemptedAt'] !== 'string' ||
    o['attemptedAt'].length > 32 ||
    Number.isNaN(Date.parse(o['attemptedAt'])) ||
    typeof o['attempt'] !== 'number' ||
    !Number.isInteger(o['attempt']) ||
    o['attempt'] < 1 ||
    o['attempt'] > 1_000 ||
    (o['status'] !== 'residual' && o['status'] !== 'refused' && o['status'] !== 'unavailable') ||
    typeof o['retryable'] !== 'boolean' ||
    !Array.isArray(o['failureClasses']) ||
    !o['failureClasses'].every((v) => failures.has(v as SandboxCleanupFailureClass)) ||
    !states.has(post['registration'] as SandboxCleanupPostcondition) ||
    !states.has(post['branch'] as SandboxCleanupPostcondition) ||
    !states.has(post['home'] as SandboxCleanupPostcondition)
  ) return undefined;
  return {
    schemaVersion: 1,
    attemptedAt: o['attemptedAt'],
    attempt: o['attempt'],
    status: o['status'],
    postconditions: {
      registration: post['registration'] as SandboxCleanupPostcondition,
      branch: post['branch'] as SandboxCleanupPostcondition,
      home: post['home'] as SandboxCleanupPostcondition,
    },
    failureClasses: [...new Set(o['failureClasses'] as SandboxCleanupFailureClass[])].slice(0, 8),
    retryable: o['retryable'],
  };
}

/** Read + validate one sandbox's metadata. Returns null on missing/malformed. */
function readMeta(id: string): Sandbox | null {
  if (!SANDBOX_ID_RE.test(id)) return null;
  const p = metaPath(id);
  if (!existsSync(p)) return null;
  let fd: number | undefined;
  try {
    const before = lstatSync(p);
    if (before.isSymbolicLink() || !before.isFile() || before.size > 64 * 1024 ||
      (typeof process.getuid === 'function' && before.uid !== process.getuid())) return null;
    fd = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return null;
    const bytes = Buffer.alloc(opened.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return null;
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      const o = parsed as Record<string, unknown>;
      if (
        typeof o['id'] === 'string' &&
        o['id'] === id &&
        typeof o['sourceRepo'] === 'string' &&
        typeof o['worktreePath'] === 'string' &&
        typeof o['branch'] === 'string' &&
        typeof o['baseHead'] === 'string' &&
        typeof o['createdAt'] === 'string'
      ) {
        // ownerPid is OPTIONAL (back-compat): only carried through when it is a
        // positive integer; anything else (absent/malformed/<=0) is dropped so
        // ownerAlive() falls back to the createdAt-age guard for that sandbox.
        const rawPid = o['ownerPid'];
        const ownerPid =
          typeof rawPid === 'number' && Number.isInteger(rawPid) && rawPid > 0
            ? rawPid
            : undefined;
        const cleanup = parseCleanupEvidence(o['cleanup']);
        const abandonedAt = typeof o['abandonedAt'] === 'string' ? o['abandonedAt'] : undefined;
        return {
          id: o['id'],
          sourceRepo: o['sourceRepo'],
          worktreePath: o['worktreePath'],
          branch: o['branch'],
          baseHead: o['baseHead'],
          createdAt: o['createdAt'],
          ...(ownerPid !== undefined ? { ownerPid } : {}),
          ...(cleanup ? { cleanup } : {}),
          ...(abandonedAt !== undefined ? { abandonedAt } : {}),
        };
      }
    }
  } catch {
    // malformed — treat as absent
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
  return null;
}

// ---------------------------------------------------------------------------
// createSandbox
// ---------------------------------------------------------------------------

interface PinnedDirectoryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

interface PinnedRepositoryIdentity {
  source: PinnedDirectoryIdentity;
  commonDirectory: PinnedDirectoryIdentity;
}

interface PinnedSandboxDestinationIdentity {
  parent: PinnedDirectoryIdentity;
  home: PinnedDirectoryIdentity;
  metadata: PinnedFileIdentity;
}

interface PinnedFileIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

function pinDirectoryIdentity(value: string): PinnedDirectoryIdentity | null {
  const path = canonicalFilesystemPathIdentity(value, { foldWindowsCase: false });
  if (!path) return null;
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink()
      ? { path, dev: stat.dev, ino: stat.ino }
      : null;
  } catch {
    return null;
  }
}

function directoryIdentityStillPinned(identity: PinnedDirectoryIdentity): boolean {
  try {
    const stat = lstatSync(identity.path, { bigint: true });
    return stat.isDirectory() && !stat.isSymbolicLink() &&
      stat.dev === identity.dev && stat.ino === identity.ino;
  } catch {
    return false;
  }
}

function pinFileIdentity(value: string): PinnedFileIdentity | null {
  const path = canonicalFilesystemPathIdentity(value, { foldWindowsCase: false });
  if (!path) return null;
  try {
    const stat = lstatSync(path, { bigint: true });
    return stat.isFile() && !stat.isSymbolicLink()
      ? { path, dev: stat.dev, ino: stat.ino }
      : null;
  } catch {
    return null;
  }
}

function fileIdentityStillPinned(identity: PinnedFileIdentity): boolean {
  try {
    const stat = lstatSync(identity.path, { bigint: true });
    return stat.isFile() && !stat.isSymbolicLink() &&
      stat.dev === identity.dev && stat.ino === identity.ino;
  } catch {
    return false;
  }
}

function pinGitCommonDirectory(sourceRepo: string): PinnedDirectoryIdentity | null {
  const commonDirectory = gitTry(sourceRepo, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  return commonDirectory ? pinDirectoryIdentity(commonDirectory) : null;
}

function repositoryIdentityStillPinned(identity: PinnedRepositoryIdentity): boolean {
  if (!directoryIdentityStillPinned(identity.source) ||
      !directoryIdentityStillPinned(identity.commonDirectory)) return false;
  const currentCommonDirectory = pinGitCommonDirectory(identity.source.path);
  return currentCommonDirectory !== null &&
    currentCommonDirectory.path === identity.commonDirectory.path &&
    currentCommonDirectory.dev === identity.commonDirectory.dev &&
    currentCommonDirectory.ino === identity.commonDirectory.ino;
}

function sandboxDestinationStillPinned(identity: PinnedSandboxDestinationIdentity): boolean {
  return directoryIdentityStillPinned(identity.parent) &&
    directoryIdentityStillPinned(identity.home) &&
    fileIdentityStillPinned(identity.metadata) &&
    dirname(identity.home.path) === identity.parent.path &&
    dirname(identity.metadata.path) === identity.home.path;
}

function createdWorktreeStillExact(
  sb: Sandbox,
  worktree: PinnedDirectoryIdentity,
  repository: PinnedRepositoryIdentity,
  destination: PinnedSandboxDestinationIdentity,
): boolean {
  const authorityStillExact = (): boolean =>
    directoryIdentityStillPinned(repository.source) &&
    directoryIdentityStillPinned(repository.commonDirectory) &&
    sandboxDestinationStillPinned(destination) &&
    directoryIdentityStillPinned(worktree) &&
    canonicalFilesystemPathIdentity(dirname(sb.worktreePath), { foldWindowsCase: false }) ===
      destination.home.path;
  if (!authorityStillExact()) return false;

  const state = parseWorktreeState(gitTry(sb.worktreePath, [...WORKTREE_STATE_ARGS]));
  if (!authorityStillExact() || !state) return false;
  const currentCommon = pinDirectoryIdentity(state.commonPath);
  return state.head === sb.baseHead && state.headRef === `refs/heads/${sb.branch}` &&
    currentCommon !== null &&
    currentCommon.path === repository.commonDirectory.path &&
    currentCommon.dev === repository.commonDirectory.dev &&
    currentCommon.ino === repository.commonDirectory.ino &&
    authorityStillExact();
}

function removePinnedSandboxHomeReservation(
  parent: PinnedDirectoryIdentity,
  home: PinnedDirectoryIdentity,
): boolean {
  if (!directoryIdentityStillPinned(parent) || !directoryIdentityStillPinned(home) ||
      dirname(home.path) !== parent.path) return false;
  try {
    rmSync(home.path, { recursive: true, force: true });
    return !existsSync(home.path);
  } catch {
    return false;
  }
}

function removePinnedSandboxReservation(identity: PinnedSandboxDestinationIdentity): boolean {
  if (!sandboxDestinationStillPinned(identity)) return false;
  try {
    rmSync(identity.home.path, { recursive: true, force: true });
    return !existsSync(identity.home.path);
  } catch {
    return false;
  }
}

/**
 * Create an isolated git-worktree sandbox of `sourceRepo` on a NEW scratch
 * branch under ~/.ashlr/sandboxes/<id>/.
 *
 * Pins the physical repository and Git common directory, then calls
 * assertMayMutate with that canonical physical repository.
 * Refuses (throws + audits result:'refused') if the kill switch is on OR the
 * repo is not enrolled and opts.allowAnyRepo is not set. Verifies sourceRepo
 * is a git repo. Reads the
 * source HEAD WITHOUT mutating it. Adds the worktree via
 * `git worktree add -b <branch> <path> <baseHead> --no-checkout` run in
 * sourceRepo, then checks it out — this MUST NOT modify the source working
 * tree, index, HEAD, or any user branch.
 *
 * ── TWO PHASES ────────────────────────────────────────────────────────────
 *
 * REGISTER (outward fence held; the daemon's callers also hold the repo
 * lease): policy gate, reservation, `worktree add --no-checkout`, validation
 * of the registration, in-place rollback on failure. Every effect on the
 * SOURCE repository's Git state — the new branch ref and the worktree's
 * administrative entry — happens here. Before dropping the fence it mints the
 * run's own-removal right and registers a creation EXECUTION LEASE, both
 * only possible under the fence with KILL off.
 *
 * POPULATE (neither lock; the creation lease held): the checkout, the
 * post-create writer, and validation again. These write only the new
 * worktree's files, its private index and its own HEAD reflog — what
 * `git worktree add` itself does after registering, by running exactly
 * `reset --hard --no-recurse-submodules` there. Kill and unenroll still see
 * the creation: they abort the lease and wait for its release, so they
 * cannot report quiescence while it runs. Any failure here — a validation,
 * the lease aborted, KILL armed or the repo unenrolled meanwhile (the gate is
 * re-checked) — rolls the registration back with the same pinned rollback,
 * after re-taking the repo lease (when the caller handed one over) and the
 * fence, under the own-removal right (so a KILL armed meanwhile cannot strand
 * the worktree); only then is the lease released.
 */
/**
 * How long sandbox creation waits for the global outward-mutation fence.
 *
 * `createSandbox` holds the fence across `git worktree add`, which runs INSIDE
 * the source repository and mutates its `.git`. That is a genuine critical
 * section and the fence must stay.
 *
 * ── WHY THIS IS SHORT AGAIN ───────────────────────────────────────────────
 *
 * It was briefly raised to 20s so concurrent agents would queue rather than
 * fail. That made things worse, because this wait is SYNCHRONOUS: the lock
 * spins on `Atomics.wait` (src/core/fleet/local-store-lock.ts) and
 * `createSandbox` is a synchronous function, so for the whole wait the Node
 * event loop runs NOTHING — not the hang watchdog, not the queue-lease
 * renewer (whose missed fence lets another machine steal the claim), not the
 * shutdown handler, not the operator's control plane. And the contending
 * holder is in the same process and holds the fence across awaits, so the
 * waiter could never win: it burned 20s of frozen loop per agent and failed
 * anyway. Four dispatched items meant up to a minute of dead loop per tick.
 *
 * So the synchronous path keeps a short wait and fails fast, and callers that
 * genuinely need to QUEUE use {@link createSandboxAsync}, which waits off the
 * event loop.
 */
const SANDBOX_FENCE_WAIT_MS = 2_000;

/**
 * How long {@link createSandboxAsync} waits. Generous, because this wait costs
 * nothing but the caller's own turn: the loop keeps running throughout.
 */
const SANDBOX_ASYNC_FENCE_WAIT_MS = 60_000;

/**
 * FIFO queue for in-process sandbox creation.
 *
 * The file lock alone is correct but not fair: N agents polling for it can
 * starve one another arbitrarily. Chaining creations in the order they were
 * requested makes the queue deterministic, and means the lock is contended by
 * at most one waiter from this process at a time. Only REGISTER is chained:
 * POPULATE holds neither lock, so concurrent creations overlap there.
 */
let sandboxCreationChain: Promise<unknown> = Promise.resolve();

/** Execution-lease engine label for a sandbox creation's POPULATE phase. */
export const SANDBOX_CREATION_LEASE_ENGINE = 'sandbox-create';

/**
 * Opt-in timing of one creation (ASHLR_SANDBOX_TIMING=1), written to stderr
 * as one `ashlr-sandbox-timing <json>` line for scripts/daemon-throughput.mjs.
 * Off, it is never constructed.
 */
class SandboxCreationClock {
  private last = performance.now();
  private fenceAcquiredAt: number | null = null;
  private readonly fields: Record<string, number> = {};
  private readonly parts: Record<string, number> = {};

  static start(): SandboxCreationClock | null {
    return process.env.ASHLR_SANDBOX_TIMING === '1' ? new SandboxCreationClock() : null;
  }

  mark(step: string): void {
    const now = performance.now();
    this.parts[step] = (this.parts[step] ?? 0) + (now - this.last);
    this.last = now;
  }

  runnerSteps(prefix: string, steps: Record<string, number> | undefined): void {
    for (const [step, ms] of Object.entries(steps ?? {})) {
      if (typeof ms === 'number') this.parts[`${prefix}.${step}`] = ms;
    }
  }

  fenceAcquired(): void {
    this.mark('fenceWait');
    this.fields.fenceWaitMs = this.parts.fenceWait ?? 0;
    this.fenceAcquiredAt = this.last;
  }

  fenceReleased(): void {
    if (this.fenceAcquiredAt !== null) this.fields.fenceHoldMs = performance.now() - this.fenceAcquiredAt;
    this.fenceAcquiredAt = null;
  }

  emit(ok: boolean): void {
    try {
      process.stderr.write(`ashlr-sandbox-timing ${JSON.stringify({ ok, ...this.fields, parts: this.parts })}\n`);
    } catch { /* diagnostics only */ }
  }
}

/**
 * The creation lock records this process's start identity, which costs one
 * `ps` spawn the first time it is read. Read it before taking the fence so
 * that spawn is not paid inside the critical section. A pure read of this
 * process's own identity (cached); the lock still verifies it when taken.
 */
function warmCreationLockOwnerIdentity(): void {
  try { currentStartRef(); } catch { /* the lock computes it again */ }
}

/** A sandbox whose worktree is registered (REGISTER done) but not yet checked out. */
interface RegisteredSandbox {
  readonly sb: Sandbox;
  readonly repository: PinnedRepositoryIdentity;
  readonly destination: PinnedSandboxDestinationIdentity;
  readonly worktree: PinnedDirectoryIdentity;
  readonly admin: PinnedAdministrativeDirectory;
  readonly removalRight: OwnSandboxRemovalRight;
  readonly lease: ExecutionLease;
  readonly gateOpts: { allowAnyRepo?: boolean } | undefined;
}

/**
 * Create a sandbox, waiting for the fence WITHOUT blocking the event loop.
 *
 * Same critical section, same policy gates, same audit — the only difference
 * is that agents 2..N of a concurrent dispatch await a promise instead of
 * freezing the process. This is the entry point the daemon's fleet path uses;
 * `createSandbox` remains for synchronous callers.
 *
 * `repoLease`: the caller's lease on this repository (lock order: repo lease
 * → fence). When given, it is RELEASED as soon as REGISTER is done — POPULATE
 * does not touch the source repository's Git state — and re-taken only to
 * roll a failed creation back. The caller's own release stays harmless
 * (RepoLease.release is idempotent).
 */
export async function createSandboxAsync(
  sourceRepo: string,
  opts?: { allowAnyRepo?: boolean; fenceWaitMs?: number; signal?: AbortSignal; repoLease?: RepoLease },
): Promise<Sandbox> {
  const waitMs = opts?.fenceWaitMs ?? SANDBOX_ASYNC_FENCE_WAIT_MS;
  const clock = SandboxCreationClock.start();
  let ok = false;
  try {
    const register = async (): Promise<RegisteredSandbox> => {
      warmCreationLockOwnerIdentity();
      clock?.mark('queue');
      const outwardFence = await acquireOutwardMutationFenceAsync(waitMs, {
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      if (!ownsOutwardMutationFence(outwardFence)) {
        releaseOutwardMutationFence(outwardFence);
        audit({
          action: 'sandbox:create',
          repo: sourceRepo,
          sandboxId: null,
          summary: `refused: outward mutation fence unavailable after ${waitMs}ms`,
          result: 'refused',
        });
        throw new Error(
          `outward mutation fence unavailable after waiting ${waitMs}ms; sandbox creation did not start`,
        );
      }
      clock?.fenceAcquired();
      try {
        return registerSandboxWhileFenced(sourceRepo, outwardFence, opts, clock);
      } finally {
        releaseOutwardMutationFence(outwardFence);
        clock?.fenceReleased();
      }
    };
    // Join the queue, and keep the chain alive whatever this creation does.
    const queued = sandboxCreationChain.then(register, register);
    sandboxCreationChain = queued.then(
      () => undefined,
      () => undefined,
    );
    const registered = await queued;
    let settled = false;
    try {
      // The source repository's Git state is final until a rollback. Release
      // unconditionally (idempotent): a lease whose lock was lost still holds
      // this process's FIFO turn, which the rollback would otherwise queue on.
      const handedLease = opts?.repoLease;
      handedLease?.release();
      const populated = await runPinnedWorktreeRunnerAsync(pinnedWorktreeRunnerInvocation(
        'populate', registered.repository, registered.destination, registered.sb, registered.worktree,
        registered.admin,
      ));
      clock?.mark('populate');
      clock?.runnerSteps('populate', populated.timing);
      const failure = populatedSandboxFailure(registered, populated);
      clock?.mark('verify');
      if (failure === null) {
        settled = true;
        ok = true;
        return completeRegisteredSandbox(registered);
      }
      await rollbackRegisteredSandboxAsync(registered, failure, handedLease?.repoKey ?? null, {
        fenceWaitMs: opts?.fenceWaitMs ?? SANDBOX_ASYNC_REMOVE_FENCE_WAIT_MS,
      });
      settled = true;
      clock?.mark('rollback');
      throw new Error(failure);
    } finally {
      settleRegisteredSandbox(registered, settled);
    }
  } finally {
    clock?.emit(ok);
  }
}

export function createSandbox(
  sourceRepo: string,
  opts?: { allowAnyRepo?: boolean; fenceWaitMs?: number },
): Sandbox {
  const waitMs = opts?.fenceWaitMs ?? SANDBOX_FENCE_WAIT_MS;
  const clock = SandboxCreationClock.start();
  let ok = false;
  try {
    warmCreationLockOwnerIdentity();
    const outwardFence = acquireOutwardMutationFence(waitMs);
    if (!ownsOutwardMutationFence(outwardFence)) {
      releaseOutwardMutationFence(outwardFence);
      audit({
        action: 'sandbox:create',
        repo: sourceRepo,
        sandboxId: null,
        summary: `refused: outward mutation fence unavailable after ${waitMs}ms`,
        result: 'refused',
      });
      throw new Error(
        `outward mutation fence unavailable after waiting ${waitMs}ms; sandbox creation did not start`,
      );
    }
    clock?.fenceAcquired();
    let registered: RegisteredSandbox;
    try {
      registered = registerSandboxWhileFenced(sourceRepo, outwardFence, opts, clock);
    } finally {
      releaseOutwardMutationFence(outwardFence);
      clock?.fenceReleased();
    }
    let settled = false;
    try {
      const populated = runPinnedWorktreeRunner(pinnedWorktreeRunnerInvocation(
        'populate', registered.repository, registered.destination, registered.sb, registered.worktree,
        registered.admin,
      ));
      clock?.mark('populate');
      clock?.runnerSteps('populate', populated.timing);
      const failure = populatedSandboxFailure(registered, populated);
      clock?.mark('verify');
      if (failure === null) {
        settled = true;
        ok = true;
        return completeRegisteredSandbox(registered);
      }
      // A synchronous caller that holds the repo lease still holds it here.
      const fence = acquireOutwardMutationFence(SANDBOX_FENCE_WAIT_MS);
      try {
        rollbackRegisteredSandboxWhileFenced(registered, failure, fence);
      } finally {
        releaseOutwardMutationFence(fence);
      }
      settled = true;
      clock?.mark('rollback');
      throw new Error(failure);
    } finally {
      settleRegisteredSandbox(registered, settled);
    }
  } finally {
    clock?.emit(ok);
  }
}

/**
 * Why a populated sandbox must not be handed out, or null when it may. Every
 * check REGISTER and the old single-phase creation made after the checkout
 * runs here, plus the gate again: POPULATE ran outside the fence, so KILL,
 * unenrollment or the caller's cancellation may have arrived meanwhile.
 */
function populatedSandboxFailure(registered: RegisteredSandbox, populated: PinnedWorktreeCreationResult): string | null {
  const { sb } = registered;
  if (!populated.ok) return populated.error ?? 'pinned worktree checkout failed';
  if (populated.worktreeDev !== String(registered.worktree.dev) ||
      populated.worktreeIno !== String(registered.worktree.ino) ||
      !createdWorktreeStillExact(sb, registered.worktree, registered.repository, registered.destination)) {
    return 'repository or sandbox identity changed after worktree creation';
  }
  if (registered.lease.signal.aborted) {
    return `sandbox creation stopped: ${registered.lease.abortReason() ?? 'execution lease aborted'}`;
  }
  try {
    assertMayMutate(sb.sourceRepo, registered.gateOpts);
  } catch (err) {
    return `sandbox creation stopped: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

function completeRegisteredSandbox(registered: RegisteredSandbox): Sandbox {
  const { sb } = registered;
  audit({
    action: 'sandbox:create',
    repo: sb.sourceRepo,
    sandboxId: sb.id,
    summary: `worktree on ${sb.branch} @ ${sb.baseHead.slice(0, 8)}`,
    result: 'ok',
  });
  registered.lease.release();
  return sb;
}

/**
 * Undo a registered creation that failed after REGISTER: the pinned rollback
 * (worktree, administrative entry, scratch branch) and then the reservation.
 * MUST hold the outward fence (and the repo lease, when the caller uses one).
 * Under KILL it runs only on the own-removal right minted at REGISTER — the
 * creation cleaning up its own scratch worktree, as removeSandboxAsync does.
 * Whatever it cannot finish keeps its owner metadata for dead-owner recovery.
 */
function rollbackRegisteredSandboxWhileFenced(
  registered: RegisteredSandbox,
  failure: string,
  fence: OutwardMutationFence | null,
): void {
  const { sb } = registered;
  audit({
    action: 'sandbox:create',
    repo: sb.sourceRepo,
    sandboxId: sb.id,
    summary: failure,
    result: 'error',
  });
  if (!ownsOutwardMutationFence(fence)) {
    abandonRegisteredSandbox(registered, 'rollback deferred: outward mutation fence unavailable');
    return;
  }
  if (!ownRemovalRightValid(registered.removalRight, sb)) {
    abandonRegisteredSandbox(registered, 'rollback deferred: own-removal right unavailable');
    return;
  }
  if (killSwitchOn()) {
    audit({
      action: 'sandbox:remove',
      repo: sb.sourceRepo,
      sandboxId: sb.id,
      summary: 'kill switch ON: rolling back a sandbox creation admitted before KILL (its own scratch worktree only)',
      result: 'ok',
    });
  }
  const rollback = runPinnedWorktreeRunner(pinnedWorktreeRunnerInvocation(
    'rollback', registered.repository, registered.destination, sb, registered.worktree, registered.admin,
  ));
  if (!rollback.cleanupComplete || !removePinnedSandboxReservation(registered.destination)) {
    abandonRegisteredSandbox(registered, 'rollback incomplete');
  }
}

/**
 * A failed creation that could not be rolled back here: audit it and mark its
 * owner metadata ABANDONED (ownerAlive() then reads false), so the next orphan
 * sweep or cap pre-sweep reclaims it through the ordinary removal path instead
 * of skipping it for as long as this live process runs. The sweep takes its
 * own fence and gate, so this grants nothing; a destination that is no longer
 * the one pinned at REGISTER is left alone.
 */
function abandonRegisteredSandbox(registered: RegisteredSandbox, reason: string): void {
  const { sb } = registered;
  let marked = false;
  if (sandboxDestinationStillPinned(registered.destination)) {
    try {
      writeMeta({ ...sb, abandonedAt: new Date().toISOString() });
      marked = true;
    } catch { /* the live-owner metadata stays; dead-owner recovery after exit */ }
  }
  audit({
    action: 'sandbox:create',
    repo: sb.sourceRepo,
    sandboxId: sb.id,
    summary: `${reason}; ${marked ? 'marked abandoned for the orphan sweep' : 'left for dead-owner recovery'}`,
    result: 'error',
  });
}

/**
 * Always runs when a registered creation ends, however it ends: drops the
 * creation lease (what kill / unenroll drain on) and forgets the creation's
 * own-removal right. A creation that ended before reaching its rollback (an
 * unexpected throw) is abandoned first, so it is not stranded either.
 */
function settleRegisteredSandbox(registered: RegisteredSandbox, settled: boolean): void {
  try {
    if (!settled) abandonRegisteredSandbox(registered, 'sandbox creation failed unexpectedly after registration');
  } finally {
    forgetOwnSandboxRemovalRight(registered.removalRight);
    registered.lease.release();
  }
}

async function rollbackRegisteredSandboxAsync(
  registered: RegisteredSandbox,
  failure: string,
  repoKey: string | null,
  opts: { fenceWaitMs: number },
): Promise<void> {
  // Lock order: repo lease, then fence. The caller's lease was released
  // after REGISTER, so take it again for the rollback's Git effects.
  let repoLease: RepoLease | null = null;
  if (repoKey !== null) {
    const leased = await acquireRepoLease(repoKey);
    if (!leased.ok) {
      audit({
        action: 'sandbox:create',
        repo: registered.sb.sourceRepo,
        sandboxId: registered.sb.id,
        summary: failure,
        result: 'error',
      });
      abandonRegisteredSandbox(registered, `rollback deferred: repo lease unavailable (${leased.reason})`);
      return;
    }
    repoLease = leased.lease;
  }
  try {
    const fence = await acquireOutwardMutationFenceAsync(opts.fenceWaitMs);
    try {
      rollbackRegisteredSandboxWhileFenced(registered, failure, fence);
    } finally {
      releaseOutwardMutationFence(fence);
    }
  } finally {
    repoLease?.release();
  }
}

/**
 * REGISTER. Runs with the outward fence held; returns with the worktree
 * registered and validated, the own-removal right minted and the creation
 * lease registered, or throws with everything it did rolled back (or, when
 * rollback could not finish, the owner metadata left for recovery).
 */
function registerSandboxWhileFenced(
  sourceRepo: string,
  outwardFence: OutwardMutationFence | null,
  opts: { allowAnyRepo?: boolean; signal?: AbortSignal } | undefined,
  clock: SandboxCreationClock | null,
): RegisteredSandbox {
  const sourceIdentity = pinDirectoryIdentity(sourceRepo);
  if (!sourceIdentity) {
    audit({
      action: 'sandbox:create',
      repo: sourceRepo,
      sandboxId: null,
      summary: 'source repository identity is unavailable',
      result: 'error',
    });
    throw new Error(`could not pin repository identity: ${sourceRepo}`);
  }
  const canonicalSourceRepo = sourceIdentity.path;
  const gateOpts = opts?.allowAnyRepo === undefined ? undefined : { allowAnyRepo: opts.allowAnyRepo };

  // Gate the pinned physical pathname before Git discovery. The retained
  // runner independently verifies this source inode before using its cwd, so
  // a pathname replacement cannot carry policy authority into Git effects.
  try {
    assertMayMutate(canonicalSourceRepo, gateOpts);
  } catch (err) {
    audit({
      action: 'sandbox:create',
      repo: canonicalSourceRepo,
      sandboxId: null,
      summary: 'refused by policy gate',
      result: 'refused',
    });
    throw err;
  }
  if (!directoryIdentityStillPinned(sourceIdentity)) {
    throw new Error('source repository identity changed during policy gate');
  }

  if (!isRepo(canonicalSourceRepo)) {
    audit({
      action: 'sandbox:create',
      repo: canonicalSourceRepo,
      sandboxId: null,
      summary: 'sourceRepo is not a git repository',
      result: 'error',
    });
    throw new Error(`not a git repository: ${canonicalSourceRepo}`);
  }
  const commonDirectoryIdentity = pinGitCommonDirectory(canonicalSourceRepo);
  if (!commonDirectoryIdentity) {
    audit({
      action: 'sandbox:create',
      repo: canonicalSourceRepo,
      sandboxId: null,
      summary: 'Git common directory identity is unavailable',
      result: 'error',
    });
    throw new Error(`could not pin Git common directory identity: ${canonicalSourceRepo}`);
  }
  const repositoryIdentity: PinnedRepositoryIdentity = {
    source: sourceIdentity,
    commonDirectory: commonDirectoryIdentity,
  };

  const cleanupAuthority = borrowSandboxCleanupAuthority(outwardFence);
  if (!cleanupAuthority) {
    throw new Error('outward mutation authority became invalid before sandbox creation');
  }

  // Read the source HEAD commit WITHOUT mutating it.
  const baseHead = gitTry(canonicalSourceRepo, ['rev-parse', 'HEAD']);
  if (!baseHead) {
    audit({
      action: 'sandbox:create',
      repo: canonicalSourceRepo,
      sandboxId: null,
      summary: 'could not resolve source HEAD',
      result: 'error',
    });
    throw new Error(`could not resolve HEAD in repo: ${canonicalSourceRepo}`);
  }
  if (!repositoryIdentityStillPinned(repositoryIdentity)) {
    throw new Error('repository or Git common directory identity changed while reading source HEAD');
  }
  clock?.mark('discover');

  // -------------------------------------------------------------------------
  // H5 CHANGE 4 — DISK/COUNT CAP (LOCAL-ONLY resource guard). When the live
  // sandbox count is at/over the cap, FIRST sweep crash-leftover orphans (NEVER a
  // live one — sweepOrphanSandboxes skips any sandbox whose ownerPid is still
  // alive regardless of age, and falls back to the ORPHAN_STALE_MS age guard only
  // for ones with no live owner; so a same-process in-flight worktree held by a
  // concurrent daemon swarm is protected here), then re-count; if STILL at/over
  // the cap, REFUSE (audit result:'refused' + throw a
  // clean error) rather than accumulate unboundedly. This removes NOTHING in-use
  // and opens no outward capability — it only bounds on-disk worktree growth so a
  // pathological crash/restart loop can never fill the disk. The cap is resolved
  // at call time (env-overridable; conservative default) — see maxSandboxes().
  const creationLock = acquireCleanupLock('creation');
  if (!creationLock) throw new Error('sandbox creation lock unavailable');
  let id: string;
  let branch: string;
  let worktreePath: string;
  let home: string;
  let sb: Sandbox;
  let destinationIdentity: PinnedSandboxDestinationIdentity;
  try {
    const cap = maxSandboxes();
    if (sandboxInventory().totalHomes >= cap) {
      sweepOrphanSandboxesWhileCreationLocked({
        staleMs: ORPHAN_STALE_MS,
        borrowedAuthority: cleanupAuthority,
      });
      if (sandboxInventory().totalHomes >= cap) {
        audit({
          action: 'sandbox:create', repo: canonicalSourceRepo, sandboxId: null,
          summary: `sandbox cap reached (MAX_SANDBOXES=${cap})`, result: 'refused',
        });
        throw new Error(`sandbox cap reached (MAX_SANDBOXES=${cap})`);
      }
    }

    // Reserve the home while holding the cross-process lock. Inventory counts
    // the reservation immediately, so another creator cannot pass the same cap.
    id = randomBytes(6).toString('hex');
    branch = `${BRANCH_PREFIX}${id}`;
    worktreePath = worktreePathFor(id);
    home = sandboxHome(id);
    const parentIdentity = pinDirectoryIdentity(sandboxesDir());
    if (!parentIdentity ||
        canonicalFilesystemPathIdentity(dirname(home), { foldWindowsCase: false }) !== parentIdentity.path) {
      throw new Error('could not pin sandbox destination parent identity');
    }
    mkdirSync(home, { recursive: false, mode: 0o700 });
    const homeIdentity = pinDirectoryIdentity(home);
    if (!homeIdentity || dirname(homeIdentity.path) !== parentIdentity.path) {
      throw new Error('could not pin sandbox destination home identity');
    }
    sb = {
      id,
      sourceRepo: canonicalSourceRepo,
      worktreePath,
      branch,
      baseHead,
      createdAt: new Date().toISOString(),
      ownerPid: process.pid,
    };

    // Publish durable owner-bearing recovery authority before another creator
    // or reservation sweep can observe this home outside creation serialization.
    // A crash after this point is handled by normal dead-owner recovery; a crash
    // during the atomic write leaves only a metadata-free pre-effect home.
    try {
      writeMeta(sb);
    } catch (err) {
      removePinnedSandboxHomeReservation(parentIdentity, homeIdentity);
      throw err;
    }
    const metadataIdentity = pinFileIdentity(metaPath(id));
    if (!metadataIdentity || dirname(metadataIdentity.path) !== homeIdentity.path) {
      removePinnedSandboxHomeReservation(parentIdentity, homeIdentity);
      throw new Error('could not pin sandbox reservation metadata identity');
    }
    destinationIdentity = {
      parent: parentIdentity,
      home: homeIdentity,
      metadata: metadataIdentity,
    };
    if (!repositoryIdentityStillPinned(repositoryIdentity) ||
        !sandboxDestinationStillPinned(destinationIdentity)) {
      removePinnedSandboxReservation(destinationIdentity);
      throw new Error('repository or sandbox destination identity changed before sandbox publication');
    }
  } finally {
    releaseCleanupLock(creationLock);
  }
  clock?.mark('reserve');

  // Add the isolated worktree on a NEW scratch branch off baseHead, run IN the
  // source repo. This does NOT touch the source working tree, index, HEAD, or
  // any user branch — it only creates a new ref + a separate (not yet checked
  // out) worktree.
  if (!repositoryIdentityStillPinned(repositoryIdentity) ||
      !sandboxDestinationStillPinned(destinationIdentity)) {
    removePinnedSandboxReservation(destinationIdentity);
    throw new Error('repository or sandbox destination identity changed before worktree creation');
  }
  const creation = runPinnedWorktreeRunner(pinnedWorktreeRunnerInvocation(
    'register', repositoryIdentity, destinationIdentity, sb, null, null,
  ));
  clock?.mark('register');
  clock?.runnerSteps('register', creation.timing);
  if (!creation.ok) {
    if (creation.cleanupComplete) {
      removePinnedSandboxReservation(destinationIdentity);
    }
    audit({
      action: 'sandbox:create',
      repo: canonicalSourceRepo,
      sandboxId: id,
      summary: creation.error ?? 'pinned worktree creation failed',
      result: 'error',
    });
    throw new Error(creation.error ?? 'pinned worktree creation failed');
  }
  const worktreeIdentity = creation.worktreeDev !== undefined && creation.worktreeIno !== undefined
    ? {
        path: sb.worktreePath,
        dev: BigInt(creation.worktreeDev),
        ino: BigInt(creation.worktreeIno),
      }
    : null;
  // Undo the registration in place while this fence is still held.
  function abandon(summary: string): never {
    const rollback = worktreeIdentity !== null
      ? runPinnedWorktreeRunner(pinnedWorktreeRunnerInvocation(
          'rollback', repositoryIdentity, destinationIdentity, sb, worktreeIdentity, null,
        ))
      : null;
    if (rollback?.cleanupComplete) removePinnedSandboxReservation(destinationIdentity);
    audit({
      action: 'sandbox:create',
      repo: canonicalSourceRepo,
      sandboxId: id,
      summary,
      result: 'error',
    });
    throw new Error(summary);
  }
  const adminIdentity: PinnedAdministrativeDirectory | null =
    creation.adminPath !== undefined && creation.adminDev !== undefined && creation.adminIno !== undefined
      ? { path: creation.adminPath, dev: creation.adminDev, ino: creation.adminIno }
      : null;
  if (!worktreeIdentity || !adminIdentity || !directoryIdentityStillPinned(worktreeIdentity) ||
      !directoryIdentityStillPinned(repositoryIdentity.source) ||
      !directoryIdentityStillPinned(repositoryIdentity.commonDirectory) ||
      !sandboxDestinationStillPinned(destinationIdentity)) {
    abandon('repository or sandbox identity changed after worktree creation');
  }

  // Authority for POPULATE, minted while the fence is held and KILL is off
  // (both refuse otherwise): the right to remove this sandbox even after a
  // KILL, and the lease that makes kill / unenroll wait for the checkout.
  const removalRight = mintOwnSandboxRemovalRight(outwardFence, sb);
  if (!removalRight) abandon('outward mutation authority became invalid during sandbox creation');
  let repoKey = canonicalSourceRepo;
  try {
    repoKey = canonicalEnrollmentPath(canonicalSourceRepo) ?? canonicalSourceRepo;
  } catch { /* the physical path is the lease key */ }
  const registration = registerExecutionLease(outwardFence, {
    runId: `sandbox-${id}`,
    repoKey,
    engine: SANDBOX_CREATION_LEASE_ENGINE,
    ...(opts?.signal ? { parentSignal: opts.signal } : {}),
    shouldAbort: () => {
      try {
        assertMayMutate(canonicalSourceRepo, gateOpts);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
  });
  if (!registration.ok) abandon(`sandbox creation lease unavailable: ${registration.reason}`);
  clock?.mark('authorize');
  return {
    sb,
    repository: repositoryIdentity,
    destination: destinationIdentity,
    worktree: worktreeIdentity,
    admin: adminIdentity,
    removalRight,
    lease: registration.lease,
    gateOpts,
  };
}

// ---------------------------------------------------------------------------
// sandboxDiff
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// M283: sandbox-infra files written by the fleet that must never appear in a
// proposal diff. These files are injected by ashlr for agent tool access and
// are meaningless to the judge/reviewer. Each entry is an exact filename
// relative to the worktree root (no glob, no path prefix).
//
// Why two layers?
//   Layer 1 (writeMcpConfigIfAvailable): registers each file in the worktree's
//     `.git/info/exclude` BEFORE the agent runs, so `git add -A` never stages it.
//   Layer 2 (here): pass `:(exclude)<file>` pathspecs to `git diff --staged` so
//     even if layer 1 failed (e.g. gitdir not writable) the file is still absent
//     from the captured patch and numstat. Belt-and-suspenders: either layer alone
//     is sufficient; both together make the guarantee unconditional.
//
// IMPORTANT: these exclusions apply ONLY to fleet-written files (ones that did not
// exist in the source repo before the run). A repo that already has its own
// `.mcp.json` is a legacy fleet-infra filename, while `.ashlr-fleet.mcp.json`
// is the current sidecar. If a repo has a legitimate tracked file with either
// name, the baseHead check below allows that edit through; otherwise new
// fleet-written infra is suppressed from the proposal diff.
// ---------------------------------------------------------------------------
const SANDBOX_INFRA_FILES = ['.mcp.json', '.ashlr-fleet.mcp.json', 'node_modules'] as const;

// ---------------------------------------------------------------------------
// V3.10 (INT4 — B-U2 request to U6): git on the agent-touched worktree
// ---------------------------------------------------------------------------

/**
 * Sandboxes whose capture MUST run through a verified `.git` (autonomous runs
 * under a standing policy mark theirs). In-process only: the daemon that
 * starts an autonomous run is the one that captures it.
 */
const verifiedGitRequired = new Set<string>();

/**
 * Require (or stop requiring) a verified `.git` for `sandboxId`'s capture.
 * WHY a mark and not a parameter: sandboxDiff has many callers (retry probes,
 * capture, partial-diff salvage); the run that knows it is autonomous marks
 * its sandbox once and every one of them is covered.
 */
export function requireVerifiedSandboxGit(sandboxId: string, required = true): void {
  if (required) verifiedGitRequired.add(sandboxId);
  else verifiedGitRequired.delete(sandboxId);
}

/** Thrown when an autonomous capture finds a `.git` the daemon did not create. */
export class SandboxGitVerificationError extends Error {
  constructor(reason: string) {
    super(`refusing to run git in the sandbox worktree: ${reason}`);
    this.name = 'SandboxGitVerificationError';
  }
}

const EMPTY_TREE_BY_FORMAT = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
} as const;

type AgentTreeGitContext =
  | { kind: 'verified'; file: string; prefix: string[]; workTree: string }
  | { kind: 'discovered'; prefix: string[] };

/**
 * The git dir the daemon created for this sandbox, found from the SOURCE
 * repo's common dir (`<common>/worktrees/<name>` whose back-link names this
 * worktree) — never from the worktree's own `.git`, which the agent could
 * have rewritten.
 */
function expectedSandboxGitDir(sb: Sandbox, workTreeReal: string): { gitDir: string; commonDir: string } | null {
  const common = gitTry(sb.sourceRepo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return null;
  let commonDir: string;
  try { commonDir = realpathSync(common); } catch { return null; }
  const expectedDotGit = join(workTreeReal, '.git');
  let names: string[];
  try { names = readdirSync(join(commonDir, 'worktrees')); } catch { return null; }
  for (const name of names) {
    const dir = join(commonDir, 'worktrees', name);
    try {
      const back = lstatSync(join(dir, 'gitdir'));
      if (!back.isFile() || back.isSymbolicLink() || back.size > 4096) continue;
      const named = readFileSync(join(dir, 'gitdir'), 'utf8').trim();
      if (resolve(dir, named) === expectedDotGit) return { gitDir: dir, commonDir };
    } catch { /* next */ }
  }
  return null;
}

function objectFormatOfCommonDir(commonDir: string): 'sha1' | 'sha256' {
  try {
    return /^\s*objectformat\s*=\s*sha256\s*$/im.test(readFileSync(join(commonDir, 'config'), 'utf8')) ? 'sha256' : 'sha1';
  } catch {
    return 'sha1';
  }
}

/**
 * How capture git runs on this sandbox's worktree.
 *  - verified: `.git` is exactly the pointer the daemon created (safe-git's
 *    verifyGitTarget); git runs as the trusted absolute binary with explicit
 *    --git-dir/--work-tree (nothing discovered from the tree) and safe-git's
 *    config set, which also reads gitattributes from the EMPTY tree — so no
 *    `.gitattributes` the agent wrote can route a file through a filter or
 *    diff driver during `add -A` / `diff`.
 *  - discovered (legacy, non-autonomous runs only): plain discovery, still with
 *    the empty-tree attributes and the forced config. An autonomous sandbox
 *    (requireVerifiedSandboxGit) that fails verification throws instead.
 */
function agentTreeGitContext(sb: Sandbox): AgentTreeGitContext {
  let reason = 'the worktree is missing';
  try {
    const workTree = realpathSync(sb.worktreePath);
    const expected = expectedSandboxGitDir(sb, workTree);
    if (expected) {
      const verified = verifyGitTarget({ workTree, gitDir: expected.gitDir, layout: 'linked' });
      if (verified.ok) {
        return {
          kind: 'verified',
          file: resolveGitExecutable(),
          workTree: verified.workTree,
          prefix: [
            ...safeGitConfigArgs([], objectFormatOfCommonDir(verified.commonDir)),
            `--git-dir=${verified.gitDir}`,
            `--work-tree=${verified.workTree}`,
          ],
        };
      }
      reason = verified.reason;
    } else {
      reason = 'no git dir created by the daemon names this worktree';
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  if (verifiedGitRequired.has(sb.id)) throw new SandboxGitVerificationError(reason);
  const format = gitTry(sb.worktreePath, ['rev-parse', '--show-object-format']) === 'sha256' ? 'sha256' : 'sha1';
  return { kind: 'discovered', prefix: [`--attr-source=${EMPTY_TREE_BY_FORMAT[format]}`] };
}

/** One capture git call in `cwd` (the agent-touched worktree). null on failure; never throws. */
function agentTreeGit(context: AgentTreeGitContext, cwd: string, args: string[]): string | null {
  if (context.kind === 'discovered') return gitTry(cwd, [...context.prefix, ...args]);
  sandboxGitRunFaultHookForTest?.(cwd, [...args]);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    // Nothing from the daemon's own env may redirect or reconfigure this call.
    if (key.startsWith('GIT_')) delete env[key];
  }
  try {
    return execFileSync(context.file, [...context.prefix, ...args], {
      cwd: context.workTree,
      env: withDaemonGitHardening({ ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }),
      timeout: GIT_TIMEOUT,
      stdio: 'pipe',
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Capture the git diff of the sandbox worktree vs its base HEAD. Read-only —
 * never mutates the worktree or the source repo. Counts come from --numstat;
 * the unified patch from a plain `git diff <baseHead>` inside the worktree.
 *
 * M283: fleet-written sandbox-infra files (SANDBOX_INFRA_FILES) are excluded
 * from the diff. See the constant above for the two-layer exclusion strategy.
 */
export function sandboxDiff(sb: Sandbox): SandboxDiff {
  const cwd = sb.worktreePath;
  // V3.10: every git call below runs on a tree an agent wrote. agentTreeGit
  // verifies `.git` against the git dir the daemon created and nulls every
  // configured program (hooks, fsmonitor, filter / textconv / external diff
  // drivers) — see agentTreeGitContext.
  const context = agentTreeGitContext(sb);
  const agentGit = (args: string[]): string | null => agentTreeGit(context, cwd, args);

  // Stage everything (including UNTRACKED new files) against the worktree's OWN
  // index so plain `git diff` captures new files too. `git diff` ignores
  // untracked files by design, and the autonomous write path writes files
  // without `git add`/`commit` — so without this, brand-new files an autonomous
  // run creates would be silently omitted from the captured proposal diff and
  // then DESTROYED by removeSandbox's `worktree remove --force`. Staging in the
  // SANDBOX worktree is safe: it touches only the worktree's index, never the
  // source repo's index/working-tree/HEAD (the worktree has its own index).
  // `add -A` records adds/mods/deletes; we then diff the index vs baseHead.
  agentGit(['add', '-A']);

  // M283 LAYER 2: build :(exclude) pathspecs for fleet-infra files that were NOT
  // present in the base commit. If the file existed at baseHead (the agent has a
  // legitimate edit), we allow it through; only fleet-written (new) files are
  // suppressed. `git cat-file -e <baseHead>:<file>` exits 0 iff the blob exists.
  const infraExcludeSpecs: string[] = [];
  for (const infraFile of SANDBOX_INFRA_FILES) {
    // Exit 0 → file exists at baseHead → agent may legitimately edit it → do NOT exclude.
    // Non-zero exit → file did NOT exist at baseHead → fleet-written → exclude from diff.
    if (agentGit(['cat-file', '-e', `${sb.baseHead}:${infraFile}`]) === null) {
      infraExcludeSpecs.push(`:(exclude)${infraFile}`);
    }
  }

  // numstat: one line per file "<ins>\t<del>\t<path>" (binary => "-\t-\t..").
  // `--staged` diffs the index (now including new files) against baseHead.
  // M283: append :(exclude) pathspecs after '--' to suppress fleet-infra files.
  // --no-ext-diff / --no-textconv: a configured external diff or textconv
  // driver is a program; the capture never runs one.
  const numstatArgs = ['diff', '--no-ext-diff', '--no-textconv', '--staged', '--numstat', sb.baseHead];
  if (infraExcludeSpecs.length > 0) numstatArgs.push('--', ...infraExcludeSpecs);
  const numstat = agentGit(numstatArgs) ?? '';
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 3) continue;
    files += 1;
    const ins = parseInt(parts[0] ?? '0', 10);
    const del = parseInt(parts[1] ?? '0', 10);
    if (!Number.isNaN(ins)) insertions += ins;
    if (!Number.isNaN(del)) deletions += del;
  }

  // Full unified patch — staged vs baseHead so new files are included.
  // M283: append :(exclude) pathspecs after '--' to suppress fleet-infra files.
  const patchArgs = ['diff', '--no-ext-diff', '--no-textconv', '--staged', sb.baseHead];
  if (infraExcludeSpecs.length > 0) patchArgs.push('--', ...infraExcludeSpecs);
  const patch = agentGit(patchArgs) ?? '';

  return {
    sandboxId: sb.id,
    files,
    insertions,
    deletions,
    patch,
  };
}

// ---------------------------------------------------------------------------
// removeSandbox
// ---------------------------------------------------------------------------

/**
 * Remove a sandbox: `git worktree remove --force` then delete the scratch
 * branch (`git branch -D`), both run against the source repo; then clean up
 * persisted metadata. MUST NOT touch the source working tree/index/HEAD/user
 * branches. Idempotent — tolerates an already-removed worktree, never throws
 * on a missing dir.
 */
function sandboxHomeState(home: string): SandboxCleanupPostcondition {
  if (!existsSync(home)) return 'absent';
  try {
    const stat = lstatSync(home);
    return stat.isSymbolicLink() || !stat.isDirectory() ? 'unsafe' : 'present';
  } catch {
    return 'unknown';
  }
}

/**
 * Resolve aliases for the longest existing prefix, then append the normalized
 * missing suffix. This keeps cleanup identity stable after a worktree vanishes
 * and across Windows long/8.3 path spellings. Windows path identity is
 * case-insensitive; other platforms retain their native case semantics.
 */
export function canonicalPathIdentity(value: string): string | null {
  return canonicalFilesystemPathIdentity(value);
}

function registrationState(repo: string, worktreePath: string): SandboxCleanupPostcondition {
  const raw = gitTry(repo, ['worktree', 'list', '--porcelain']);
  if (raw === null) return 'unknown';
  const target = canonicalPathIdentity(worktreePath);
  if (target === null) return 'unknown';
  const registered = raw.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => canonicalPathIdentity(line.slice('worktree '.length).trimEnd()) === target);
  return registered ? 'present' : 'absent';
}

function branchState(repo: string, branch: string): SandboxCleanupPostcondition {
  try {
    gitRun(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return 'present';
  } catch (error) {
    return (error as { status?: unknown }).status === 1 ? 'absent' : 'unknown';
  }
}

function worktreeBelongsToRepo(repo: string, worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false;
  const worktreeCommon = gitTry(worktreePath, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const repoCommon = gitTry(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (worktreeCommon === null || repoCommon === null) return false;
  const worktreeIdentity = canonicalPathIdentity(worktreeCommon);
  const repoIdentity = canonicalPathIdentity(repoCommon);
  return worktreeIdentity !== null && repoIdentity !== null && worktreeIdentity === repoIdentity;
}

function processStartRef(pid: number): string | undefined {
  try {
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', timeout: 1_000, maxBuffer: 1_024,
    });
    const value = result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
    return value && value.length <= 128 ? createHash('sha256').update(value).digest('hex') : undefined;
  } catch { return undefined; }
}

let ownStartRef: string | undefined;
function currentStartRef(): string | undefined {
  ownStartRef ??= processStartRef(process.pid) ?? createHash('sha256')
    .update(`${process.pid}:${Date.now() - performance.now()}`)
    .digest('hex');
  return ownStartRef;
}

function safelyUnlinkLock(path: string, expected: { dev: number; ino: number }): boolean {
  try {
    const current = lstatSync(path);
    if (current.isSymbolicLink() || !current.isFile() ||
      current.dev !== expected.dev || current.ino !== expected.ino ||
      (typeof process.getuid === 'function' && current.uid !== process.getuid())) return false;
    unlinkSync(path);
    return true;
  } catch { return false; }
}

function cleanupLockOwnerState(
  path: string,
  expected: { dev: number; ino: number },
): 'alive' | 'dead' | 'unknown' {
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size < 1 || opened.size > 160) {
      return 'unknown';
    }
    const bytes = Buffer.alloc(opened.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return 'unknown';
    const owner = JSON.parse(bytes.toString('utf8')) as { pid?: unknown; startRef?: unknown };
    if (!Number.isInteger(owner.pid) || Number(owner.pid) < 1 ||
      typeof owner.startRef !== 'string' || !/^[a-f0-9]{64}$/.test(owner.startRef)) return 'unknown';
    const pid = Number(owner.pid);
    try { process.kill(pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'alive'; }
    const observed = pid === process.pid ? currentStartRef() : processStartRef(pid);
    if (observed && observed !== owner.startRef) {
      const confirmed = processStartRef(pid);
      if (confirmed && confirmed !== owner.startRef) return 'dead';
    }
    return 'alive';
  } catch { return 'unknown'; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } } }
}

function acquireCleanupLock(id: string): { fd: number; path: string } | null {
  const root = sandboxesDir();
  const dir = join(root, '.cleanup-locks');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const candidate of [root, dir]) {
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory() ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return null;
      chmodSync(candidate, 0o700);
    }
  } catch { return null; }
  const path = join(dir, `${id}.lock`);
  const deadline = performance.now() + CLEANUP_LOCK_WAIT_MS;
  let unknown: { dev: number; ino: number; seenAt: number } | undefined;
  let attempt = 0;
  while (true) {
    try {
      const fd = openSync(
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      const stat = fstatSync(fd);
      if (!stat.isFile()) { closeSync(fd); return null; }
      const startRef = currentStartRef();
      if (!startRef) { closeSync(fd); safelyUnlinkLock(path, stat); return null; }
      try {
        const owner = Buffer.from(`${JSON.stringify({ pid: process.pid, startRef })}\n`, 'utf8');
        if (writeSync(fd, owner) !== owner.length) throw new Error('short cleanup lock write');
        fchmodSync(fd, 0o600);
        fsyncSync(fd);
      } catch {
        try { closeSync(fd); } catch { /* best effort */ }
        safelyUnlinkLock(path, stat);
        return null;
      }
      return { fd, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) return null;
        const state = cleanupLockOwnerState(path, stat);
        const now = performance.now();
        if (state === 'dead') {
          if (!safelyUnlinkLock(path, stat)) return null;
          unknown = undefined;
          continue;
        }
        if (state === 'unknown') {
          if (!unknown || unknown.dev !== stat.dev || unknown.ino !== stat.ino) {
            unknown = { dev: stat.dev, ino: stat.ino, seenAt: now };
          }
          if (now - unknown.seenAt >= CLEANUP_LOCK_INIT_MS) {
            if (!safelyUnlinkLock(path, stat)) return null;
            unknown = undefined;
            continue;
          }
        } else {
          unknown = undefined;
        }
      } catch { /* pathname changed; retry within the monotonic deadline */ }
      if (performance.now() >= deadline) return null;
      const remaining = deadline - performance.now();
      Atomics.wait(cleanupLockSleep, 0, 0, Math.min(remaining, 10 + (attempt % 7) * 5));
      attempt += 1;
    }
  }
}

function releaseCleanupLock(lock: { fd: number; path: string } | null | undefined): void {
  if (!lock) return;
  let snapshot: { dev: number; ino: number } | undefined;
  try { const stat = fstatSync(lock.fd); snapshot = { dev: stat.dev, ino: stat.ino }; } catch { /* best effort */ }
  try { closeSync(lock.fd); } catch { /* best effort */ }
  if (snapshot) safelyUnlinkLock(lock.path, snapshot);
}

function persistCleanupEvidence(sb: Sandbox, evidence: SandboxCleanupEvidence): boolean {
  try {
    const canonical = readMeta(sb.id);
    if (!canonical || sandboxHomeState(sandboxHome(sb.id)) !== 'present') return false;
    const { ownerPid: _ownerPid, ...rest } = canonical;
    writeMeta({ ...rest, cleanup: evidence });
    return true;
  } catch {
    return false;
  }
}

function cleanupAuthorityUnavailableResult(
  sb: Sandbox,
  reason: SandboxCleanupAuthorityLease['reason'],
): SandboxCleanupResult {
  const home = sandboxHomeState(sandboxHome(sb.id));
  const result: SandboxCleanupResult = {
    status: 'unavailable',
    postconditions: { registration: 'unknown', branch: 'unknown', home },
    failureClasses: ['cleanup-locked'],
    retryable: true,
    attempt: Math.min(1_000, (sb.cleanup?.attempt ?? 0) + 1),
    evidencePersisted: false,
  };
  audit({
    action: 'sandbox:remove',
    repo: sb.sourceRepo,
    sandboxId: sb.id,
    summary: reason === 'paused'
      ? 'cleanup deferred: autonomy kill switch is ON'
      : 'cleanup deferred: outward mutation authority unavailable',
    result: 'refused',
  });
  return result;
}

export function removeSandbox(
  sb: Sandbox,
  opts?: SandboxCleanupAuthorityOptions,
): SandboxCleanupResult {
  const authority = acquireSandboxCleanupAuthority(opts);
  if (!authority.allowed) return cleanupAuthorityUnavailableResult(sb, authority.reason);
  try {
    return removeSandboxWhileFenced(sb);
  } finally {
    releaseSandboxCleanupAuthority(authority);
  }
}

export function removeSandboxWithBorrowedAuthority(
  sb: Sandbox,
  borrowedAuthority: BorrowedSandboxCleanupAuthority | null,
): SandboxCleanupResult {
  return removeSandbox(sb, { borrowedAuthority });
}

// ---------------------------------------------------------------------------
// V3.10 (INT4 — B-U6 request 6): async removal, and a run's own sandbox after KILL
// ---------------------------------------------------------------------------

const ownRemovalRightBrand: unique symbol = Symbol('own-sandbox-removal-right');

/**
 * Proof that THIS process created `sandboxId` for a run admitted while KILL was
 * off. Minted only under the outward fence with KILL off; unforgeable (a
 * module-private brand plus a registry of minted objects).
 */
export interface OwnSandboxRemovalRight {
  readonly sandboxId: string;
  readonly pid: number;
  readonly [ownRemovalRightBrand]: true;
}

const mintedOwnRemovalRights = new WeakSet<object>();

/**
 * Mint the right for the run that owns `sb` to remove it later — even after a
 * Stop arms KILL. Null when the fence is not held or KILL is already on.
 *
 * WHY KILL does not strand it: KILL means "no new outward work"; removing a
 * run's OWN scratch worktree and its `ashlr/sandbox/*` branch is the run
 * cleaning up after itself (removeSandboxWhileFenced re-derives both from the
 * sandbox id and never touches a user branch). Refusing it only left the
 * worktree for an orphan sweep that also refuses under KILL — so every Stop
 * leaked one sandbox per running agent until Mason resumed.
 */
export function mintOwnSandboxRemovalRight(
  outwardFence: OutwardMutationFence | null | undefined,
  sb: Sandbox,
): OwnSandboxRemovalRight | null {
  if (!outwardFence || !ownsOutwardMutationFence(outwardFence) || killSwitchOn()) return null;
  if (!SANDBOX_ID_RE.test(sb.id)) return null;
  const right = Object.freeze({ sandboxId: sb.id, pid: process.pid, [ownRemovalRightBrand]: true as const });
  mintedOwnRemovalRights.add(right);
  return right;
}

/** Forget a minted right once the sandbox it names is gone or its creation ended. */
function forgetOwnSandboxRemovalRight(right: OwnSandboxRemovalRight | null | undefined): void {
  if (right) mintedOwnRemovalRights.delete(right);
}

function ownRemovalRightValid(right: OwnSandboxRemovalRight | null | undefined, sb: Sandbox): boolean {
  return right !== null && right !== undefined && mintedOwnRemovalRights.has(right) &&
    right[ownRemovalRightBrand] === true && right.sandboxId === sb.id && right.pid === process.pid;
}

/** How long async removal waits for the outward fence by default. */
export const SANDBOX_ASYNC_REMOVE_FENCE_WAIT_MS = 30_000;

/**
 * removeSandbox that waits for the outward fence WITHOUT blocking the event
 * loop (removeSandbox spins synchronously; with agents running concurrently
 * in this process the fence holder is usually another agent that can only
 * release it if the loop turns).
 *
 * Under KILL it removes the sandbox only with `ownRemovalRight` minted for it
 * (see mintOwnSandboxRemovalRight); otherwise it is deferred exactly like
 * removeSandbox ('paused').
 */
export async function removeSandboxAsync(
  sb: Sandbox,
  opts: { fenceWaitMs?: number; signal?: AbortSignal; ownRemovalRight?: OwnSandboxRemovalRight | null } = {},
): Promise<SandboxCleanupResult> {
  const waitMs = opts.fenceWaitMs ?? SANDBOX_ASYNC_REMOVE_FENCE_WAIT_MS;
  // The right names one sandbox; once that sandbox is gone it is spent.
  const forgetRightOnceRemoved = (result: SandboxCleanupResult): SandboxCleanupResult => {
    if (result.status === 'complete') forgetOwnSandboxRemovalRight(opts.ownRemovalRight);
    return result;
  };
  const fence = await acquireOutwardMutationFenceAsync(waitMs, opts.signal ? { signal: opts.signal } : undefined);
  if (!ownsOutwardMutationFence(fence)) {
    releaseOutwardMutationFence(fence);
    return cleanupAuthorityUnavailableResult(sb, 'authority-unavailable');
  }
  try {
    if (killSwitchOn()) {
      if (!ownRemovalRightValid(opts.ownRemovalRight, sb)) return cleanupAuthorityUnavailableResult(sb, 'paused');
      audit({
        action: 'sandbox:remove',
        repo: sb.sourceRepo,
        sandboxId: sb.id,
        summary: 'kill switch ON: removing the sandbox of a run admitted before KILL (its own scratch worktree only)',
        result: 'ok',
      });
      return forgetRightOnceRemoved(removeSandboxWhileFenced(sb));
    }
    const authority = mintSandboxCleanupAuthority(fence);
    if (!authority) return cleanupAuthorityUnavailableResult(sb, 'paused');
    return forgetRightOnceRemoved(removeSandboxWhileFenced(sb));
  } finally {
    verifiedGitRequired.delete(sb.id);
    releaseOutwardMutationFence(fence);
  }
}

function removeSandboxWhileFenced(sb: Sandbox): SandboxCleanupResult {
  const home = sandboxHome(sb.id);
  const attempt = Math.min(1_000, (sb.cleanup?.attempt ?? 0) + 1);

  // ---- Defense-in-depth: NEVER trust on-disk metadata to drive a destructive
  // git op. Metadata can be tampered/corrupted/future-format, so before ANY
  // mutating git call we (a) re-derive the safe branch + worktree path from the
  // sandbox id, (b) require the stored values to match those safe values, and
  // (c) require the branch to be inside our namespace and the worktree path to
  // be contained under sandboxesDir(). A trip on any guard refuses the git ops
  // (audited result:'refused') and preserves the recovery home. We NEVER run
  // `branch -D` / `worktree remove` against an arbitrary branch/path/repo.
  const safeBranch = `${BRANCH_PREFIX}${sb.id}`;
  const safeWorktree = worktreePathFor(sb.id);
  const sandboxesRoot = sandboxesDir() + sep;

  const branchInNamespace = sb.branch.startsWith(BRANCH_PREFIX);
  const branchMatches = sb.branch === safeBranch;
  const worktreeContained =
    resolve(sb.worktreePath).startsWith(sandboxesRoot) &&
    resolve(sb.worktreePath) === resolve(safeWorktree);

  const rootState = sandboxHomeState(sandboxesDir());
  const homeBefore = sandboxHomeState(home);
  const canonical = homeBefore === 'present' ? readMeta(sb.id) : null;
  const canonicalMatches = (
    canonical !== null &&
    canonical.id === sb.id &&
    canonical.sourceRepo === sb.sourceRepo &&
    canonical.worktreePath === sb.worktreePath &&
    canonical.branch === sb.branch &&
    canonical.baseHead === sb.baseHead
  );
  const worktreeSymlink = (() => {
    try { return lstatSync(safeWorktree).isSymbolicLink(); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : true; }
  })();
  const sourceRepoAvailable = isRepo(sb.sourceRepo);
  const registrationBefore = sourceRepoAvailable ? registrationState(sb.sourceRepo, safeWorktree) : 'unknown';
  const branchBefore = sourceRepoAvailable ? branchState(sb.sourceRepo, safeBranch) : 'unknown';
  const repoAuthority = existsSync(safeWorktree)
    ? worktreeBelongsToRepo(sb.sourceRepo, safeWorktree)
    : registrationBefore === 'present';
  const recoverableReservation = canonicalMatches && sourceRepoAvailable &&
    !existsSync(safeWorktree) && registrationBefore === 'absent' && branchBefore === 'absent';
  const guardsPass = branchInNamespace && branchMatches && worktreeContained &&
    rootState === 'present' && homeBefore === 'present' && canonicalMatches &&
    !worktreeSymlink && (!sourceRepoAvailable || repoAuthority || recoverableReservation);
  const lock = guardsPass ? acquireCleanupLock(sb.id) : undefined;
  let result: SandboxCleanupResult;

  if (homeBefore === 'absent' && branchInNamespace && branchMatches && worktreeContained &&
    rootState === 'present' && sourceRepoAvailable &&
    registrationBefore === 'absent' && branchBefore === 'absent') {
    result = {
      status: 'complete',
      postconditions: { registration: registrationBefore, branch: branchBefore, home: 'absent' },
      failureClasses: [],
      retryable: false,
      attempt,
      evidencePersisted: false,
    };
  } else if (!guardsPass) {
    result = {
      status: 'refused',
      postconditions: { registration: 'unknown', branch: 'unknown', home: homeBefore },
      failureClasses: ['unsafe-metadata'],
      retryable: false,
      attempt,
      evidencePersisted: false,
    };
  } else if (lock === null) {
    result = {
      status: 'unavailable',
      postconditions: { registration: 'unknown', branch: 'unknown', home: homeBefore },
      failureClasses: ['cleanup-locked'],
      retryable: true,
      attempt,
      evidencePersisted: false,
    };
  } else if (!sourceRepoAvailable) {
    result = {
      status: 'unavailable',
      postconditions: { registration: 'unknown', branch: 'unknown', home: homeBefore },
      failureClasses: ['source-repo-unavailable'],
      retryable: true,
      attempt,
      evidencePersisted: false,
    };
  } else {

  // 1. Remove the worktree registration from the source repo (best-effort).
  //    --force handles a dirty / committed-in worktree. Only attempted when the
  //    source repo still exists as a git repo AND the guards passed. We target
  //    the RE-DERIVED safe values, not the raw metadata.
    // `git worktree remove` also deletes the worktree directory. If the dir is
    // already gone, prune first so git's bookkeeping is consistent, then ignore.
    // Double force: a SIGKILL mid-`worktree add` (GIT_TIMEOUT, daemon kill)
    // leaves git's "initializing" lock, which single force and prune never
    // clear — the sandbox would be residual on every sweep, forever.
    gitTry(sb.sourceRepo, ['worktree', 'remove', '--force', '--force', safeWorktree]);
    gitTry(sb.sourceRepo, ['worktree', 'prune']);

    // 2. Delete the scratch branch (a sandbox-only ref — never a user branch).
    //    safeBranch is guaranteed to start with BRANCH_PREFIX.
    gitTry(sb.sourceRepo, ['branch', '-D', safeBranch]);
    const registration = registrationState(sb.sourceRepo, safeWorktree);
    const branch = branchState(sb.sourceRepo, safeBranch);
    const failureClasses: SandboxCleanupFailureClass[] = [];
    if (registration === 'present') failureClasses.push('worktree-remaining');
    if (branch === 'present') failureClasses.push('branch-remaining');
    if (registration === 'unknown' || branch === 'unknown') failureClasses.push('postcondition-unavailable');

    if (registration === 'absent' && branch === 'absent') {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* verified below */ }
    }
    const homeAfter = sandboxHomeState(home);
    if (homeAfter !== 'absent') failureClasses.push('home-remove-failed');
    const complete = registration === 'absent' && branch === 'absent' && homeAfter === 'absent';
    const retryable = !complete && (registration !== 'absent' || existsSync(safeWorktree));
    result = {
      status: complete ? 'complete' : (registration === 'unknown' || branch === 'unknown' ? 'unavailable' : 'residual'),
      postconditions: { registration, branch, home: homeAfter },
      failureClasses: [...new Set(failureClasses)],
      retryable,
      attempt,
      evidencePersisted: false,
    };
  }

  if (
    result.status !== 'complete' &&
    !result.failureClasses.includes('cleanup-locked') &&
    !result.failureClasses.includes('unsafe-metadata')
  ) {
    const evidence: SandboxCleanupEvidence = {
      schemaVersion: 1,
      attemptedAt: new Date().toISOString(),
      attempt,
      status: result.status,
      postconditions: result.postconditions,
      failureClasses: result.failureClasses,
      retryable: result.retryable,
    };
    result.evidencePersisted = persistCleanupEvidence(sb, evidence);
  }

  audit({
    action: 'sandbox:remove',
    repo: sb.sourceRepo,
    sandboxId: sb.id,
    summary: result.status === 'complete'
      ? `removed worktree + branch ${safeBranch}; postconditions verified`
      : result.status === 'refused'
        ? 'refused git cleanup: metadata failed branch-prefix/containment guard'
        : `cleanup status=${result.status} failures=${result.failureClasses.join(',') || 'none'}`,
    result: result.status === 'complete' ? 'ok' : result.status === 'refused' ? 'refused' : 'error',
  });
  releaseCleanupLock(lock);
  return result;
}

export function sandboxInventory(): SandboxInventory {
  const root = sandboxesDir();
  const inventory: SandboxInventory = { totalHomes: 0, validHomes: 0, malformedHomes: 0, unsafeEntries: 0 };
  if (!existsSync(root)) return inventory;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.name === '.cleanup-locks') continue;
      if (entry.name.startsWith('.')) { inventory.unsafeEntries += 1; continue; }
      if (!entry.isDirectory()) { inventory.unsafeEntries += 1; continue; }
      inventory.totalHomes += 1;
      if (readMeta(entry.name)) inventory.validHomes += 1;
      else inventory.malformedHomes += 1;
    }
  } catch { inventory.unsafeEntries += 1; }
  return inventory;
}

interface OwnedPathIdentity {
  dev: number;
  ino: number;
  mtimeMs: number;
}

interface ReservationFile {
  path: string;
  identity: OwnedPathIdentity;
}

type ReservationRecoveryStatus = 'complete' | 'skipped' | 'refused' | 'unavailable' | 'error';

function ownedDirectoryIdentity(path: string): OwnedPathIdentity | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return null;
    return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function samePathIdentity(path: string, expected: OwnedPathIdentity, directory: boolean): boolean {
  try {
    const stat = lstatSync(path);
    return !stat.isSymbolicLink() &&
      (directory ? stat.isDirectory() : stat.isFile()) &&
      stat.dev === expected.dev && stat.ino === expected.ino &&
      (typeof process.getuid !== 'function' || stat.uid === process.getuid());
  } catch {
    return false;
  }
}

function readReservationJson(file: ReservationFile): Record<string, unknown> | null | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== file.identity.dev || opened.ino !== file.identity.ino ||
      opened.size > 64 * 1024 ||
      (typeof process.getuid === 'function' && opened.uid !== process.getuid())) return undefined;
    const bytes = Buffer.alloc(opened.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return undefined;
    try {
      const value = JSON.parse(bytes.toString('utf8')) as unknown;
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
  }
}

function partialIdentitySafe(id: string, value: Record<string, unknown>): boolean {
  const canonicalWorktree = worktreePathFor(id);
  const canonicalBranch = `${BRANCH_PREFIX}${id}`;
  if (Object.prototype.hasOwnProperty.call(value, 'id') && value['id'] !== id) return false;
  if (Object.prototype.hasOwnProperty.call(value, 'worktreePath') &&
    (typeof value['worktreePath'] !== 'string' || resolve(value['worktreePath']) !== resolve(canonicalWorktree))) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'branch') && value['branch'] !== canonicalBranch) return false;
  if (Object.prototype.hasOwnProperty.call(value, 'ownerPid') &&
    (typeof value['ownerPid'] !== 'number' || !Number.isInteger(value['ownerPid']) || value['ownerPid'] <= 0)) {
    return false;
  }
  return true;
}

function safelyUnlinkReservationFile(file: ReservationFile): boolean {
  if (!samePathIdentity(file.path, file.identity, false)) return false;
  try {
    unlinkSync(file.path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reclaim one reservation that crashed before any Git effect. This deliberately
 * refuses homes containing a worktree or any unrecognized entry: incomplete
 * metadata is never promoted into authority to mutate a repository.
 */
function recoverReservationHome(id: string, staleMs: number | undefined, now: number): ReservationRecoveryStatus {
  if (!SANDBOX_ID_RE.test(id)) return 'refused';
  const root = sandboxesDir();
  const home = sandboxHome(id);
  const rootIdentity = ownedDirectoryIdentity(root);
  const homeIdentity = ownedDirectoryIdentity(home);
  if (!rootIdentity || !homeIdentity) return 'refused';

  const lock = acquireCleanupLock(id);
  if (!lock) return 'unavailable';
  try {
    if (!samePathIdentity(root, rootIdentity, true) || !samePathIdentity(home, homeIdentity, true)) {
      return 'refused';
    }
    // A creator may have completed metadata before this candidate acquired its
    // lock. Valid metadata always wins and is handled by the normal sweep path.
    if (readMeta(id)) return 'skipped';

    const entries = readdirSync(home, { withFileTypes: true });
    if (entries.length > 4) return 'refused';
    const files: ReservationFile[] = [];
    let freshestMs = homeIdentity.mtimeMs;
    for (const entry of entries) {
      if (entry.name === 'worktree') return 'refused';
      if (entry.name !== META_FILE && !META_TEMP_RE.test(entry.name)) return 'refused';
      const path = join(home, entry.name);
      let stat: ReturnType<typeof lstatSync>;
      try { stat = lstatSync(path); } catch { return 'refused'; }
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return 'refused';
      const file = { path, identity: { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs } };
      const partial = readReservationJson(file);
      if (partial === undefined) return 'refused';
      if (partial && !partialIdentitySafe(id, partial)) return 'refused';
      if (partial && pidAlive(partial['ownerPid'])) return 'skipped';
      if (partial && typeof partial['createdAt'] === 'string') {
        const createdMs = Date.parse(partial['createdAt']);
        if (!Number.isNaN(createdMs)) freshestMs = Math.max(freshestMs, createdMs);
      }
      freshestMs = Math.max(freshestMs, stat.mtimeMs);
      files.push(file);
    }

    const recoveryAgeMs = Math.max(staleMs ?? 0, RESERVATION_RECOVERY_MIN_AGE_MS);
    if (now - freshestMs < recoveryAgeMs) return 'skipped';
    if (!samePathIdentity(root, rootIdentity, true) || !samePathIdentity(home, homeIdentity, true) || readMeta(id)) {
      return 'refused';
    }
    for (const file of files) {
      if (!safelyUnlinkReservationFile(file)) return 'refused';
    }
    if (readdirSync(home).length !== 0 || !samePathIdentity(home, homeIdentity, true)) return 'refused';
    rmdirSync(home);
    if (existsSync(home)) return 'error';
    audit({
      action: 'sandbox:remove',
      repo: home,
      sandboxId: id,
      summary: 'reclaimed incomplete pre-effect sandbox reservation',
      result: 'ok',
    });
    return 'complete';
  } catch {
    return 'error';
  } finally {
    releaseCleanupLock(lock);
  }
}

function recoverReservationHomes(
  staleMs: number | undefined,
  now: number,
  result: SandboxSweepResult,
  creationLockHeld: boolean,
): void {
  const root = sandboxesDir();
  if (!ownedDirectoryIdentity(root)) return;
  const creationLock = creationLockHeld ? undefined : acquireCleanupLock('creation');
  if (!creationLockHeld && !creationLock) return;
  let ids: string[];
  try {
    ids = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SANDBOX_ID_RE.test(entry.name) && readMeta(entry.name) === null)
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_RESERVATION_RECOVERIES_PER_SWEEP);
  } catch {
    releaseCleanupLock(creationLock);
    return;
  }
  try {
    for (const id of ids) {
      const status = recoverReservationHome(id, staleMs, now);
      if (status === 'complete') result.completed.push(id);
      else if (status === 'refused') result.refused.push(id);
      else if (status === 'unavailable') result.unavailable.push(id);
      else if (status === 'error') result.unexpectedErrors.push(id);
    }
  } finally {
    releaseCleanupLock(creationLock);
  }
}

// ---------------------------------------------------------------------------
// listSandboxes
// ---------------------------------------------------------------------------

/**
 * Enumerate persisted sandbox metadata under sandboxesDir(). Returns [] when
 * none. Never throws on a malformed/partial entry (skips it).
 */
export function listSandboxes(): Sandbox[] {
  const dir = sandboxesDir();
  if (!existsSync(dir)) return [];

  let ids: string[];
  try {
    ids = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const out: Sandbox[] = [];
  for (const id of ids) {
    const sb = readMeta(id);
    if (sb) out.push(sb);
  }
  return out;
}

// ---------------------------------------------------------------------------
// sweepOrphanSandboxes (H2 — crash-recovery, LOCAL-ONLY)
// ---------------------------------------------------------------------------

/**
 * Sweep ORPHANED sandboxes on restart (H2 crash-recovery). A swarm creates a
 * worktree, uses it, then `removeSandbox`es it — all within a single in-memory
 * `runSwarm` call. The sandbox lifetime is NOT persisted on the SwarmRun (there
 * is no `sandboxId` field on a SwarmRun; the only `sandboxId` references are
 * audit-log entries), so a process killed AFTER `git worktree add` but BEFORE
 * `removeSandbox` leaves a worktree on disk under ~/.ashlr/sandboxes/<id>/ with
 * no record linking it back to any swarm. Such a leftover would otherwise
 * accumulate forever.
 *
 * LIVENESS (important — read before wiring a caller): a persisted sandbox is NOT
 * necessarily an orphan. A `runSwarm` keeps its sandbox metadata on disk for the
 * WHOLE run (createSandbox writes it at start, removeSandbox deletes it at the
 * end), and the daemon runs several sandboxed swarms CONCURRENTLY, each with a
 * live on-disk sandbox; a separately-launched `ashlr swarm` in another process is
 * also possible (the re-entrancy guards are per-process). To NEVER force-remove a
 * live worktree, the sweep uses TWO guards, in order:
 *
 *  1. POSITIVE liveness (primary, age-independent): a sandbox whose recorded
 *     `ownerPid` is still alive (ownerAlive()) is SKIPPED regardless of age — so
 *     a long-running swarm (same- OR cross-process) older than any staleMs is
 *     never reclaimed out from under its owner. This closes the central gap that
 *     createdAt-age alone could not (there is no wall-clock cap on a swarm).
 *  2. AGE fallback (secondary): for a sandbox with NO usable ownerPid (older
 *     metadata, or a crash fixture that models a GONE owner), the OPTIONAL
 *     `staleMs` guard applies — a sandbox whose `createdAt` is younger than
 *     `staleMs` is SKIPPED (conservatively assumed possibly-live). With NO
 *     `staleMs` (the default, used by recovery PROOF tests where every sandbox is
 *     a deliberately-dropped orphan with a dead/absent owner) it sweeps every
 *     listed sandbox not protected by guard 1.
 *
 * This sweep composes the two EXISTING safe primitives — `listSandboxes()` to
 * enumerate persisted sandbox metadata, then `removeSandbox()` for each — so it
 * inherits all of removeSandbox's containment guards verbatim: it only ever runs
 * `git worktree remove` / `git branch -D` against a path RE-DERIVED to live under
 * `sandboxesDir()` and a branch RE-DERIVED into the `ashlr/sandbox/<id>` namespace
 * (a metadata mismatch falls through to LOCAL dir cleanup only — never a git op on
 * an arbitrary branch/path). It therefore can NEVER touch a user's working tree,
 * index, HEAD, or any user branch.
 *
 * LOCAL-ONLY by construction: it adds NO outward capability (cleanup is purely
 * inward — it removes only ashlr/sandbox/* worktrees + scratch refs, pushes
 * nothing, opens no PR, applies no proposal), weakens NO guard (every removal
 * goes through removeSandbox's full guard set), and changes NO happy-path
 * behavior (a clean run already removes its own sandbox, so a healthy install
 * has nothing to sweep). H5 wires this into daemon start (loop.ts, staleMs=
 * ORPHAN_STALE_MS), the disk-cap pre-sweep above, and `ashlr sandbox gc` — every
 * caller passes a staleMs and is additionally protected by the age-independent
 * ownerAlive() guard, so no LIVE worktree is ever force-removed. Idempotent
 * and never throws — an unexpected removal exception is recorded so callers
 * cannot report a false-green sweep while cleanup continues for other ids.
 *
 * @param opts.staleMs Optional age guard (ms). Skip any sandbox whose `createdAt`
 *   is younger than this — a conservative liveness proxy so a concurrently-live
 *   sandbox is never force-removed. Omit to sweep all listed sandboxes.
 */
function sweepOrphanSandboxesDetailedInternal(
  opts?: { staleMs?: number } & SandboxCleanupAuthorityOptions,
  creationLockHeld = false,
): SandboxSweepResult {
  const staleMs = opts?.staleMs;
  const now = Date.now();
  const result: SandboxSweepResult = {
    completed: [], residual: [], refused: [], unavailable: [],
    inventory: sandboxInventory(), unexpectedErrors: [],
  };
  const authority = acquireSandboxCleanupAuthority(opts);
  try {
    if (authority.allowed) recoverReservationHomes(staleMs, now, result, creationLockHeld);
    for (const sb of listSandboxes()) {
    // GUARD 1 — POSITIVE liveness (age-independent): never reclaim a worktree
    // whose owning process is still alive, even if it is older than staleMs.
    // This is what makes the sweep safe despite the absence of a swarm
    // wall-clock cap — a live in-flight worktree (any process, any age) is
    // protected by its still-alive owner pid.
    if (ownerAlive(sb)) {
      continue;
    }
    // GUARD 2 — AGE fallback ONLY for a sandbox with no usable ownerPid (older
    // metadata / stripped marker). A recorded owner pid that is provably gone
    // (ownerAlive() false: ESRCH) is positive evidence of a crash leftover, so
    // it is reclaimed immediately. Holding it for ORPHAN_STALE_MS bought no
    // safety (a recycled pid reads ALIVE and is skipped by guard 1 anyway) and
    // let one or two daemon crashes fill MAX_SANDBOXES with dead-owner homes,
    // refusing every createSandbox for up to six hours after restart.
    if (staleMs !== undefined && !hasRecordedOwnerPid(sb)) {
      const createdMs = Date.parse(sb.createdAt);
      // Skip not-yet-stale sandboxes (possibly a live owner whose pid we could
      // not read). An unparseable createdAt is treated as stale=0
      // (Number.isNaN) so a corrupt timestamp is still reclaimable rather than
      // stranded forever.
      if (!Number.isNaN(createdMs) && now - createdMs < staleMs) {
        continue;
      }
    }
      if (!authority.allowed) {
        result.unavailable.push(sb.id);
        continue;
      }
      try {
        const cleanup = removeSandbox(sb, { borrowedAuthority: authority.token });
        result[cleanup.status === 'complete' ? 'completed' : cleanup.status].push(sb.id);
      } catch {
        // removeSandbox is already best-effort/idempotent and should not throw;
        // guard anyway so one bad entry never aborts the whole restart sweep.
        result.unexpectedErrors.push(sb.id);
      }
    }
  } finally {
    releaseSandboxCleanupAuthority(authority);
  }
  return result;
}

export function sweepOrphanSandboxesDetailed(
  opts?: { staleMs?: number } & SandboxCleanupAuthorityOptions,
): SandboxSweepResult {
  return sweepOrphanSandboxesDetailedInternal(opts);
}

function sweepOrphanSandboxesWhileCreationLocked(
  opts?: { staleMs?: number } & SandboxCleanupAuthorityOptions,
): string[] {
  return sweepOrphanSandboxesDetailedInternal(opts, true).completed;
}

export function sweepOrphanSandboxes(
  opts?: { staleMs?: number } & SandboxCleanupAuthorityOptions,
): string[] {
  return sweepOrphanSandboxesDetailed(opts).completed;
}

// ---------------------------------------------------------------------------
// sweepRepoSandboxes (H7 — scoped one-command rollback cleanup, LOCAL-ONLY)
// ---------------------------------------------------------------------------

/**
 * Reclaim the on-disk sandboxes belonging to ONE specific source repo — the
 * scoped cleanup behind `ashlr onboard --rollback <repo>` (H7 BUILD ITEM 4).
 *
 * WHY a distinct sweep (not sweepOrphanSandboxes): the generic orphan sweep is a
 * BACKGROUND restart heuristic — it protects a possibly-live owner whose pid is
 * unreadable by ALSO requiring `createdAt` to be older than `staleMs` (6h). But a
 * crash-leftover worktree from the VERY activation the user is now explicitly
 * undoing is, by definition, fresh (< 6h old), so the generic sweep would SKIP it
 * and the rollback would leave it on disk — contradicting "one-command undo of a
 * first activation". For an explicit, user-requested cleanup of a NAMED repo that
 * the user just unenrolled, the age heuristic is unwarranted.
 *
 * SAFETY (the real boundary is preserved): this drops ONLY the age guard, never
 * the LIVE-OWNER guard. It still SKIPS any sandbox whose recorded `ownerPid` is
 * still alive (ownerAlive()), so a running in-flight swarm's worktree is NEVER
 * force-removed — even a fresh one. It is SCOPED: only sandboxes whose
 * `sourceRepo` resolves to `resolve(repo)` are considered, so it never touches a
 * different repo's sandboxes. Each removal goes through removeSandbox(), so it
 * inherits the full branch-prefix / path-containment guards verbatim and can
 * NEVER touch a user's working tree, index, HEAD, or any user branch.
 *
 * LOCAL-ONLY by construction: adds NO outward capability (inward cleanup only —
 * removes only ashlr/sandbox/* worktrees + scratch refs), weakens NO guard.
 * Idempotent; never throws — unexpected failures are surfaced in the detailed
 * result while the sweep continues making progress on other ids.
 *
 * @param repo The source repo whose sandboxes to reclaim (resolved internally).
 */
export function sweepRepoSandboxesDetailed(
  repo: string,
  opts?: SandboxCleanupAuthorityOptions,
): SandboxSweepResult {
  const target = resolve(repo);
  const result: SandboxSweepResult = {
    completed: [], residual: [], refused: [], unavailable: [],
    inventory: sandboxInventory(), unexpectedErrors: [],
  };
  const authority = acquireSandboxCleanupAuthority(opts);
  try {
    for (const sb of listSandboxes()) {
    // SCOPE: only this repo's sandboxes.
    if (resolve(sb.sourceRepo) !== target) {
      continue;
    }
    // GUARD — POSITIVE liveness (the one guard we KEEP): never reclaim a
    // worktree whose owning process is still alive, regardless of age. A live
    // in-flight swarm (any age) is protected; the age guard is intentionally
    // dropped because this is an explicit user-requested cleanup of a just-
    // unenrolled repo, not a background restart heuristic.
    if (ownerAlive(sb)) {
      continue;
    }
      if (!authority.allowed) {
        result.unavailable.push(sb.id);
        continue;
      }
      try {
        const cleanup = removeSandbox(sb, { borrowedAuthority: authority.token });
        result[cleanup.status === 'complete' ? 'completed' : cleanup.status].push(sb.id);
      } catch {
        // removeSandbox is best-effort/idempotent; guard so one bad entry never
        // aborts the whole scoped sweep.
        result.unexpectedErrors.push(sb.id);
      }
    }
  } finally {
    releaseSandboxCleanupAuthority(authority);
  }
  return result;
}

export function sweepRepoSandboxes(repo: string, opts?: SandboxCleanupAuthorityOptions): string[] {
  return sweepRepoSandboxesDetailed(repo, opts).completed;
}
