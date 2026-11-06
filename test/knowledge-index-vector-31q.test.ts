import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { enroll, unenroll } from '../src/core/sandbox/policy.js';
import { buildKnowledge, knowledgeDir, loadChunks } from '../src/core/knowledge/index.js';
import { ask } from '../src/core/knowledge/ask.js';

let repo: string;
let reply: (prompt: string) => unknown;
let available: boolean;
let prompts: string[];

function storedFile(name: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(repo)).digest('hex').slice(0, 16);
  return path.join(knowledgeDir(), hash, name);
}

function reindex(): void {
  fs.writeFileSync(storedFile('meta.json'), JSON.stringify({ repo, lastIndexedAt: 0 }));
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-vector-31q-'));
  execFileSync('git', ['init', '-q', repo]);
  expect(enroll(repo).ok).toBe(true);
  available = true;
  prompts = [];
  reply = () => [0.25, -0.5, 1];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(url.hostname);
    if (url.pathname === '/api/tags') {
      if (!available) throw new Error('local Ollama unavailable');
      return { ok: true, json: async () => ({ models: [{ name: 'nomic-embed-test' }] }) } as Response;
    }
    if (url.pathname === '/api/embeddings') {
      const { prompt } = JSON.parse(String(init?.body)) as { prompt: string };
      prompts.push(prompt);
      const embedding = reply(prompt);
      if (embedding instanceof Error) throw embedding;
      return { ok: true, json: async () => ({ embedding }) } as Response;
    }
    throw new Error('unexpected local request');
  }));
});

afterEach(() => {
  unenroll(repo);
  fs.rmSync(repo, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('local knowledge embedding ingestion', () => {
  it('rejects malformed, non-finite, empty and oversized vectors without losing text', async () => {
    const vectors: unknown[] = [[], [NaN], [Infinity], [-Infinity], [1, '2'], null, Array(16_385).fill(1)];
    for (let i = 0; i < vectors.length; i++) {
      fs.writeFileSync(path.join(repo, `${i}.txt`), `marker${i} password=syntheticpassword`);
    }
    reply = (prompt) => vectors[Number(/marker(\d+)/.exec(prompt)?.[1])];
    await buildKnowledge({ repos: [repo] });
    const chunks = loadChunks(repo);
    expect(chunks).toHaveLength(vectors.length);
    expect(chunks.every((c) => c.vector === undefined && c.text.includes('[REDACTED]'))).toBe(true);
    expect(prompts.every((text) => !text.includes('syntheticpassword'))).toBe(true);
    const disk = fs.readFileSync(storedFile('chunks.jsonl'), 'utf8');
    expect(disk).not.toContain('"vector"');
    expect(disk).not.toContain('syntheticpassword');
  });

  it('validates persisted vectors while retaining their text on load and rewrite', async () => {
    fs.writeFileSync(path.join(repo, 'current.txt'), 'current document');
    await buildKnowledge({ repos: [repo] });
    const original = loadChunks(repo)[0]!;
    const bad: unknown[] = [[], [null], [1, 'bad'], Array(16_385).fill(1), 'bad'];
    const lines = bad.map((vector) => JSON.stringify({ ...original, vector }));
    lines.push(JSON.stringify({ ...original, vector: [1] }).replace('[1]', '[1e400]'));
    lines.push(JSON.stringify(original));
    fs.writeFileSync(storedFile('chunks.jsonl'), lines.join('\n') + '\n');
    const loaded = loadChunks(repo);
    expect(loaded).toHaveLength(7);
    expect(loaded.slice(0, 6).every((c) => c.vector === undefined)).toBe(true);
    expect(loaded[6]?.vector).toEqual([0.25, -0.5, 1]);
    expect((await buildKnowledge({ repos: [repo] })).chunks).toBe(0);
    const repaired = fs.readFileSync(storedFile('chunks.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { vector?: unknown });
    expect(repaired.slice(0, 6).every((c) => c.vector === undefined)).toBe(true);
    expect(repaired[6]?.vector).toEqual([0.25, -0.5, 1]);
    reindex();
    await buildKnowledge({ repos: [repo] });
    expect(loadChunks(repo)).toHaveLength(1);
    expect(loadChunks(repo)[0]?.vector).toEqual([0.25, -0.5, 1]);
  });

  it('rejects mismatched dimensions across files and enrolled repos in the same run', async () => {
    fs.writeFileSync(path.join(repo, 'one.txt'), 'firstdimension');
    fs.writeFileSync(path.join(repo, 'two.txt'), 'seconddimension');
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-vector-other-'));
    try {
      execFileSync('git', ['init', '-q', other]);
      expect(enroll(other).ok).toBe(true);
      fs.writeFileSync(path.join(other, 'three.txt'), 'thirddimension');
      let count = 0;
      reply = () => ++count === 1 ? [1, 2] : [1, 2, 3];
      await buildKnowledge({ repos: [repo, other] });
      const chunks = [...loadChunks(repo), ...loadChunks(other)];
      expect(chunks).toHaveLength(3);
      expect(chunks.filter((c) => c.vector !== undefined)).toHaveLength(1);
      expect(chunks.find((c) => c.vector)?.vector).toEqual([1, 2]);
    } finally {
      unenroll(other);
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('keeps scrubbed keyword-retrievable chunks when Ollama is unavailable', async () => {
    available = false;
    fs.writeFileSync(path.join(repo, 'search.txt'), 'quartzraven password=syntheticpassword');
    await buildKnowledge({ repos: [repo] });
    expect(loadChunks(repo)[0]).toMatchObject({ text: 'quartzraven [REDACTED]' });
    expect(loadChunks(repo)[0]?.vector).toBeUndefined();
    const result = await ask('quartzraven', { repo, allowCloud: false });
    expect(result.method).toBe('keyword');
    expect(result.sources.some((source) => source.file === 'search.txt')).toBe(true);
  });

  it('retains matching usable vectors on failure, replaces changed text, and removes deleted files', async () => {
    const source = path.join(repo, 'source.txt');
    fs.writeFileSync(source, Array(100).fill('stable text').join('\n') + '\nold text');
    fs.writeFileSync(path.join(repo, 'deleted.txt'), 'to delete');
    await buildKnowledge({ repos: [repo] });
    const original = loadChunks(repo).find((c) => c.file === 'source.txt' && c.startLine === 1)!;
    expect(original.vector).toEqual([0.25, -0.5, 1]);
    fs.writeFileSync(source, Array(100).fill('stable text').join('\n') + '\nnew text');
    fs.unlinkSync(path.join(repo, 'deleted.txt'));
    reindex();
    reply = () => new Error('local Ollama unavailable');
    await buildKnowledge({ repos: [repo] });
    const chunks = loadChunks(repo);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual(original);
    expect(chunks[1]).toMatchObject({ text: 'new text' });
    expect(chunks[1]?.vector).toBeUndefined();
    const disk = fs.readFileSync(storedFile('chunks.jsonl'), 'utf8');
    expect((await buildKnowledge({ repos: [repo] })).chunks).toBe(0);
    expect(fs.readFileSync(storedFile('chunks.jsonl'), 'utf8')).toBe(disk);
  });
});
