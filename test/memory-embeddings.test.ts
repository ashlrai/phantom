/** Optional embedding signal for governed memory: kernel option, loopback-only Ollama client, and the pre-registered comparison. */
import { describe, expect, it } from 'vitest';
import { benchmarkMemoryEmbeddingsCli, parseMemoryEmbedArgs } from '../scripts/benchmark-memory-embeddings.js';
import { memoryBenchmarkCases } from '../src/core/local-eval/memory-benchmark.js';
import { MEMORY_EMBED_THRESHOLDS, compareMemoryEmbeddings, memoryEmbedCaseGroup, memoryEmbedCaseSet } from '../src/core/local-eval/memory-benchmark-embeddings.js';
import { connectOllamaMemoryEmbedder, memoryCosine, memoryEmbeddingTexts, memorySemanticOption, type MemoryEmbedder, type MemoryEmbeddingFetch }
  from '../src/core/local-eval/memory-embeddings.js';
import { buildMemoryContextPack } from '../src/core/memory/pack.js';

const cases = memoryBenchmarkCases();
// A paraphrase the lexical ranker misses: "a relational engine" never names postgres or the database.
const missed = cases.find(entry => entry.id.startsWith('retrieval:fresh') && entry.steps[0].expect.required.length
  && buildMemoryContextPack(entry.steps[0].snapshot, entry.steps[0].query, { changedSourceIds: [] }).items.length === 0)!;
const step = missed.steps[0];
const required = step.snapshot.events.find(event => event.kind === 'fact' && event.text === step.expect.required[0])!;
const scores = Object.fromEntries(step.snapshot.events.filter(event => event.kind === 'fact').map(event => [event.eventId, event === required ? 0.9 : 0.1]));

/** Deterministic stand-in for a model: letter-trigram counts hashed into 64 buckets. */
function stubVector(text: string): number[] {
  const out = new Array<number>(64).fill(0); const lower = ` ${text.toLowerCase()} `;
  for (let index = 0; index + 3 <= lower.length; index++) {
    let hash = 0; for (const char of lower.slice(index, index + 3)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    out[hash % 64]++;
  }
  return out;
}
const stub: MemoryEmbedder = { model: 'stub-trigram', embed: async texts => texts.map(stubVector) };
function fakeOllama(models: string[], embedding: (prompt: string) => unknown = prompt => ({ embedding: stubVector(prompt) })) {
  const calls: string[] = [];
  const fetchImpl: MemoryEmbeddingFetch = async (url, init) => {
    calls.push(url);
    if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: models.map(name => ({ name })) }) };
    const body = JSON.parse(init.body ?? '{}') as { prompt: string };
    return { ok: true, json: async () => embedding(body.prompt) };
  };
  return { calls, fetchImpl };
}

describe('memory pack semantic option', () => {
  it('admits a meaning-only fact at or above minScore, below every lexical match, and leaves it out under the threshold', () => {
    expect(missed).toBeDefined();
    const admitted = buildMemoryContextPack(step.snapshot, step.query, { changedSourceIds: [], semantic: { scores, minScore: 0.5 } });
    expect(admitted.items.map(item => item.eventId)).toContain(required.eventId);
    expect(admitted.items.find(item => item.eventId === required.eventId)!.score).toBe(0.5);
    const held = buildMemoryContextPack(step.snapshot, step.query, { changedSourceIds: [], semantic: { scores, minScore: 0.95 } });
    expect(held.items.map(item => item.eventId)).not.toContain(required.eventId);
  });
  it('never lets a meaning score outrank a lexical match', () => {
    const lexical = cases.find(entry => entry.id.endsWith(':lexical'))!.steps[0];
    const plain = buildMemoryContextPack(lexical.snapshot, lexical.query, { changedSourceIds: [] });
    expect(plain.items.length).toBeGreaterThan(0);
    const inverted = Object.fromEntries(lexical.snapshot.events.filter(event => event.kind === 'fact')
      .map(event => [event.eventId, plain.items.some(item => item.eventId === event.eventId) ? -1 : 1]));
    const pack = buildMemoryContextPack(lexical.snapshot, lexical.query, { changedSourceIds: [], semantic: { scores: inverted, minScore: 0.5 } });
    expect(pack.items[0].eventId).toBe(plain.items[0].eventId);
    expect(pack.items.filter(item => item.score >= 1).map(item => item.eventId)).toEqual(plain.items.map(item => item.eventId));
  });
  it('refuses malformed semantic options instead of guessing', () => {
    for (const semantic of [{ scores, minScore: 2 }, { scores: { [required.eventId]: 1.5 }, minScore: 0.5 }, { scores: { 'not an id!': 0.5 }, minScore: 0.5 },
      { scores, minScore: 0.5, extra: true }, { scores: [], minScore: 0.5 }]) {
      const pack = buildMemoryContextPack(step.snapshot, step.query, { changedSourceIds: [], semantic });
      expect(pack.status).toBe('refused');
      expect(pack.receipt.stopReasons).toContain('invalid-options');
    }
  });
  it('builds the option from vectors keyed by exact text and refuses a partial set', () => {
    const vectors = new Map(memoryEmbeddingTexts(step.snapshot, step.query).map(text => [text, stubVector(text)]));
    const option = memorySemanticOption(step.snapshot, step.query, vectors, 0.4)!;
    expect(Object.keys(option.scores).sort()).toEqual(step.snapshot.events.filter(event => event.kind === 'fact').map(event => event.eventId).sort());
    vectors.delete(required.text);
    expect(memorySemanticOption(step.snapshot, step.query, vectors, 0.4)).toBeNull();
    expect(memoryCosine([1, 0], [1, 0])).toBe(1);
    expect(memoryCosine([1, 0], [0, 1])).toBe(0);
    expect(memoryCosine([1], [1, 2])).toBe(0);
  });
});

describe('local Ollama embedder', () => {
  it('refuses non-loopback hosts before any request', async () => {
    const { calls, fetchImpl } = fakeOllama(['all-minilm:latest']);
    expect(await connectOllamaMemoryEmbedder({ baseUrl: 'http://example.com:11434', fetchImpl })).toBeNull();
    expect(await connectOllamaMemoryEmbedder({ baseUrl: 'http://10.0.0.5:11434', fetchImpl })).toBeNull();
    expect(calls).toEqual([]);
  });
  it('falls back to null when Ollama is absent, has no embedding model, or returns bad vectors', async () => {
    const down: MemoryEmbeddingFetch = async () => { throw new Error('ECONNREFUSED'); };
    expect(await connectOllamaMemoryEmbedder({ fetchImpl: down })).toBeNull();
    expect(await connectOllamaMemoryEmbedder({ fetchImpl: fakeOllama(['llama3:8b']).fetchImpl })).toBeNull();
    expect(await connectOllamaMemoryEmbedder({ model: 'bge-m3', fetchImpl: fakeOllama(['all-minilm:latest']).fetchImpl })).toBeNull();
    const bad = await connectOllamaMemoryEmbedder({ fetchImpl: fakeOllama(['all-minilm:latest'], () => ({ embedding: ['x'] })).fetchImpl });
    expect(await bad!.embed(['a'])).toBeNull();
    let size = 3;
    const ragged = await connectOllamaMemoryEmbedder({ fetchImpl: fakeOllama(['nomic-embed-text'], () => ({ embedding: new Array(size++).fill(0.5) })).fetchImpl });
    expect(await ragged!.embed(['a', 'b'])).toBeNull();
  });
  it('picks an installed embedding model and returns one vector per text', async () => {
    const { calls, fetchImpl } = fakeOllama(['llama3:8b', 'all-minilm:latest']);
    const embedder = (await connectOllamaMemoryEmbedder({ fetchImpl }))!;
    expect(embedder.model).toBe('all-minilm:latest');
    expect(await embedder.embed(['build', 'deploy'])).toEqual([stubVector('build'), stubVector('deploy')]);
    expect(calls.every(url => url.startsWith('http://127.0.0.1:11434/'))).toBe(true);
    expect((await connectOllamaMemoryEmbedder({ model: 'all-minilm', fetchImpl }))!.model).toBe('all-minilm:latest');
  });
});

describe('pre-registered embedding comparison', () => {
  it('splits tuning from validation cases', () => {
    expect(memoryEmbedCaseSet('retrieval:3:paraphrase')).toBe('tuning');
    expect(memoryEmbedCaseSet('retrieval:held-out:x:y:1')).toBe('tuning');
    expect(memoryEmbedCaseSet('retrieval:absent:1')).toBe('tuning');
    for (const id of ['retrieval:unseen:x:y:1', 'retrieval:fresh-absent:2', 'retrieval:second-fresh:x:y:1', 'agent-writes:validation:s1:1'])
      expect(memoryEmbedCaseSet(id)).toBe('validation');
    expect(memoryEmbedCaseSet('agent-writes:tuning:s1:1')).toBe('tuning');
    expect(memoryEmbedCaseGroup('retrieval:3:lexical', 'retrieval')).toBe('authored');
    expect(memoryEmbedCaseGroup('temporal:current', 'temporal')).toBe('temporal');
  });
  it('chooses the threshold from tuning passes only and reports both arms on every case', async () => {
    const result = (await compareMemoryEmbeddings(stub))!;
    expect(result.model).toBe('stub-trigram');
    const best = Math.max(...Object.values(result.tuningPassesByThreshold));
    const winners = MEMORY_EMBED_THRESHOLDS.filter(threshold => result.tuningPassesByThreshold[threshold.toFixed(2)] === best);
    expect(result.chosenThreshold).toBe(Math.max(...winners));
    for (const arm of ['governed', 'governed+embedding']) {
      expect(Object.values(result.groups[arm]).reduce((sum, [, total]) => sum + total, 0)).toBe(result.overall[arm].cases);
    }
    expect(result.groups.governed.authored).toEqual([58, 60]);
  }, 180_000);
  it('fails closed with exit 3 when no embedder is reachable, and 2 on bad arguments', async () => {
    expect(parseMemoryEmbedArgs([])).toEqual({});
    expect(parseMemoryEmbedArgs(['--model', 'all-minilm'])).toEqual({ model: 'all-minilm' });
    expect((await benchmarkMemoryEmbeddingsCli(['--model'], async () => stub)).exitCode).toBe(2);
    expect((await benchmarkMemoryEmbeddingsCli([], async () => null)).exitCode).toBe(3);
    expect((await benchmarkMemoryEmbeddingsCli([], async () => ({ model: 'broken', embed: async () => null }))).exitCode).toBe(3);
  });
});
