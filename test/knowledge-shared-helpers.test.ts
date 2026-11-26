/**
 * Regression coverage for consolidated shared helpers in src/core/knowledge/.
 *
 * Covers the deduplicated vector/embedding helpers (index.ts ↔ ask.ts),
 * chunksFile path parity (index.ts ↔ wiki/ask.ts), wiki link stripping
 * (wiki/citations.ts ↔ wiki/render.ts ↔ cli/wiki.ts), line counting
 * (wiki/facts.ts ↔ wiki/generate.ts), and eligible map-file filtering
 * (system-map-facts.ts ↔ brain.ts / system-map.ts).
 */
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  chunksFile,
  detectEmbeddingModel,
  fetchEmbedding,
  isValidVector,
  knowledgeDir,
} from '../src/core/knowledge/index.js';
import { stripWikiLinks } from '../src/core/knowledge/wiki/citations.js';
import { countLines } from '../src/core/knowledge/wiki/facts.js';
import { isEligibleMapFile } from '../src/core/knowledge/wiki/system-map-facts.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('knowledge shared embedding & vector helpers', () => {
  it('validates vectors consistently for both indexing and retrieval', () => {
    expect(isValidVector([0.25, -0.5, 1])).toBe(true);
    expect(isValidVector([0, 0])).toBe(true);
    expect(isValidVector([0, 0], { requireNonZero: true })).toBe(false);
    expect(isValidVector([0, 1], { requireNonZero: true })).toBe(true);

    // Rejects empty, sparse, non-finite, non-numeric, and oversized vectors.
    const sparse = new Array<number>(2);
    expect(isValidVector([])).toBe(false);
    expect(isValidVector(sparse)).toBe(false);
    expect(isValidVector([NaN, 1])).toBe(false);
    expect(isValidVector([Infinity, 0])).toBe(false);
    expect(isValidVector(['1', 2])).toBe(false);
    expect(isValidVector(Array(16_385).fill(1))).toBe(false);
    expect(isValidVector(null)).toBe(false);
  });

  it('detectEmbeddingModel picks the matching local hint and degrades cleanly on error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3.2:latest' }, { name: 'nomic-embed-text:latest' }] }),
    })));
    await expect(detectEmbeddingModel('http://127.0.0.1:11434/')).resolves.toEqual({
      available: true,
      model: 'nomic-embed-text:latest',
    });

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    await expect(detectEmbeddingModel('http://127.0.0.1:11434')).resolves.toEqual({ available: false });

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(detectEmbeddingModel('http://127.0.0.1:11434')).resolves.toEqual({ available: false });
  });

  it('fetchEmbedding truncates prompts, enforces requireNonZero, and rejects malformed vectors', async () => {
    let sentPrompt = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      sentPrompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt;
      return { ok: true, json: async () => ({ embedding: [0, 0] }) };
    }));

    expect(await fetchEmbedding('http://127.0.0.1:11434', 'nomic-embed', 'x'.repeat(2500))).toEqual([0, 0]);
    expect(sentPrompt).toHaveLength(2000);
    expect(
      await fetchEmbedding('http://127.0.0.1:11434', 'nomic-embed', 'query', {
        timeoutMs: 1000,
        requireNonZero: true,
      }),
    ).toBeNull();
  });

  it('chunksFile resolves equivalent paths to the same chunks.jsonl under knowledgeDir()', () => {
    const dir = path.join(os.tmpdir(), 'knowledge-chunks-path-fixture');
    const a = chunksFile(dir);
    const b = chunksFile(`${dir}${path.sep}`);
    expect(a).toBe(b);
    expect(a.startsWith(knowledgeDir() + path.sep)).toBe(true);
    expect(path.basename(a)).toBe('chunks.jsonl');
  });
});

describe('wiki shared citation, line-count, and system-map helpers', () => {
  it('stripWikiLinks strips #cite: and #page: targets while preserving normal markdown links', () => {
    const input = 'See [src/a.ts:10-20](#cite:src/a.ts:10-20), [Overview](#page:overview), and [Docs](https://example.com).';
    expect(stripWikiLinks(input)).toBe('See src/a.ts:10-20, Overview, and [Docs](https://example.com).');
  });

  it('countLines handles empty text and trailing newlines consistently', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('one')).toBe(1);
    expect(countLines('one\n')).toBe(1);
    expect(countLines('one\ntwo')).toBe(2);
    expect(countLines('one\ntwo\n')).toBe(2);
  });

  it('isEligibleMapFile admits safe JS/TS paths and rejects unsafe or non-source paths', () => {
    expect(isEligibleMapFile('src/core/app.ts')).toBe(true);
    expect(isEligibleMapFile('src/ui/Card.tsx')).toBe(true);
    expect(isEligibleMapFile('scripts/run.mjs')).toBe(true);
    expect(isEligibleMapFile('README.md')).toBe(false);
    expect(isEligibleMapFile('.env.ts')).toBe(false);
    expect(isEligibleMapFile('../escape.ts')).toBe(false);
    expect(isEligibleMapFile(`${'a'.repeat(500)}.ts`)).toBe(false);
  });
});
