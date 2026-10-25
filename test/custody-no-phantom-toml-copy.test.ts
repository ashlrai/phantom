/**
 * design-custody-fleet.md decision 1 (Option B): `.phantom.toml` is never
 * copied into a sandbox worktree. Phantom derives the vault namespace from the
 * checkout directory, so a copied config would open a different, empty vault.
 * Spawns there are recorded as unwrapped instead (custody-unwrapped-fleet).
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSandbox, removeSandbox } from '../src/core/sandbox/worktree.js';
import { acquireOutwardMutationFence, releaseOutwardMutationFence } from '../src/core/sandbox/mutation-fence.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

let fx: H1Fixture;
beforeEach(() => {
  fx = makeFixture();
  const fence = acquireOutwardMutationFence();
  if (!fence) throw new Error('fixture could not prepare sandbox authority root');
  releaseOutwardMutationFence(fence);
});
afterEach(() => { fx.cleanup(); });

describe('sandbox worktrees never receive .phantom.toml', () => {
  it('an untracked .phantom.toml in the source checkout is not copied into the worktree', () => {
    const repo = fx.makeRepo();
    repo.enroll();
    writeFileSync(join(repo.dir, '.phantom.toml'), '[phantom]\n');
    writeFileSync(join(repo.dir, '.env'), 'PLACEHOLDER=phm_test\n');
    const sb = createSandbox(repo.dir);
    try {
      expect(existsSync(sb.worktreePath)).toBe(true);
      expect(existsSync(join(sb.worktreePath, '.phantom.toml'))).toBe(false);
      expect(existsSync(join(sb.worktreePath, '.env'))).toBe(false);
      expect(readdirSync(sb.worktreePath).filter((n) => n.startsWith('.phantom'))).toEqual([]);
    } finally {
      expect(removeSandbox(sb).status).toBe('complete');
    }
  }, 45_000);
});
