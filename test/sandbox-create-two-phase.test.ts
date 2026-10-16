/**
 * Sandbox creation in two phases (src/core/sandbox/worktree.ts):
 * REGISTER (`worktree add --no-checkout` + validation) under the outward fence
 * and the repo lease, then POPULATE (checkout, post-create writer, validation)
 * outside both, holding only a creation execution lease.
 *
 * Pins the ordering this introduced:
 *  - POPULATE really runs without the fence and without the handed repo
 *    lease, while kill can still see it (one live execution lease);
 *  - KILL armed during POPULATE refuses the sandbox, rolls it back under the
 *    own-removal right, and only then lets kill reach quiescence;
 *  - a POPULATE failure (sync and async) rolls the registration back.
 *
 * REAL-IO: real git under an isolated tmp HOME, with a PATH shim that slows
 * or fails only the checkout (`reset --hard`). POSIX only (shell shim).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { makeFixture, type DisposableRepo, type H1Fixture } from './helpers/h1-fixture.js';
import {
  createSandbox,
  createSandboxAsync,
  listSandboxes,
  removeSandbox,
  sandboxesDir,
  sweepOrphanSandboxes,
} from '../src/core/sandbox/worktree.js';
import { acquireRepoLease, countLiveExecutionLeases } from '../src/core/sandbox/execution-leases.js';
import {
  acquireOutwardMutationFence,
  ownsOutwardMutationFence,
  releaseOutwardMutationFence,
} from '../src/core/sandbox/mutation-fence.js';
import { setKill } from '../src/core/sandbox/policy.js';
import { readAudit } from '../src/core/sandbox/audit.js';

const posix = process.platform !== 'win32';
const TIMEOUT = 60_000;

let fx: H1Fixture;
let repo: DisposableRepo;
let shimDir: string;
let marker: string;
let prevPath: string | undefined;
let prevAllow: string | undefined;

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** `checkout`: what the shim does to `reset --hard`: pass, sleep first, or fail. */
function installShim(checkout: 'slow' | 'fail' | 'slow-fail'): void {
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const script = join(shimDir, 'git');
  writeFileSync(script, [
    '#!/bin/sh',
    'for a in "$@"; do',
    '  if [ "$a" = "reset" ]; then',
    `    : > "${marker}"`,
    checkout === 'fail' ? '    exit 1' : checkout === 'slow' ? '    sleep 1.5' : '    sleep 1.5; exit 1',
    '  fi',
    'done',
    `exec "${realGit}" "$@"`,
    '',
  ].join('\n'));
  chmodSync(script, 0o755);
  process.env.PATH = `${shimDir}${delimiter}${prevPath ?? ''}`;
}

async function waitFor(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function sandboxBranches(): string[] {
  return git(repo.dir, ['branch', '--list', 'ashlr/sandbox/*']).split('\n').filter(Boolean);
}

function registeredWorktrees(): number {
  return git(repo.dir, ['worktree', 'list', '--porcelain'])
    .split('\n').filter((l) => l.startsWith('worktree ')).length - 1;
}

function sandboxHomes(): string[] {
  const root = sandboxesDir();
  return existsSync(root) ? readdirSync(root).filter((e) => !e.startsWith('.')) : [];
}

function expectNothingLeft(): void {
  expect(sandboxBranches()).toEqual([]);
  expect(registeredWorktrees()).toBe(0);
  expect(sandboxHomes()).toEqual([]);
  expect(countLiveExecutionLeases(null)).toBe(0);
}

beforeEach(() => {
  prevPath = process.env.PATH;
  prevAllow = process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  process.env.ASHLR_TEST_ALLOW_ANY_REPO = '1';
  fx = makeFixture();
  repo = fx.makeRepo();
  shimDir = mkdtempSync(join(tmpdir(), 'ashlr-two-phase-shim-'));
  marker = join(shimDir, 'checkout-started');
});

afterEach(() => {
  process.env.PATH = prevPath;
  if (prevAllow === undefined) delete process.env.ASHLR_TEST_ALLOW_ANY_REPO;
  else process.env.ASHLR_TEST_ALLOW_ANY_REPO = prevAllow;
  try { setKill(false, { waitMs: 500 }); } catch { /* fixture cleanup retries */ }
  fx.cleanup();
  rmSync(shimDir, { recursive: true, force: true });
});

describe.skipIf(!posix)('sandbox creation: REGISTER fenced, POPULATE outside the fence', () => {
  it('populates without the fence or the handed repo lease, visible to kill as one execution lease', async () => {
    installShim('slow');
    const leased = await acquireRepoLease(repo.dir);
    if (!leased.ok) throw new Error(leased.reason);
    const creating = createSandboxAsync(repo.dir, { allowAnyRepo: true, repoLease: leased.lease });
    await waitFor(() => existsSync(marker));

    // The checkout is running: the fence is free, the repo lease was handed
    // back, and kill would see exactly one live lease (this creation).
    const fence = acquireOutwardMutationFence(0);
    expect(ownsOutwardMutationFence(fence)).toBe(true);
    releaseOutwardMutationFence(fence);
    expect(leased.lease.isHeld()).toBe(false);
    expect(countLiveExecutionLeases(null)).toBe(1);

    const sb = await creating;
    try {
      // Checked out: files beyond the .git link, and a clean status.
      expect(readdirSync(sb.worktreePath).some((e) => e !== '.git')).toBe(true);
      expect(git(sb.worktreePath, ['status', '--porcelain'])).toBe('');
      expect(git(sb.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(sb.branch);
      expect(countLiveExecutionLeases(null)).toBe(0);
    } finally {
      removeSandbox(sb);
    }
    leased.lease.release();
  }, TIMEOUT);

  it('KILL armed during populate refuses the sandbox, rolls it back, then lets kill quiesce', async () => {
    installShim('slow');
    const creating = createSandboxAsync(repo.dir, { allowAnyRepo: true });
    const settled = creating.then(() => null, (e: Error) => e);
    await waitFor(() => existsSync(marker));

    // Kill cannot claim quiescence while the checkout runs: its lease is live.
    const armed = setKill(true, { waitMs: 2_000 });
    expect(armed.quiesced).toBe(false);

    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toMatch(/sandbox creation stopped/u);
    // Rolled back under KILL by the own-removal right minted at REGISTER.
    expectNothingLeft();
    const audits = readAudit();
    expect(audits.some((a) => a.action === 'sandbox:remove' &&
      /rolling back a sandbox creation admitted before KILL/u.test(a.summary ?? ''))).toBe(true);
    expect(setKill(true, { waitMs: 2_000 }).quiesced).toBe(true);
  }, TIMEOUT);

  it('a failed checkout outside the fence rolls the registration back (sync)', () => {
    installShim('fail');
    expect(() => createSandbox(repo.dir, { allowAnyRepo: true })).toThrow(/git worktree checkout failed/u);
    expect(existsSync(marker)).toBe(true);
    expectNothingLeft();
    expect(readAudit().some((a) => a.action === 'sandbox:create' && a.result === 'error' &&
      /git worktree checkout failed/u.test(a.summary ?? ''))).toBe(true);
  }, TIMEOUT);

  it('a failed checkout re-takes the released repo lease to roll back, then frees it (async)', async () => {
    installShim('fail');
    const leased = await acquireRepoLease(repo.dir);
    if (!leased.ok) throw new Error(leased.reason);
    await expect(createSandboxAsync(repo.dir, { allowAnyRepo: true, repoLease: leased.lease }))
      .rejects.toThrow(/git worktree checkout failed/u);
    expectNothingLeft();
    // Nothing still holds the repo's lease.
    const again = await acquireRepoLease(repo.dir, { waitMs: 1_000 });
    expect(again.ok).toBe(true);
    if (again.ok) again.lease.release();
  }, TIMEOUT);

  it('a rollback that cannot get the fence marks the sandbox abandoned so the sweep reclaims it', async () => {
    installShim('slow-fail');
    const creating = createSandboxAsync(repo.dir, { allowAnyRepo: true, fenceWaitMs: 500 });
    const settled = creating.then(() => null, (e: Error) => e);
    await waitFor(() => existsSync(marker));
    // Hold the fence across the failed checkout's rollback.
    const fence = acquireOutwardMutationFence(2_000);
    expect(ownsOutwardMutationFence(fence)).toBe(true);
    let error: Error | null;
    try {
      error = await settled;
    } finally {
      releaseOutwardMutationFence(fence);
    }
    expect(error?.message).toMatch(/git worktree checkout failed/u);
    expect(readAudit().some((a) => a.action === 'sandbox:create' &&
      /rollback deferred: outward mutation fence unavailable; marked abandoned/u.test(a.summary ?? ''))).toBe(true);
    expect(countLiveExecutionLeases(null)).toBe(0);

    // Owned by this live process, yet not stranded: the next sweep reclaims it.
    const left = listSandboxes();
    expect(left).toHaveLength(1);
    expect(left[0]!.ownerPid).toBe(process.pid);
    expect(left[0]!.abandonedAt).toEqual(expect.any(String));
    expect(sweepOrphanSandboxes()).toEqual([left[0]!.id]);
    expectNothingLeft();
  }, TIMEOUT);
});
