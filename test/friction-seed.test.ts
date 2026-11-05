import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('friction seed', () => {
  it('keeps ranked items and distinguishes unavailable history from zero', () => {
    const seed = JSON.parse(readFileSync('data/friction-seed.json', 'utf8'));
    expect(seed.items.map((item: { id: string }) => item.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `F${i + 1}`),
    );
    expect(seed.history.countsRecomputed).toBe(false);
    for (const item of seed.items) {
      expect(item.count7d).toBeNull();
      expect(item.issue).toBeTruthy();
      expect(item.fix).toBeTruthy();
    }
  });
});
