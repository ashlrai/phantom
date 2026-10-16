/**
 * Repo-lease waits must survive a transient 'unavailable' lock outcome.
 *
 * A 1 ms acquire attempt that races another process's lock install / release
 * handoff reports 'unavailable' instead of 'contended' (measured by
 * scripts/daemon-throughput.mjs: ~1 in 3 contended attempts). The keyed
 * wait in src/core/sandbox/execution-leases.ts used to treat a single such
 * round as a permanently unusable store, so a concurrent agent failed its
 * worktree creation / proposal filing with "repo lease store unavailable"
 * while the lease was merely busy. A store that STAYS unusable must still
 * fail fast instead of burning the whole wait.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outcome = vi.hoisted(() => ({ forcedUnavailable: 0, alwaysUnavailable: false }));

vi.mock('../src/core/fleet/local-store-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/fleet/local-store-lock.js')>();
  return {
    ...actual,
    acquireLocalStoreLockWithOutcome: (...args: Parameters<typeof actual.acquireLocalStoreLockWithOutcome>) => {
      if (outcome.alwaysUnavailable || outcome.forcedUnavailable > 0) {
        outcome.forcedUnavailable -= 1;
        return { state: 'unavailable' as const, lock: null };
      }
      return actual.acquireLocalStoreLockWithOutcome(...args);
    },
  };
});

import { acquireRepoLease } from '../src/core/sandbox/execution-leases.js';

let home: string;
const previousHome = process.env.HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'repo-lease-unavailable-'));
  process.env.HOME = home;
  outcome.forcedUnavailable = 0;
  outcome.alwaysUnavailable = false;
});

afterEach(() => {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('acquireRepoLease under transient unavailable outcomes', () => {
  it('keeps waiting through a transient unavailable round and acquires the lease', async () => {
    outcome.forcedUnavailable = 2;
    const leased = await acquireRepoLease('/tmp/some-repo', { waitMs: 5_000, pollMs: 10 });
    expect(leased).toMatchObject({ ok: true });
    if (leased.ok) leased.lease.release();
  });

  it('still fails fast as unavailable when the store stays unusable', async () => {
    outcome.alwaysUnavailable = true;
    const started = Date.now();
    const leased = await acquireRepoLease('/tmp/some-repo', { waitMs: 60_000, pollMs: 50 });
    expect(leased).toEqual({ ok: false, reason: 'repo lease store unavailable' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
