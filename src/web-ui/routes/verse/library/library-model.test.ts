import { describe, expect, it } from 'vitest';
import { memorySummary, recentProjects, searchQueryValid } from './library-model.js';

const s = (projectPath: string, updatedAt: string) => ({ projectPath, updatedAt, createdAt: updatedAt });

describe('recentProjects', () => {
  it('dedupes by path, orders by newest session and counts chats', () => {
    const out = recentProjects([
      s('/tmp/fake-project/a', '2026-01-01T00:00:00Z'),
      s('/tmp/fake-project/b', '2026-01-03T00:00:00Z'),
      s('/tmp/fake-project/a', '2026-01-05T00:00:00Z'),
    ]);
    expect(out.map(p => [p.name, p.chats])).toEqual([['a', 2], ['b', 1]]);
  });
  it('respects the limit and ignores empty paths', () => {
    const many = Array.from({ length: 12 }, (_, i) => s(`/tmp/fake-project/p${i}`, `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
    expect(recentProjects([...many, s('', '2026-02-01T00:00:00Z')])).toHaveLength(8);
    expect(recentProjects(many, 3).map(p => p.name)).toEqual(['p11', 'p10', 'p9']);
  });
});

describe('memorySummary', () => {
  it('previews the first three non-empty lines, cut at 160 characters', () => {
    const m = memorySummary({ content: `\n# One\n\n${'x'.repeat(300)}\nthree\nfour\n`, bytes: 42 });
    expect(m.preview).toEqual(['# One', 'x'.repeat(160), 'three']);
    expect(m.lines).toBe(4);
    expect(m.bytes).toBe(42);
    expect(m.empty).toBe(false);
    expect(m.sanitized).toBe(false);
  });
  it('flags sanitized content', () => {
    expect(memorySummary({ content: 'a [REDACTED]', bytes: 12, contentSanitized: true }).sanitized).toBe(true);
  });
  it('treats blank content as empty', () => {
    expect(memorySummary({ content: ' \n\n', bytes: 3 })).toMatchObject({ empty: true, lines: 0, preview: [] });
  });
});

describe('searchQueryValid', () => {
  it('needs two trimmed characters', () => {
    expect(searchQueryValid('a')).toBe(false);
    expect(searchQueryValid('  a ')).toBe(false);
    expect(searchQueryValid(' ab ')).toBe(true);
  });
});
