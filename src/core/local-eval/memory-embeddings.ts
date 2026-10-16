/**
 * Optional meaning signal for governed memory: a local Ollama embedding client, and the pure step that turns vectors
 * into the `semantic` option of buildMemoryContextPack. Off unless a caller asks for it. Local only: the base URL must be
 * a loopback host, so no memory text leaves the machine. Every failure returns null and callers fall back to lexical ranking.
 */
import { validMemoryPackQuery, validMemorySnapshot } from '../memory/validate.js';
import type { MemoryPackOptions } from '../memory/pack.js';

export const MEMORY_EMBEDDING_MODEL_HINTS = ['bge', 'nomic-embed', 'mxbai-embed', 'all-minilm', 'embed'] as const;
export type MemoryEmbeddingFetch = (url: string, init: { method?: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; json(): Promise<unknown> }>;
export interface MemoryEmbedder { model: string; embed(texts: readonly string[]): Promise<number[][] | null> }

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
function loopbackBase(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK.has(url.hostname) ? url.origin : null;
  } catch { return null; }
}
async function call(fetchImpl: MemoryEmbeddingFetch, url: string, timeoutMs: number, body?: unknown): Promise<unknown> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, body === undefined ? { headers: { Accept: 'application/json' }, signal: controller.signal }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    return response.ok ? await response.json() : null;
  } catch { return null; } finally { clearTimeout(timer); }
}
const vector = (value: unknown): value is number[] => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'number' && Number.isFinite(item));

/**
 * Connects to a local Ollama and picks an embedding model (the named one if installed, else the first matching a known hint).
 * Returns null when Ollama is absent, not loopback, or has no embedding model.
 */
export async function connectOllamaMemoryEmbedder(options: { baseUrl?: string; model?: string; timeoutMs?: number; fetchImpl?: MemoryEmbeddingFetch } = {}): Promise<MemoryEmbedder | null> {
  const base = loopbackBase(options.baseUrl ?? 'http://127.0.0.1:11434');
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as MemoryEmbeddingFetch | undefined);
  if (!base || !fetchImpl) return null;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const tags = await call(fetchImpl, `${base}/api/tags`, Math.min(timeoutMs, 3000));
  const names = tags && typeof tags === 'object' && Array.isArray((tags as { models?: unknown }).models)
    ? (tags as { models: unknown[] }).models.map(entry => (entry as { name?: unknown })?.name).filter((name): name is string => typeof name === 'string') : [];
  const model = options.model ? names.find(name => name === options.model || name === `${options.model}:latest`)
    : MEMORY_EMBEDDING_MODEL_HINTS.map(hint => names.find(name => name.toLowerCase().includes(hint))).find(Boolean);
  if (!model) return null;
  return { model, async embed(texts) {
    const out: number[][] = [];
    for (const text of texts) {
      const body = await call(fetchImpl, `${base}/api/embeddings`, timeoutMs, { model, prompt: text });
      const embedding = body && typeof body === 'object' ? (body as { embedding?: unknown }).embedding : null;
      if (!vector(embedding) || (out.length && embedding.length !== out[0].length)) return null;
      out.push(embedding);
    }
    return out;
  } };
}

export function memoryCosine(a: readonly number[], b: readonly number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, left = 0, right = 0;
  for (let index = 0; index < a.length; index++) { dot += a[index] * b[index]; left += a[index] ** 2; right += b[index] ** 2; }
  const denom = Math.sqrt(left) * Math.sqrt(right);
  return denom ? Math.max(-1, Math.min(1, dot / denom)) : 0;
}

/** Texts a pack would need embedded: the query and every fact event's text. */
export function memoryEmbeddingTexts(snapshot: unknown, query: unknown): string[] {
  if (!validMemorySnapshot(snapshot) || !validMemoryPackQuery(query)) return [];
  return [query.query, ...snapshot.events.filter(event => event.kind === 'fact').map(event => event.text)];
}

/**
 * Pure: builds the pack's `semantic` option from precomputed vectors keyed by exact text. Returns null when the query or any
 * fact text has no vector, so a partial embedding run never silently ranks some facts by meaning and others not.
 */
export function memorySemanticOption(snapshot: unknown, query: unknown, vectors: ReadonlyMap<string, readonly number[]>, minScore: number): MemoryPackOptions['semantic'] | null {
  if (!validMemorySnapshot(snapshot) || !validMemoryPackQuery(query) || !Number.isFinite(minScore) || minScore < -1 || minScore > 1) return null;
  const target = vectors.get(query.query);
  if (!target) return null;
  const scores: Record<string, number> = {};
  for (const event of snapshot.events) {
    if (event.kind !== 'fact') continue;
    const candidate = vectors.get(event.text);
    if (!candidate) return null;
    scores[event.eventId] = Math.round(memoryCosine(target, candidate) * 1e6) / 1e6;
  }
  return { scores, minScore };
}
