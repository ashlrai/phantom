/**
 * test/h2.orphan-sandbox.test.ts — H2 BUILD task 3: NO-ORPHAN-SANDBOX.
 *
 * MILESTONE H2 "Harden & Prove" — CRASH RECOVERY & RESUMABILITY. A swarm killed
 * after `git worktree add` but before its `removeSandbox()` leaves a real
 * worktree + scratch branch on disk under ~/.ashlr/sandboxes/<id>/. This suite
 * proves the recovery surface can SURFACE and SWEEP that orphan:
 *
 *   - SURFACE: makeOrphanSandbox(repo) creates a REAL worktree then drops the
 *     handle; listSandboxes() must surface it (the orphan has persisted metadata
 *     but no live owner) — proving the orphan is detectable, not invisible.
 *   - SWEEP: the recovery path removes the orphan via the REAL removeSandbox
 *     (worktree remove --force + scratch branch -D), leaving NO worktree dir, NO
 *     scratch ref, and — paramount — NOT touching the SOURCE repo's working
 *     tree, index, HEAD, or user branches (shasumTree byte-identical, status
 *     clean, branch set unchanged).
 *   - GAP PROBED: does ANY production code actually sweep orphan sandboxes on
 *     restart, or do they accumulate forever? If none exists, CONTRACT-H2.md
 *     proposes a MINIMAL LOCAL-ONLY sweeper (listSandboxes -> removeSandbox for
 *     unowned ids) that adds NO outward capability.
 *
 * SAFETY: FRESH isolated tmp HOME; the worktree lives ONLY under the tmp
 * ~/.ashlr/sandboxes; the disposable SOURCE repo is the only repo touched and it
 * is asserted byte-unchanged. allowAnyRepo lets a tmp repo be sandboxed without
 * enrollment; it NEVER bypasses the kill switch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Observe removeSandbox's rmSync calls (the metadata-last ordering test); every
// call still goes to the real rmSync.
const rmObserver = vi.hoisted(() => ({ onRm: null as ((path: string) => void) | null }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const rmSync: typeof actual.rmSync = (path, options) => {
    rmObserver.onRm?.(String(path));
    actual.rmSync(path, options);
  };
  return { ...actual, rmSync, default: { ...actual, rmSync } };
});

import {
  removeSandbox,
  sweepOrphanSandboxes,
  sandboxesDir,
} from '../src/core/sandbox/worktree.js';
import {
  makeFixture,
  type H1Fixture,
  type DisposableRepo,
} from './helpers/h1-fixture.js';
import {
  makeOrphanSandbox,
  listOrphanSandboxes,
  sandboxHomeExists,
} from './helpers/h2-faults.js';

/** Short-name of the scratch branch a sandbox id maps to. */
function scratchBranch(id: string): string {
  return `ashlr/sandbox/${id}`;
}

let fx: H1Fixture;
let repo: DisposableRepo;

beforeEach(() => {
  // H2 false-green guard: every H2 it() MUST run at least one assertion. A
  // future empty-stub test (TODO body, zero expect) then FAILS loudly instead
  // of passing vacuously — the headline risk this milestone exists to disprove.
  expect.hasAssertions();
  fx = makeFixture();
  repo = fx.makeRepo();
});

afterEach(() => {
  fx.cleanup();
});

describe('H2 orphan sandbox — crash-leftover worktree is surfaced and swept', () => {
  it('an orphaned worktree (dropped handle) is surfaced by listSandboxes', () => {
    // A swarm killed after `git worktree add` but before removeSandbox() leaves a
    // real worktree on disk with no live owner. makeOrphanSandbox creates exactly
    // that: a REAL createSandbox then a dropped handle.
    const sb = makeOrphanSandbox(repo.dir);

    // The orphan must be DETECTABLE — on-disk home present + surfaced by the
    // store enumerator (not invisible / un-reclaimable).
    expect(sandboxHomeExists(sb.id)).toBe(true);

    const surfaced = listOrphanSandboxes();
    expect(surfaced.map((s) => s.id)).toContain(sb.id);

    // The surfaced metadata points at the real source repo + the namespaced
    // scratch branch — confirming it is a genuine worktree, not a phantom.
    const found = surfaced.find((s) => s.id === sb.id);
    expect(found?.sourceRepo).toBe(repo.dir);
    expect(found?.branch).toBe(scratchBranch(sb.id));

    // The orphan's scratch branch really exists in the SOURCE repo's ref set
    // (the worktree add created it) — so the sweep below has something to delete.
    expect(repo.branches()).toContain(scratchBranch(sb.id));
  });

  it('sweeping the orphan removes worktree + scratch branch with no source mutation', () => {
    // Snapshot the SOURCE repo BEFORE any sandbox op — the byte-for-byte baseline.
    const treeBefore = repo.shasumTree();
    const statusBefore = repo.gitStatus();
    const headBefore = repo.currentBranch();
    const userBranchesBefore = repo
      .branches()
      .filter((b) => !b.startsWith('ashlr/sandbox/'));

    const sb = makeOrphanSandbox(repo.dir);
    expect(sandboxHomeExists(sb.id)).toBe(true);
    expect(repo.branches()).toContain(scratchBranch(sb.id));

    // The REAL sweep: removeSandbox (git worktree remove --force + branch -D),
    // run against the source repo but targeting only the namespaced scratch ref.
    removeSandbox(sb);

    // Orphan fully reclaimed: no on-disk home, nothing left to surface.
    expect(sandboxHomeExists(sb.id)).toBe(false);
    expect(listOrphanSandboxes().map((s) => s.id)).not.toContain(sb.id);

    // The scratch branch is gone from the source repo's ref set...
    expect(repo.branches()).not.toContain(scratchBranch(sb.id));

    // ...and — paramount — the SOURCE repo is byte-identical: working tree hash,
    // porcelain status, checked-out branch, and the user's (non-scratch) branch
    // set are all exactly as before the orphan ever existed.
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe(statusBefore);
    expect(repo.currentBranch()).toBe(headBefore);
    expect(
      repo.branches().filter((b) => !b.startsWith('ashlr/sandbox/')),
    ).toEqual(userBranchesBefore);
  });

  it('the sweep is idempotent — re-sweeping an already-removed orphan never throws', () => {
    const treeBefore = repo.shasumTree();

    const sb = makeOrphanSandbox(repo.dir);
    removeSandbox(sb);
    expect(sandboxHomeExists(sb.id)).toBe(false);

    // A second removeSandbox on the SAME (now-gone) orphan is a pure no-op:
    // never throws, surfaces nothing, and leaves the source still byte-clean.
    expect(() => removeSandbox(sb)).not.toThrow();
    expect(sandboxHomeExists(sb.id)).toBe(false);
    expect(listOrphanSandboxes().map((s) => s.id)).not.toContain(sb.id);
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
  });

  it('GAP: a restart-time sweeper removes ALL unowned sandboxes', () => {
    // GAP PROBE: there is NO production caller that sweeps orphan sandboxes on
    // restart (a SwarmRun does not persist a sandboxId — the swarm creates, uses,
    // and removes its sandbox entirely in-memory), so a crash mid-swarm leaves a
    // worktree that would accumulate FOREVER. CONTRACT-H2.md GAP #3 sanctions a
    // MINIMAL LOCAL-ONLY fix: sweepOrphanSandboxes() = listSandboxes() ->
    // removeSandbox() over the ashlr/sandbox/* namespace, composing the two
    // existing safe primitives, adding NO outward capability and weakening NO
    // guard. This test exercises that recovery entry point.
    const treeBefore = repo.shasumTree();
    const userBranchesBefore = repo
      .branches()
      .filter((b) => !b.startsWith('ashlr/sandbox/'));

    // Simulate several crash-leftover orphans across two disposable repos.
    const repo2 = fx.makeRepo();
    const orphans = [
      makeOrphanSandbox(repo.dir),
      makeOrphanSandbox(repo.dir),
      makeOrphanSandbox(repo2.dir),
    ];
    for (const o of orphans) {
      expect(sandboxHomeExists(o.id)).toBe(true);
    }
    expect(listOrphanSandboxes()).toHaveLength(3);

    // The restart-time sweep reclaims EVERY unowned sandbox in one pass and
    // reports the ids it swept.
    const swept = sweepOrphanSandboxes();
    expect(swept.sort()).toEqual(orphans.map((o) => o.id).sort());

    // Nothing left: no homes on disk, store surfaces none.
    for (const o of orphans) {
      expect(sandboxHomeExists(o.id)).toBe(false);
    }
    expect(listOrphanSandboxes()).toHaveLength(0);

    // A re-sweep on a now-clean state is a no-op (idempotent restart safety).
    expect(sweepOrphanSandboxes()).toEqual([]);

    // Both source repos are byte-untouched: scratch branches gone, user branches
    // + working tree + status exactly as before.
    expect(repo.branches().some((b) => b.startsWith('ashlr/sandbox/'))).toBe(false);
    expect(repo2.branches().some((b) => b.startsWith('ashlr/sandbox/'))).toBe(false);
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
    expect(repo2.gitStatus()).toBe('');
    expect(
      repo.branches().filter((b) => !b.startsWith('ashlr/sandbox/')),
    ).toEqual(userBranchesBefore);
  });
  it('the staleMs guard SKIPS a not-yet-stale (possibly-live) sandbox — never force-removes a live worktree', () => {
    // SAFETY for any future restart wire-up (finding: the sweep has no pid/owner
    // field, only createdAt). A freshly-created sandbox could be an ACTIVELY
    // RUNNING swarm's worktree (a swarm keeps its sandbox on disk for the whole
    // run; the daemon runs several concurrently). With a conservative staleMs the
    // sweep must NOT reclaim a sandbox younger than the threshold.
    const treeBefore = repo.shasumTree();

    const fresh = makeOrphanSandbox(repo.dir); // createdAt = now (not stale yet)
    expect(sandboxHomeExists(fresh.id)).toBe(true);

    // A 1-hour staleness floor: the just-created sandbox is far younger, so a
    // restart-time sweep gated on staleMs leaves it ENTIRELY untouched.
    const swept = sweepOrphanSandboxes({ staleMs: 60 * 60 * 1000 });
    expect(swept).toEqual([]);
    expect(sandboxHomeExists(fresh.id)).toBe(true); // still on disk — not destroyed
    expect(repo.branches()).toContain(scratchBranch(fresh.id)); // scratch ref intact

    // Cleanup via the un-gated reclaim (proves it is still reclaimable later).
    expect(sweepOrphanSandboxes()).toContain(fresh.id);
    expect(sandboxHomeExists(fresh.id)).toBe(false);
    expect(repo.shasumTree()).toBe(treeBefore);
  });

  it('the staleMs guard RECLAIMS a sandbox older than the threshold (a genuine stale orphan)', () => {
    // A crash-leftover worktree that has aged past the threshold IS a true orphan
    // (no run could still be using a sandbox older than the max swarm wall-clock).
    // Age its persisted createdAt into the past, then prove a gated sweep reclaims
    // it (and only it) while leaving the source repo byte-identical.
    const treeBefore = repo.shasumTree();
    const userBranchesBefore = repo
      .branches()
      .filter((b) => !b.startsWith('ashlr/sandbox/'));

    const aged = makeOrphanSandbox(repo.dir);
    const fresh = makeOrphanSandbox(repo.dir);

    // Rewrite the aged sandbox's metadata createdAt to two hours ago (the store
    // re-reads createdAt at sweep time, so this is the exact field the guard
    // checks). Done through the SAME on-disk layout the store uses.
    const metaPath = join(sandboxesDir(), aged.id, 'sandbox.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { createdAt: string };
    meta.createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');

    // A 1-hour staleness floor: only the 2-hours-old orphan is reclaimed; the
    // just-created one is preserved as possibly-live.
    const swept = sweepOrphanSandboxes({ staleMs: 60 * 60 * 1000 });
    expect(swept).toEqual([aged.id]);
    expect(sandboxHomeExists(aged.id)).toBe(false); // stale orphan reclaimed
    expect(sandboxHomeExists(fresh.id)).toBe(true); // fresh one left alone

    // Source repo byte-identical; only the aged orphan's scratch ref is gone.
    expect(repo.branches()).not.toContain(scratchBranch(aged.id));
    expect(repo.branches()).toContain(scratchBranch(fresh.id));
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
    expect(
      repo.branches().filter((b) => !b.startsWith('ashlr/sandbox/')),
    ).toEqual(userBranchesBefore);

    // Cleanup the remaining fresh orphan.
    sweepOrphanSandboxes();
  });

  it('a crash-leftover worktree still holding git\'s "initializing" lock is reclaimed, not leaked forever', () => {
    // `git worktree add` writes .git/worktrees/<name>/locked ("initializing")
    // and unlinks it only after checkout. A SIGKILL mid-add (the pinned
    // supervisor's 30s GIT_TIMEOUT kills the git process group; a daemon kill)
    // leaves that lock behind. Single-force `worktree remove` refuses a locked
    // tree and `worktree prune` skips it, so every sweep reported residual and
    // the home counted toward MAX_SANDBOXES forever.
    const treeBefore = repo.shasumTree();
    const sb = makeOrphanSandbox(repo.dir);
    const gitdir = readFileSync(join(sb.worktreePath, '.git'), 'utf8').replace(/^gitdir:\s*/, '').trim();
    writeFileSync(join(gitdir, 'locked'), 'initializing\n', 'utf8');

    expect(sweepOrphanSandboxes()).toEqual([sb.id]);
    expect(sandboxHomeExists(sb.id)).toBe(false);
    expect(repo.branches()).not.toContain(scratchBranch(sb.id));
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
  });

  it('a removal killed between `worktree remove` and `branch -D` is finished by the sweep (scripts/daemon-chaos.mjs)', () => {
    // The chaos harness SIGKILLed an agent inside removeSandbox: the worktree
    // and its registration were gone, the scratch branch and the home were not.
    // With no worktree left to prove repo authority, every sweep refused the
    // home as unsafe metadata, so it leaked and counted against the cap forever.
    const treeBefore = repo.shasumTree();
    const sb = makeOrphanSandbox(repo.dir);
    git(repo.dir, ['worktree', 'remove', '--force', sb.worktreePath]);
    git(repo.dir, ['worktree', 'prune']);
    expect(repo.branches()).toContain(scratchBranch(sb.id));
    backdate(sb.id);

    expect(sweepOrphanSandboxes()).toEqual([sb.id]);
    expect(sandboxHomeExists(sb.id)).toBe(false);
    expect(repo.branches()).not.toContain(scratchBranch(sb.id));
    expect(repo.shasumTree()).toBe(treeBefore);
    expect(repo.gitStatus()).toBe('');
  });

  it('a stranded scratch branch under a minute old is kept (a creation may still be in flight)', () => {
    // `worktree add -b` creates the branch before it registers the worktree, so
    // a live createSandbox passes through this exact state. Only a record a
    // minute old is taken for a crash leftover.
    const sb = makeOrphanSandbox(repo.dir);
    git(repo.dir, ['worktree', 'remove', '--force', sb.worktreePath]);
    git(repo.dir, ['worktree', 'prune']);

    expect(sweepOrphanSandboxes()).toEqual([]);
    expect(sandboxHomeExists(sb.id)).toBe(true);
    expect(repo.branches()).toContain(scratchBranch(sb.id));
  });

  it('removeSandbox empties the home before its metadata, so the metadata is the last thing removed', () => {
    const sb = makeOrphanSandbox(repo.dir);
    const home = join(sandboxesDir(), sb.id);
    const metaFile = join(home, 'sandbox.json');
    mkdirSync(join(home, 'extra'), { recursive: true });
    writeFileSync(join(home, 'extra', 'note.txt'), 'x\n', 'utf8');
    const calls: Array<{ path: string; metaPresent: boolean }> = [];
    rmObserver.onRm = (path) => {
      if (path === home || path.startsWith(home + '/')) calls.push({ path, metaPresent: existsSync(metaFile) });
    };
    try {
      removeSandbox(sb);
    } finally {
      rmObserver.onRm = null;
    }
    expect(sandboxHomeExists(sb.id)).toBe(false);
    expect(calls.map((c) => c.path)).toContain(join(home, 'extra'));
    expect(calls.some((c) => c.path === metaFile)).toBe(false);
    const last = calls[calls.length - 1];
    expect(last?.path).toBe(home);
    expect(calls.every((c) => c.metaPresent)).toBe(true);
  });

  it('a home left holding only its metadata is reclaimed at once', () => {
    // The state a kill while removeSandbox empties the home leaves behind (it
    // removes the metadata last, see above): the restart sweep finishes it with
    // the ORPHAN_STALE_MS guard on (a metadata-free home would wait a minute).
    const sb = makeOrphanSandbox(repo.dir);
    git(repo.dir, ['worktree', 'remove', '--force', sb.worktreePath]);
    git(repo.dir, ['worktree', 'prune']);
    git(repo.dir, ['branch', '-D', scratchBranch(sb.id)]);
    const metaFile = join(sandboxesDir(), sb.id, 'sandbox.json');
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>;
    meta['ownerPid'] = deadPid();
    writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');

    expect(sweepOrphanSandboxes({ staleMs: 6 * 60 * 60_000 })).toEqual([sb.id]);
    expect(sandboxHomeExists(sb.id)).toBe(false);
  });

  it('a stranded scratch branch is NOT deleted when it does not descend from the recorded base', () => {
    // Fail closed: metadata pointing at another repository that happens to hold
    // a same-named branch with unrelated history proves nothing, so the branch
    // and the home are kept.
    const sb = makeOrphanSandbox(repo.dir);
    git(repo.dir, ['worktree', 'remove', '--force', sb.worktreePath]);
    git(repo.dir, ['worktree', 'prune']);
    const other = fx.makeRepo();
    // A root commit of its own (fixture repos made in the same second share
    // their seed commit, so a branch off `other`'s HEAD could descend from it).
    const unrelated = execFileSync('git', ['commit-tree', '-m', 'unrelated history', EMPTY_TREE], {
      cwd: other.dir, stdio: 'pipe', encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'h2', GIT_AUTHOR_EMAIL: 'h2@example.invalid', GIT_COMMITTER_NAME: 'h2', GIT_COMMITTER_EMAIL: 'h2@example.invalid' },
    }).trim();
    git(other.dir, ['branch', scratchBranch(sb.id), unrelated]);
    const metaFile = join(sandboxesDir(), sb.id, 'sandbox.json');
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>;
    meta['sourceRepo'] = other.dir;
    writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    backdate(sb.id); // old enough: only the ancestry check keeps it

    expect(sweepOrphanSandboxes()).toEqual([]);
    expect(sandboxHomeExists(sb.id)).toBe(true);
    expect(other.branches()).toContain(scratchBranch(sb.id));
  });
});

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Age a sandbox's record (createdAt, metadata and home mtimes) past the one-minute recovery floor. */
function backdate(id: string): void {
  const home = join(sandboxesDir(), id);
  const metaFile = join(home, 'sandbox.json');
  const old = new Date(Date.now() - 5 * 60_000);
  const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>;
  meta['createdAt'] = old.toISOString();
  writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  utimesSync(metaFile, old, old);
  utimesSync(home, old, old);
}

/** A pid that provably belonged to a process which has already exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid as number;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}
