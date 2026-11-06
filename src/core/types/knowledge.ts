/** Shared knowledge contracts. Public entry point: ../types.ts. */

/**
 * M25 (Portfolio Intelligence): a single chunk of source extracted from an
 * ENROLLED repo during a read-only knowledge walk. Persisted as JSONL under
 * `~/.ashlr/knowledge/<repo-hash>/*.jsonl`. Secrets are scrubbed BEFORE a chunk
 * is created/embedded; no chunk ever contains .env contents or secret-shaped
 * tokens. `vector` is present only when local Ollama embeddings succeeded;
 * otherwise retrieval falls back to keyword/TF-IDF scoring over `text`.
 */
export interface KnowledgeChunk {
  /** Absolute path of the enrolled repo this chunk came from. */
  repo: string;
  /** Repo-relative path of the source file. */
  file: string;
  /** 1-based first line of the chunk span within the file. */
  startLine: number;
  /** 1-based last line of the chunk span within the file (inclusive). */
  endLine: number;
  /** Scrubbed source text of the chunk (no secrets). */
  text: string;
  /** Local embedding vector, present only when Ollama embeddings succeeded. */
  vector?: number[];
  /** Optional short local-model summary of the chunk. */
  summary?: string;
}

/**
 * M25: one retrieved chunk plus its relevance score for an `ashlr ask` query.
 * Score is cosine similarity (embedding path) or normalized keyword/TF-IDF
 * score (fallback path); higher is more relevant.
 */
export interface AskHit {
  /** The retrieved knowledge chunk. */
  chunk: KnowledgeChunk;
  /** Relevance score (embedding cosine or keyword score); higher = better. */
  score: number;
}

/**
 * M25: result of `ashlr ask "<question>"` - a LOCAL RAG answer synthesized from
 * retrieved portfolio chunks with explicit source citations. `local` MUST be
 * true unless --allow-cloud was explicitly passed AND a key exists; the default
 * path keeps all private code on the machine.
 */
export interface AskResult {
  /** The original question text. */
  question: string;
  /** Synthesized natural-language answer. */
  answer: string;
  /** Cited sources backing the answer (repo / file:line). */
  sources: { repo: string; file: string; line: number }[];
  /** Retrieval method used: local embeddings or keyword/TF-IDF fallback. */
  method: "embedding" | "keyword";
  /** True when synthesis ran entirely on the LOCAL model (no code sent to cloud). */
  local: boolean;
}

/**
 * M25: result of `ashlr impact <file|symbol>` - where a target is referenced
 * and what depends on it, within and across ENROLLED repos. Pure read-only
 * analysis; never mutates a repo.
 */
export interface ImpactResult {
  /** The file path or symbol that was analyzed. */
  target: string;
  /** Locations that reference the target (repo / file:line). */
  references: { repo: string; file: string; line: number }[];
  /** Identifiers (repo/module/dep node ids) that depend on the target. */
  dependents: string[];
}

/**
 * M25: a lightweight cross-portfolio knowledge graph over ENROLLED repos.
 * Nodes are repos/modules/key deps; edges capture imports/depends/shared-dep
 * relationships. `crossRepo` surfaces signals spanning repos (e.g. the same
 * outdated/vulnerable dependency, or a duplicated pattern). Built read-only.
 */
export interface KnowledgeGraph {
  /** Graph nodes: repos, modules, and key dependencies. */
  nodes: { id: string; kind: string; label: string }[];
  /** Directed edges between nodes (imports / depends / shared-dep). */
  edges: { from: string; to: string; kind: string }[];
  /** Cross-repo findings (shared/duplicated deps or patterns) and the repos involved. */
  crossRepo: { kind: string; detail: string; repos: string[] }[];
}
