import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeChunk } from '../src/core/types.js';
import { retrieve } from '../src/core/knowledge/ask.js';

const base = 'http://localhost:11434';
const chunk = (file: string, text = 'unrelated', vector?: number[]): KnowledgeChunk =>
  ({ repo: '/fixture/repo', file, text, startLine: 1, endLine: 10, vector });

function embeddings(value: unknown = [1, 0]): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    expect(url.startsWith(base)).toBe(true);
    expect(url.endsWith('/api/tags') || url.endsWith('/api/embeddings')).toBe(true);
    return {
      ok: true,
      json: async () => url.endsWith('/api/tags')
        ? { models: [{ name: 'nomic-embed-text' }] } : { embedding: value },
    };
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('retrieval evidence 31p', () => {
  it('fuses lexical exact coverage with semantics without rewarding repeated tokens', async () => {
    embeddings();
    const result = await retrieve('widget repair', [
      chunk('semantic.ts', 'fix component', [0.9, 0.1]),
      chunk('exact.ts', 'widget repair', [0, 1]),
      chunk('spam.ts', 'widget '.repeat(500)),
      chunk('filler.ts'),
    ], base);
    expect(result.hits.map((h) => h.chunk.file)).toEqual(['exact.ts', 'semantic.ts', 'spam.ts']);
    expect(result.hits.every((h) => Number.isFinite(h.score) && h.score > 0 && h.score <= 1)).toBe(true);
    expect(result.method).toBe('embedding');
  });

  it('deduplicates locations before the budget and deterministically resolves ties', async () => {
    const first = chunk('a.ts', 'widget');
    const input = [...Array.from({ length: 12 }, () => first),
      ...Array.from({ length: 10 }, (_, i) => chunk('b' + i + '.ts', 'widget'))];
    const result = await retrieve('widget', input, base);
    expect(result.hits).toHaveLength(8);
    expect(new Set(result.hits.map((h) => h.chunk.file)).size).toBe(8);
    expect(await retrieve('widget', [...input].reverse(), base)).toEqual(result);

  });

  it('rejects invalid chunk vectors but keeps their lexical evidence', async () => {
    embeddings();
    const bad = [[NaN, 0], [Infinity, 1], [1], [], [0, 0], ['1', 0], new Array(2)];
    const input = bad.map((vector, i) => chunk('bad' + i + '.ts', 'unrelated', vector as number[]));
    input.push(chunk('lexical.ts', 'widget', [NaN, 0]), chunk('valid.ts', 'unrelated', [1, 0]));
    const result = await retrieve('widget', input, base);
    expect(result.hits.map((h) => h.chunk.file)).toEqual(['lexical.ts', 'valid.ts']);
    expect(result.hits[0].method).toBe('keyword');
  });

  it.each([[], [NaN, 0], [Infinity, 0], ['1', 0], [0, 0], null])(
    'falls back for malformed query embedding %j', async (vector) => {
      embeddings(vector);
      const result = await retrieve('widget', [chunk('yes.ts', 'widget', [1, 0]), chunk('no.ts')], base);
      expect(result.method).toBe('keyword');
      expect(result.hits.map((h) => h.chunk.file)).toEqual(['yes.ts']);
      expect(result.hits[0].score).toBe(1);
    },
  );

  it('keeps lexical fallback on local embedding failure and returns no zero-relevance filler', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const input = [chunk('yes.ts', 'widget', [1, 0]), chunk('no.ts', 'unrelated', [0, 1])];
    expect((await retrieve('widget', input, base)).hits).toHaveLength(1);
    expect((await retrieve('absent', input, base)).hits).toEqual([]);
    expect((await retrieve('', input, base)).hits).toEqual([]);
    expect((await retrieve('widget', [], base)).hits).toEqual([]);
  });

  it('preserves lexical fallback when the embedding POST fails after model discovery', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: url.endsWith('/api/tags'),
      json: async () => ({ models: [{ name: 'nomic-embed-text' }] }),
    })));
    const result = await retrieve('widget', [chunk('yes.ts', 'widget', [1, 0])], base);
    expect(result.method).toBe('keyword');
    expect(result.hits[0].score).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('drops zero and negative cosine and handles huge finite coordinates', async () => {
    embeddings([Number.MAX_VALUE, 0]);
    const result = await retrieve('absent', [
      chunk('positive.ts', 'unrelated', [Number.MAX_VALUE, 0]),
      chunk('negative.ts', 'unrelated', [-1, 0]),
      chunk('orthogonal.ts', 'unrelated', [0, 1]),
      chunk('mismatch.ts', 'unrelated', [1]),
    ], base);
    expect(result.hits.map((h) => h.chunk.file)).toEqual(['positive.ts']);
    expect(result.hits[0].score).toBe(0.5);
  });

  it('applies context size before returning sources and skips entries that cannot fit', async () => {
    const result = await retrieve('widget', [
      chunk('a'.repeat(6100), 'widget'),
      ...Array.from({ length: 10 }, (_, i) => chunk('file' + i, 'widget '.repeat(200))),
    ], base);
    expect(result.hits).toHaveLength(8);
    expect(result.hits.every((h) => h.chunk.file.length < 100)).toBe(true);
    expect(result.hits.reduce((sum, { chunk: c }) =>
      sum + ('[' + c.repo + '] ' + c.file + ':' + c.startLine + '-' + c.endLine + '\n' + c.text.slice(0, 600)).length, 0))
      .toBeLessThanOrEqual(6000);
  });
});
