import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchEmbedding } from '../src/core/knowledge/index.js';
import { plainCitations } from '../src/core/knowledge/wiki/citations.js';
import { isEligibleMapFile } from '../src/core/knowledge/wiki/system-map-facts.js';
import * as wikiBarrel from '../src/core/knowledge/wiki/index.js';
import * as cliKnowledge from '../src/cli/knowledge.js';
import { isPlainObject, parseKnowledgeFileArgs, readKnowledgeInputFile } from '../src/cli/knowledge-input.js';

describe('knowledge helper consolidation and dead-export pruning', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('fetchEmbedding applies custom vector validation and timeout options', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: [0, 0, 0] }),
    }));
    const nonZero = (v: unknown): v is number[] =>
      Array.isArray(v) && v.length > 0 && v.every(n => typeof n === 'number' && Number.isFinite(n)) && v.some(n => n !== 0);
    expect(await fetchEmbedding('http://localhost:11434', 'nomic-embed', 'hello')).toEqual([0, 0, 0]);
    expect(await fetchEmbedding('http://localhost:11434', 'nomic-embed', 'hello', { timeoutMs: 250, validate: nonZero })).toBeNull();
  });

  it('plainCitations strips canonical cite and page links while preserving external links', () => {
    const md = 'See [src/a.ts:4-8](#cite:src/a.ts:4-8), [Overview](#page:overview), and [docs](https://example.com).';
    expect(plainCitations(md)).toBe('See src/a.ts:4-8, Overview, and [docs](https://example.com).');
  });

  it('isEligibleMapFile accepts readable JS/TS sources and rejects non-source or unsafe paths', () => {
    expect(isEligibleMapFile('src/core/knowledge/index.ts')).toBe(true);
    expect(isEligibleMapFile('README.md')).toBe(false);
    expect(isEligibleMapFile('.env.ts')).toBe(false);
    expect(isEligibleMapFile('../escape.ts')).toBe(false);
  });

  it('shared CLI knowledge input helpers validate plain objects, args, and bounded files', () => {
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);

    expect(parseKnowledgeFileArgs(['--help'], () => 'bad')).toEqual({ kind: 'help' });
    expect(parseKnowledgeFileArgs(['--file', 'in.json', '--json'], () => 'bad')).toEqual({ kind: 'ok', file: 'in.json', json: true });
    expect(parseKnowledgeFileArgs(['--file', 'bad\0path'], () => 'bad')).toEqual({ kind: 'error', message: '--file requires a path' });
    expect(parseKnowledgeFileArgs(['--bogus'], arg => `Unknown ${arg}`)).toEqual({ kind: 'error', message: 'Unknown --bogus' });
    expect(parseKnowledgeFileArgs(['--json'], () => 'bad')).toEqual({ kind: 'error', message: '--file is required' });

    const dir = mkdtempSync(join(tmpdir(), 'knowledge-input-'));
    dirs.push(dir);
    const file = join(dir, 'sample.json');
    writeFileSync(file, '{"ok":true}\n', 'utf8');
    const read = readKnowledgeInputFile(file, 1024);
    expect(read.ok).toBe(true);
    if (read.ok) expect(JSON.parse(read.text)).toEqual({ ok: true });
  });

  it('keeps dead exports pruned from wiki barrel and knowledge CLI', () => {
    for (const removed of ['wikiBuildInFlight', 'NO_MODEL_RESOLVER', 'CITE_PREFIX', 'autoRefreshOnce']) {
      expect(removed in wikiBarrel).toBe(false);
    }
    expect('cmdImpact' in cliKnowledge).toBe(false);
  });
});
