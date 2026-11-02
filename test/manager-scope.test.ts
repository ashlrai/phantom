/** Unit tests for the manager-scope helpers.

 * Both exported functions delegate to realpathSync.native and
 * goalProjectMatchesRepo, so we stub those to keep everything
 * in-memory — no fleet state, no git repos required.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks — must come before any source imports.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const fn = vi.fn(actual.realpathSync.native);
  return { ...actual, realpathSync: { native: fn } };
});
vi.mock('../src/core/goals/project-match.js', () => ({
  goalProjectMatchesRepo: vi.fn((_root: string, _target: string) => true),
}));

import * as fs from 'node:fs';
import { resolveManagerSessionTargets, managerSessionTargetsMatch } from '../src/core/verse/manager-scope.js';
import * as projectMatch from '../src/core/goals/project-match.js';

afterEach(() => { vi.restoreAllMocks(); });

const rp = () => vi.mocked(fs.realpathSync.native);
const gpm = () => vi.mocked(projectMatch.goalProjectMatchesRepo);

describe('resolveManagerSessionTargets', () => {
  it('returns sorted unique targets when one candidate matches per root (happy path)', () => {
    // All paths resolve to themselves; goalProjectMatchesRepo picks one per root.
    rp().mockImplementation((p: string) => p);
    // Only /mirror/x matches /root/a, only /mirror/y matches /root/b.
    gpm().mockImplementation(
      (root: string, target: string) => (root === '/root/a' && target === '/mirror/x') || (root === '/root/b' && target === '/mirror/y'),
    );
    const result = resolveManagerSessionTargets(
      ['/root/a', '/root/b'],
      ['/mirror/x', '/mirror/y'],
    );
    expect(result).toEqual(['/mirror/x', '/mirror/y']);
  });

  it.each`
    desc                       | roots       | enrolled
    ${'duplicate roots'}       | ${['/a', '/a']}  | ${['/x']}
    ${'duplicate enrolled'}    | ${['/a']}        | ${['/x', '/x']}
  `('returns null on duplicates — $desc', ({ roots, enrolled }) => {
    rp().mockImplementation((p: string) => p);
    expect(resolveManagerSessionTargets(roots, enrolled)).toBeNull();
  });

  it('returns null when no candidate matches a root (edge case)', () => {
    rp().mockImplementation((p: string) => p);
    // Nothing matches any root, so 0 candidates -> null.
    gpm().mockReturnValue(false);
    const result = resolveManagerSessionTargets(
      ['/root/a'],
      ['/mirror/x'],
    );
    expect(result).toBeNull();
  });

  it('returns null when multiple candidates match a single root (edge case)', () => {
    // /mirror/x matches root /root/a, and /mirror/y also matches root /root/a
    // so 2 candidates for one root -> null.
    rp().mockImplementation((p: string) => p);
    gpm().mockImplementation((root: string) => root === '/root/a');
    const result = resolveManagerSessionTargets(
      ['/root/a'],
      ['/mirror/x', '/mirror/y'],
    );
    expect(result).toBeNull();
  });
});

describe('managerSessionTargetsMatch', () => {
  it('returns true when mapped targets equal the provided ones (happy path)', () => {
    rp().mockImplementation((p: string) => p);
    gpm().mockImplementation(
      (root: string, target: string) => (root === '/root/a' && target === '/mirror/x') || (root === '/root/b' && target === '/mirror/y'),
    );
    const targets = ['/mirror/x', '/mirror/y'];
    expect(managerSessionTargetsMatch(
      ['/root/a', '/root/b'],
      ['/mirror/x', '/mirror/y'],
      targets,
    )).toBe(true);
  });

  it('returns false when mapped targets differ from provided ones (edge case)', () => {
    rp().mockImplementation((p: string) => p);
    gpm().mockImplementation(
      (root: string, target: string) => (root === '/root/a' && target === '/mirror/x') || (root === '/root/b' && target === '/mirror/y'),
    );
    expect(managerSessionTargetsMatch(
      ['/root/a', '/root/b'],
      ['/mirror/x', '/mirror/y'],
      ['/wrong/a'],
    )).toBe(false);
  });

  it('returns false when roots or enrolled are empty (edge case)', () => {
    rp().mockImplementation((p: string) => p);
    expect(managerSessionTargetsMatch(
      [],
      ['/mirror/x'],
      ['/mirror/x'],
    )).toBe(false);
    expect(managerSessionTargetsMatch(
      ['/root/a'],
      [],
      [],
    )).toBe(false);
  });
});
