import { describe, expect, it } from 'vitest';
import type { OutsideOverlap, OutsidePr } from './fleet-merges-model.js';
import { collisionHeadline, collisionSteerPrefill, orderOutsidePrs } from './outside-collision-model.js';

const overlap = (job: string, paths: string[]): OutsideOverlap => ({ job, paths });
const pr = (number: number, at: string | null, overlaps: OutsideOverlap[] = []): OutsidePr => ({
  repo: 'acme/widgets', number, title: 'A change', author: 'example', head: 'feature/example', at, files: 3, overlaps,
});

describe('outside PR collisions', () => {
  it('orders collisions by shared path count, then by date, without mutating the input', () => {
    const plain = pr(4, '2026-10-31T15:00:00Z');
    const small = pr(3, '2026-10-31T14:00:00Z', [overlap('RQ-FAKE-1', ['a'])]);
    const large = pr(2, '2026-10-31T10:00:00Z', [overlap('RQ-FAKE-2', ['a', 'b']), overlap('RQ-FAKE-3', ['c'])]);
    const old = pr(1, '2026-10-30T10:00:00Z');
    const input = [plain, small, old, large];
    expect(orderOutsidePrs(input)).toEqual([large, small, plain, old]);
    expect(input).toEqual([plain, small, old, large]);
  });

  it('reports collision counts and unread sources', () => {
    const collision = pr(1, null, [overlap('RQ-FAKE-1', ['a'])]);
    expect(collisionHeadline([], 'healthy')).toBe('No outside PR collides with running work');
    expect(collisionHeadline([collision], 'healthy')).toBe('1 outside PR touches files of running jobs');
    expect(collisionHeadline([collision, collision], 'healthy')).toBe('2 outside PRs touch files of running jobs');
    expect(collisionHeadline([collision], 'missing')).toBe('Outside PRs unread (gh missing)');
    expect(collisionHeadline([collision], 'degraded')).toBe('Outside PRs unread (degraded)');
  });

  it('includes the job, PR, author, branch, paths and decision in a single paragraph', () => {
    const shared = overlap('RQ-PHX-ABC31', ['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(collisionSteerPrefill(pr(42, null), shared)).toBe('Job RQ-PHX-ABC31 and outside PR #42 (example, feature/example) both change 3 files: src/a.ts, src/b.ts, src/c.ts. Decide: let the job finish, or pause it until the PR merges.');
  });

  it('limits long inputs to fewer than 600 characters and at most five paths', () => {
    const shared = overlap('RQ-FAKE-1', Array.from({ length: 50 }, (_, i) => `path-${i}-${'x'.repeat(120)}`));
    const text = collisionSteerPrefill(pr(42, null), shared);
    expect(text.length).toBeLessThan(600);
    expect(text).toContain('50 files');
    expect(text).toContain('path-0-');
    expect(text).not.toContain('path-5-');
    expect(text).toContain('Decide: let the job finish, or pause it until the PR merges.');
    expect(text).not.toMatch(/[\r\n]/);
  });
});
