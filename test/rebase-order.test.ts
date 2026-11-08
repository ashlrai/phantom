import { describe, expect, it } from 'vitest';
import { clusterKey, fileClusters } from '../src/core/fleet/rebase-order.js';

const item = (id: number, files: string[]) => ({ id, files });

describe('fileClusters', () => {
  it('groups transitively overlapping file sets into one cluster', () => {
    const got = fileClusters([
      item(1, ['src/a.ts']), item(2, ['src/a.ts', 'src/b.ts']),
      item(3, ['src/b.ts']), item(4, ['docs/z.md']),
    ]);
    expect(got.map((g) => g.map((g2) => g2.id))).toEqual([[1, 2, 3], [4]]);
  });

  it('keeps empty file sets as singletons that never merge', () => {
    const got = fileClusters([item(1, []), item(2, []), item(3, ['x'])]);
    expect(got.map((g) => g.map((g2) => g2.id))).toEqual([[1], [2], [3]]);
  });

  it('is deterministic under a deterministic input order', () => {
    const got = fileClusters([item(9, ['y']), item(2, ['x', 'y']), item(7, ['z'])]);
    expect(got.map((g) => g.map((g2) => g2.id))).toEqual([[9, 2], [7]]);
  });
});

describe('clusterKey', () => {
  it('is the lowest member id', () => {
    expect(clusterKey([41, 9, 12])).toBe('clu-9');
    expect(clusterKey([5])).toBe('clu-5');
  });
});
