/**
 * ask.ts — Portfolio RAG: retrieve + synthesize answers from the knowledge index.
 *
 * INVARIANTS (non-negotiable):
 *  1. LOCAL-ONLY BY DEFAULT — code/chunks are NEVER sent to a cloud model unless
 *     opts.allowCloud === true AND a cloud key exists. Any code-to-cloud on the
 *     default path is a contract violation.
 *  2. READ-ONLY — this module never modifies any enrolled repo or any file
 *     outside knowledgeDir().
 *  3. ENROLLMENT-SCOPED — retrieval is limited to loadChunks() output, which
 *     itself is scoped to the persisted index (enrolled repos only).
 *  4. BOUNDED — top-K retrieval is capped; chunk text in the prompt is capped.
 *  5. NO SECRETS — chunks stored in the index are already scrubbed; we do not
 *     re-expose them beyond the local synthesis prompt.
 *  6. NEVER THROWS — degrades gracefully; returns a useful message on any failure.
 */

import type { AskResult, KnowledgeChunk } from '../types.js';
import { loadChunks } from './index.js';
import { getActiveClient } from '../run/provider-client.js';
import { loadConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of top chunks to retrieve for synthesis. */
const TOP_K = 8;

/** Max characters of a single chunk to include in the synthesis prompt. */
const CHUNK_TEXT_CAP = 600;

/** Max total characters of all chunk context in the synthesis prompt. */
const CONTEXT_TOTAL_CAP = 6000;

/** Timeout (ms) for the local Ollama /api/embeddings request. */
const EMBED_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Tokenisation (shared pattern with recall.ts — no import to avoid coupling)
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1); // drop single-char tokens
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

/** Reject malformed, zero and nonfinite vectors before using them as evidence. */
function validVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 &&
    Array.from(value).every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    value.some((v) => v !== 0);
}

function cosine(a: number[], b: number[]): number {
  if (!validVector(b) || a.length !== b.length) return 0;
  // Scale before taking norms so even finite, very large coordinates cannot overflow.
  const scale = (v: number[]): number => v.reduce((max, n) => Math.max(max, Math.abs(n)), 0);
  const scaleA = scale(a), scaleB = scale(b);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] / scaleA, y = b[i] / scaleB;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  return Math.max(0, Math.min(1, dot / (Math.sqrt(normA) * Math.sqrt(normB))));
}

/** Unique query-term coverage in [0, 1]; repetition cannot swamp semantic evidence. */
function keywordScoreChunk(query: string, chunk: KnowledgeChunk): number {
  const terms = new Set(tokenize(query));
  if (terms.size === 0) return 0;
  const tokens = new Set(tokenize(chunk.file + ' ' + chunk.text));
  let hits = 0;
  for (const term of terms) if (tokens.has(term)) hits++;
  return hits / terms.size;
}

// ---------------------------------------------------------------------------
// Local Ollama embedding helpers (best-effort; never throw)
// ---------------------------------------------------------------------------

async function detectEmbeddingModel(
  ollamaBase: string,
): Promise<{ available: false } | { available: true; model: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${ollamaBase.replace(/\/+$/, '')}/api/tags`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { available: false };
    const body = (await res.json()) as unknown;
    if (
      typeof body !== 'object' ||
      body === null ||
      !Array.isArray((body as Record<string, unknown>)['models'])
    ) {
      return { available: false };
    }
    const models = (body as { models: { name: string }[] }).models;
    const EMBED_HINTS = ['bge', 'nomic-embed', 'mxbai-embed', 'all-minilm', 'embed'];
    for (const hint of EMBED_HINTS) {
      const found = models.find((m) => m.name.toLowerCase().includes(hint));
      if (found) return { available: true, model: found.name };
    }
    return { available: false };
  } catch {
    return { available: false };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEmbedding(
  ollamaBase: string,
  model: string,
  text: string,
): Promise<number[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(`${ollamaBase.replace(/\/+$/, '')}/api/embeddings`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text.slice(0, 2000) }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (
      typeof body !== 'object' ||
      body === null ||
      !Array.isArray((body as Record<string, unknown>)['embedding'])
    ) {
      return null;
    }
    const embedding = (body as { embedding: unknown[] }).embedding;
    if (!validVector(embedding)) return null;
    return embedding as number[];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

interface Hit {
  chunk: KnowledgeChunk;
  score: number;
  method: 'embedding' | 'keyword';
}

/**
 * Retrieve evidence only: no answer generation or provider client calls.
 * Callers supplying chunks must use an enrollment-scoped source such as loadChunks().
 * Both channels score every chunk in [0, 1]. Their mean gives equal weight to
 * exact term coverage and positive cosine; without embeddings, use coverage alone.
 * Invalid vectors lose only their semantic contribution, preserving lexical fallback.
 */
export async function retrieve(
  question: string,
  chunks: KnowledgeChunk[],
  ollamaBase: string,
): Promise<{ hits: Hit[]; method: 'embedding' | 'keyword' }> {
  let queryVec: number[] | null = null;
  if (question.trim() && chunks.some((c) => validVector(c.vector))) {
    const probe = await detectEmbeddingModel(ollamaBase);
    if (probe.available) queryVec = await fetchEmbedding(ollamaBase, probe.model, question);
  }

  const ranked = chunks.map((chunk): Hit => {
    const lexical = keywordScoreChunk(question, chunk);
    const semantic = queryVec && chunk.vector ? cosine(queryVec, chunk.vector) : 0;
    return {
      chunk,
      score: queryVec ? (lexical + semantic) / 2 : lexical,
      method: semantic > 0 ? 'embedding' : 'keyword',
    };
  }).filter((hit) => Number.isFinite(hit.score) && hit.score > 0);

  // Stable content-based ties make selection independent of index traversal order.
  const key = (c: KnowledgeChunk): string =>
    JSON.stringify([c.repo, c.file, c.startLine, c.endLine]);
  const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
  ranked.sort((a, b) => b.score - a.score ||
    compare(key(a.chunk), key(b.chunk)) || compare(a.chunk.text, b.chunk.text) ||
    compare(a.method, b.method));

  const seen = new Set<string>();
  const hits: Hit[] = [];
  let totalChars = 0;
  for (const hit of ranked) {
    const identity = key(hit.chunk);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const { chunk } = hit;
    const size = sourceEntry(chunk).length + (hits.length > 0 ? '\n\n---\n'.length : 0);
    if (totalChars + size > CONTEXT_TOTAL_CAP) continue;
    hits.push(hit);
    totalChars += size;
    if (hits.length === TOP_K) break;
  }
  return { hits, method: hits.some((h) => h.method === 'embedding') ? 'embedding' : 'keyword' };
}

function sourceEntry(chunk: KnowledgeChunk): string {
  return `[${chunk.repo}] ${chunk.file}:${chunk.startLine}-${chunk.endLine}
${chunk.text.slice(0, CHUNK_TEXT_CAP)}`;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildPrompt(question: string, hits: Hit[]): string {
  if (hits.length === 0) {
    return `Answer the following question as best you can. No source context is available.\n\nQuestion: ${question}`;
  }

  const contextParts = hits.map((hit) => sourceEntry(hit.chunk));

  return [
    'You are a software assistant with access to source code excerpts from an enrolled code portfolio.',
    'Answer the question using only the provided context. Cite the source (repo, file, line) for each claim.',
    'If the context does not contain enough information, say so clearly.',
    '',
    '--- SOURCE CONTEXT ---',
    contextParts.join('\n\n---\n'),
    '--- END CONTEXT ---',
    '',
    `Question: ${question}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Answer `question` using a local RAG pipeline over the persisted knowledge index.
 *
 * Retrieval: bounded lexical coverage fused with local Ollama cosine when available.
 * Synthesis: LOCAL model via getActiveClient (Ollama/LM Studio).
 *
 * PRIVACY GUARDRAIL: code chunks are only sent to the local synthesis model by
 * default. They are sent to a cloud model ONLY when opts.allowCloud === true AND
 * a cloud key exists (enforced by getActiveClient — it throws otherwise).
 *
 * Never throws. Degrades to an informational message when nothing is indexed
 * or the local model is unreachable.
 */
export async function ask(
  question: string,
  opts: { repo?: string; allowCloud: boolean },
): Promise<AskResult> {
  const noKnowledge = (reason: string): AskResult => ({
    question,
    answer: reason,
    sources: [],
    method: 'keyword',
    local: true,
  });

  // --- Load chunks from the persisted index ---
  let chunks: KnowledgeChunk[];
  try {
    chunks = loadChunks(opts.repo);
  } catch {
    return noKnowledge('No knowledge indexed — run `ashlr knowledge build` to index enrolled repos.');
  }

  if (chunks.length === 0) {
    const scope = opts.repo ? ` for repo ${opts.repo}` : '';
    return noKnowledge(
      `No knowledge indexed${scope} — run \`ashlr knowledge build\` to index enrolled repos.`,
    );
  }

  // --- Load config (synchronous) for Ollama base URL and provider client ---
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig();
  } catch {
    return noKnowledge('Could not load ashlr config — run `ashlr` once to initialize.');
  }

  const ollamaBase = (cfg.models?.ollama ?? 'http://localhost:11434').replace(/\/+$/, '');

  // --- Retrieve top-K relevant chunks ---
  let hits: Hit[];
  let method: 'embedding' | 'keyword';
  try {
    ({ hits, method } = await retrieve(question, chunks, ollamaBase));
  } catch {
    hits = [];
    method = 'keyword';
  }

  // --- Build cited sources from retrieved hits ---
  const sources = hits.map((h) => ({
    repo: h.chunk.repo,
    file: h.chunk.file,
    line: h.chunk.startLine,
  }));

  // --- Synthesize answer via local model ---
  // PRIVACY: getActiveClient enforces LOCAL-ONLY by default.
  // allowCloud is forwarded verbatim — the client will throw if cloud is
  // selected without --allow-cloud, providing a clear error message.
  const prompt = buildPrompt(question, hits);
  let answer: string;
  let isLocal = true;

  try {
    const client = await getActiveClient(cfg, { allowCloud: opts.allowCloud });
    // ALLOWLIST (not denylist): treat ONLY the known local providers as local.
    // Any unknown/new provider id (e.g. a future 'bedrock'/'vertex') defaults to
    // local:false (cloud) so it correctly triggers the cloud warning rather than
    // being silently mislabeled as local.
    isLocal = client.id === 'ollama' || client.id === 'lmstudio';

    const result = await client.chat([
      { role: 'user', content: prompt },
    ]);
    answer = result.content.trim();
    if (!answer) {
      answer = 'The local model returned an empty response. Ensure Ollama is running with a chat model loaded.';
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Surface the local-first refusal clearly so the user knows what to do
    answer = `Could not synthesize an answer: ${msg}`;
    // If the error is a local-first refusal (no cloud without --allow-cloud),
    // treat it as a local attempt (the synthesis just failed)
    isLocal = true;
  }

  return {
    question,
    answer,
    sources,
    method,
    local: isLocal,
  };
}
