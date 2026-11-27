import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  detectEmbeddingModel,
  fetchEmbedding,
  isValidVector,
  knowledgeChunksPath,
  knowledgeDir,
  withoutFleetMirrors,
} from '../src/core/knowledge/index.js';
import { stripCitationLinks } from '../src/core/knowledge/wiki/citations.js';
import { countLines, lineOfIndex } from '../src/core/knowledge/wiki/facts.js';
import { isPlainRecord, sha256Hex } from '../src/core/knowledge/wiki/store.js';
import { extractMapFacts, isMapSourcePath, mapFactsKey } from '../src/core/knowledge/wiki/system-map-facts.js';
import { resolveMapCommit } from '../src/core/knowledge/wiki/system-map-git.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('knowledge shared helpers', () => {
  it('validates dense finite vectors with optional non-zero and dimension bounds', () => {
    expect(isValidVector([0.5, -1, 0])).toBe(true);
    expect(isValidVector([0, 0])).toBe(true);
    expect(isValidVector([0, 0], { requireNonZero: true })).toBe(false);
    expect(isValidVector([0, 0.25], { requireNonZero: true })).toBe(true);
    expect(isValidVector(new Array(2))).toBe(false);
    expect(isValidVector([])).toBe(false);
    expect(isValidVector([NaN, 1])).toBe(false);
    expect(isValidVector([Infinity, 1])).toBe(false);
    expect(isValidVector([1, '2'])).toBe(false);
    expect(isValidVector([1, 2, 3], { maxDimensions: 2 })).toBe(false);
    expect(isValidVector([1, 2], { maxDimensions: 2 })).toBe(true);
  });

  it('discovers and fetches local Ollama embeddings while honoring validation options', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) {
        return { ok: true, json: async () => ({ models: [{ name: 'llama3' }, { name: 'nomic-embed-text' }] }) };
      }
      if (url.endsWith('/api/embeddings')) {
        return { ok: true, json: async () => ({ embedding: [0, 0] }) };
      }
      throw new Error(`unexpected request: ${url}`);
    }));

    expect(await detectEmbeddingModel('http://127.0.0.1:11434/')).toEqual({
      available: true,
      model: 'nomic-embed-text',
    });
    expect(await fetchEmbedding('http://127.0.0.1:11434', 'nomic-embed-text', 'hello')).toEqual([0, 0]);
    expect(await fetchEmbedding('http://127.0.0.1:11434', 'nomic-embed-text', 'hello', { requireNonZero: true })).toBeNull();
  });

  it('derives normalized repo chunks paths under knowledgeDir and preserves non-mirror entries', () => {
    const a = knowledgeChunksPath('/tmp/example-repo');
    const b = knowledgeChunksPath('/tmp/example-repo/');
    expect(a).toBe(b);
    expect(a.startsWith(knowledgeDir() + path.sep)).toBe(true);
    expect(path.basename(a)).toBe('chunks.jsonl');
    expect(withoutFleetMirrors(['/tmp/example-repo'])).toEqual(['/tmp/example-repo']);
  });

  it('guards plain JSON objects and hashes deterministically', () => {
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord('str')).toBe(false);
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('strips wiki citation and page link wrappers while keeping external markdown links', () => {
    const md = 'See [src/a.ts:10-12](#cite:src/a.ts:10-12), [Overview](#page:overview), and [docs](https://example.com).';
    expect(stripCitationLinks(md)).toBe('See src/a.ts:10-12, Overview, and [docs](https://example.com).');
  });

  it('counts file lines and 1-based line offsets consistently', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('one')).toBe(1);
    expect(countLines('one\n')).toBe(1);
    expect(countLines('one\ntwo\n')).toBe(2);
    expect(lineOfIndex('one\ntwo\nthree', 0)).toBe(1);
    expect(lineOfIndex('one\ntwo\nthree', 4)).toBe(2);
    expect(lineOfIndex('one\ntwo\nthree', 8)).toBe(3);
  });

  it('classifies map source paths and rejects malformed revisions without invoking git', async () => {
    expect(isMapSourcePath('src/core/knowledge/index.ts')).toBe(true);
    expect(isMapSourcePath('README.md')).toBe(false);
    expect(isMapSourcePath('.env.ts')).toBe(false);
    expect(isMapSourcePath('../escape.ts')).toBe(false);
    expect(mapFactsKey('src/cli/wiki.ts')).toBe('src/cli/wiki.ts');
    expect(mapFactsKey('src/core/verse/wiki-api.ts')).toBe('verse');
    expect(extractMapFacts("    case 'status':\n", 'src/cli/wiki.ts').marks).toEqual([['cli', 'status', 1]]);
    expect(await resolveMapCommit('/nonexistent', 'not-a-commit')).toBeNull();
  });
});
