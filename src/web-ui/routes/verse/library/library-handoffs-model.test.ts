import { describe, expect, it } from 'vitest';
import { handoffGroups, narrowHandoffs } from './library-handoffs-model.js';

const now = Date.parse('2026-01-02T12:00:00Z');
const row = { folder: 'alpha', name: 'note.md', size: 1024, modifiedAt: new Date(now - 60_000).toISOString(), preview: 'hello' };
const body = { v: 1, observedAt: new Date(now).toISOString(), handoffs: [row] };

describe('handoffs model', () => {
  it('accepts a valid body and rejects malformed bodies whole', () => {
    expect(narrowHandoffs(body)).toEqual(body);
    for (const bad of [
      { ...body, v: 2 }, { ...body, state: 'absent' },
      ...[{ folder: 'Bad folder' }, { name: 'a/b.md' }, { name: '..' }, { preview: 'x'.repeat(241) }].map((change) => ({ ...body, handoffs: [{ ...row, ...change }] })),
    ]) expect(narrowHandoffs(bad)).toBeNull();
  });

  it('orders groups and files by newest and formats ages and sizes', () => {
    const groups = handoffGroups([
      { ...row, folder: 'older', name: 'old.md', modifiedAt: new Date(now - 2 * 86_400_000).toISOString() },
      { ...row, name: 'hours.md', modifiedAt: new Date(now - 2 * 3_600_000).toISOString() },
      row,
      { ...row, name: 'new.md', modifiedAt: new Date(now).toISOString() },
    ], now);
    expect(groups.map((group) => group.folder)).toEqual(['alpha', 'older']);
    expect(groups[0].rows.map((item) => [item.label, item.age])).toEqual([['new', 'just now'], ['note', '1 min ago'], ['hours', '2 h ago']]);
    expect(groups[0].rows[0].size).toBe('1.0 KB');
    expect(groups[1].rows[0].age).toBe('2 d ago');
  });
});
