/**
 * knowledge/index.ts — Portfolio Knowledge Index (M25)
 *
 * INVARIANTS (non-negotiable):
 *  1. LOCAL-ONLY: embeddings run against local Ollama only. Never send chunks
 *     to a cloud endpoint — this file has no allowCloud path at all.
 *  2. READ-ONLY: never mutates any enrolled repo. Writes go to knowledgeDir()
 *     only (~/.ashlr/knowledge/<repo-hash>/ or knowledge/agents/ for memory).
 *  3. ENROLLMENT-SCOPED: default repo set is listEnrolled() (DEFAULT EMPTY →
 *     returns {repos:0, chunks:0}; never scans arbitrary paths).
 *  4. BOUNDED: caps file count, total bytes read, and wall-clock time per repo;
 *     skips node_modules / .git / dist / build / binaries / lockfiles.
 *  5. NO SECRETS: skips .env* / *.pem / *.key / *.p12 files outright; scrubs
 *     secret-shaped tokens from chunk text before storing or embedding.
 *  6. INCREMENTAL: re-indexes only files whose mtime > last index timestamp.
 *     Indexing never throws — errors are swallowed per the index contract.
 *     Explicit agent-memory reads/writes throw on unsafe or failed storage.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { homedir } from 'node:os';
import type { KnowledgeChunk } from '../types.js';
import { activeEnrollmentLenses, listEnrolled, isEnrolled } from '../sandbox/policy.js';
import { isMirrorPath } from '../fleet/mirrors.js';
import { scrubSecrets as scrubSharedSecrets } from '../util/scrub.js';
import { writePrivateFileAtomically } from '../verse/session-store.js';
import { localOllamaBase } from '../providers.js';

/**
 * 3.10: drop the fleet's own mirror clones from a DEFAULT scan set. A standing
 * grant enrolls ~/.ashlr/fleet/mirrors/<owner>__<repo> (src/core/fleet/mirrors.ts)
 * next to the checkout Mason enrolled himself; outside an enrollment lens both
 * show up here, so a scan would report every finding twice and spend a bounded
 * repo slot on a copy that is reset to origin every tick. Inside a lens (the
 * standing daemon's autonomous lane) the lens already chose the view: every
 * entry there IS a mirror, and dropping them would blind the fleet, so nothing
 * is filtered. Any failure keeps the list as it was (the pre-3.10 behaviour):
 * a duplicate is a nuisance, an empty scan is an outage.
 */
function withoutFleetMirrors(enrolled: string[]): string[] {
  try {
    if (activeEnrollmentLenses().length > 0) return enrolled;
    return enrolled.filter((repo) => {
      try {
        return !isMirrorPath(repo);
      } catch {
        return true;
      }
    });
  } catch {
    return enrolled;
  }
}

// ---------------------------------------------------------------------------
// Constants — bounds to keep indexing fast and private
// ---------------------------------------------------------------------------

/** Max source files to index per repo per run. */
const MAX_FILES_PER_REPO = 500;

/** Max bytes to read from a single file (512 KB). */
const MAX_FILE_BYTES = 512 * 1024;

/** Max total bytes read across all files in one repo (32 MB). */
const MAX_REPO_BYTES = 32 * 1024 * 1024;

/** Wall-clock budget per repo in ms (60 s). */
const REPO_BUDGET_MS = 60_000;

/** Lines per chunk (target: 80–120). */
const CHUNK_LINES = 100;

/** Max text length sent to Ollama for embedding (chars). */
const EMBED_TEXT_LIMIT = 2000;

/** Timeout for a single Ollama embedding request (ms). */
const EMBED_TIMEOUT_MS = 10_000;

/** Upper bound on the number of components in a local embedding. */
const MAX_VECTOR_DIMENSIONS = 16_384;

function isValidVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_VECTOR_DIMENSIONS &&
    value.every((component: unknown) => typeof component === 'number' && Number.isFinite(component));
}

// ---------------------------------------------------------------------------
// Skip lists
// ---------------------------------------------------------------------------

/** Directory names to never descend into. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo',
  'coverage', '__pycache__', '.cache', 'vendor', 'out', '.output',
  '.vercel', '.serverless', 'target', 'pkg', '.yarn',
]);

/** File extensions treated as binary / non-text. */
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.mp4', '.mp3', '.wav', '.ogg', '.mov', '.avi',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.wasm', '.exe', '.dylib', '.so', '.dll', '.a', '.o',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.db', '.sqlite', '.sqlite3',
  '.bin', '.dat',
]);

/** Filenames / patterns that always contain secrets — skip entirely. */
const SECRET_FILENAME_RE = /^\.env(\.|$)|\.pem$|\.key$|\.p12$|\.pfx$|\.crt$|id_rsa|id_ed25519|\.tfvars$/i;

/**
 * Secret-bearing basenames to skip outright. Mirrors graph.ts SECRET_FILES so
 * the index (which STORES + EMBEDS chunk text) never reads structured/low-entropy
 * secrets that token-shaped scrubbing would miss (e.g. {"password":"hunter2"},
 * .npmrc _authToken=…, service-account.json). Kept in sync with graph.ts.
 */
const SECRET_FILES = new Set([
  '.env', '.env.local', '.env.production', '.env.development', '.env.test',
  '.env.staging', '.envrc',
  'credentials.json', 'secrets.json', 'secret.json',
  'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
  '.npmrc', '.netrc',
  'service-account.json', 'serviceaccount.json',
]);

/** Lockfile basenames — skip (large + not useful for RAG). */
const LOCKFILE_NAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'go.sum',
  'composer.lock', 'mix.lock',
]);

// ---------------------------------------------------------------------------
// Secret scrubbing
// ---------------------------------------------------------------------------

/**
 * Patterns for secret-shaped tokens: API keys, JWTs, long hex/base64 strings.
 * Applied to chunk text before storing or embedding.
 *
 * EXPORTED (read-only) so the `ashlr verify-safety` self-check (H4) can run the
 * REAL pattern set against a synthesized secret rather than a drifting private
 * copy. Treat as a frozen constant — callers must never mutate it.
 */
export const SECRET_PATTERNS: RegExp[] = [
  // Generic "key = <value>" assignments with high-entropy values
  /\b(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{20,}["']?/gi,
  // password / passwd / pwd / connection-string / _authToken assignments
  // (covers structured/low-entropy secrets the high-entropy patterns miss)
  /\b(password|passwd|pwd|connection[_-]?string|conn[_-]?str|_?auth[_-]?token)\s*[:=]\s*["']?[^\s"']{6,}["']?/gi,
  // AWS-style access keys
  /\b(AKIA|ASIA|AROA)[A-Z0-9]{16}\b/g,
  // JWTs (three base64url segments separated by dots)
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  // Long hex strings (≥32 chars) — likely tokens/hashes used as secrets
  /\b[0-9a-f]{32,}\b/gi,
  // Long base64 strings (≥40 chars, not in comments/imports)
  /(?<![/\w])[A-Za-z0-9+/]{40,}={0,2}(?![/\w])/g,
  // H6 (PART B.2): bare Stripe secret keys (sk_live_… / sk_test_…). The
  // underscores in `sk_live_…` break the base64 char class + the \w boundary
  // of the high-entropy patterns above, so this shape was MISSED before H6
  // (the H4 finding). This grows the array 6 -> 7; verify-safety pins
  // length >= 6, so it stays GREEN. See docs/contracts/CONTRACT-H6.md §B.2 + the deliberate H4
  // assertion flip §B.4.
  /\bsk_(live|test)_[A-Za-z0-9_]{16,}\b/g,
];

/**
 * Scrub secret-shaped tokens from a chunk of text. Returns sanitized text.
 *
 * 3.10: delegates to the SHARED scrubber (src/core/util/scrub.ts — Telegram,
 * xAI, GitHub, Slack, PEM, env-var and quoted-key coverage) first, then applies
 * this corpus's STRICTER SECRET_PATTERNS on top (32-hex, `/`-bearing base64,
 * Stripe). The result is a superset of both — never weaker than either. The
 * strict pass stays local because knowledge chunks are never identity-checked,
 * whereas the shared default must keep git SHAs and ids intact.
 *
 * EXPORTED (pure, read-only) so the H4 `ashlr verify-safety` self-check can
 * invoke the REAL redaction function — not a copy — against a synthesized
 * secret, so any weakening of the function body (or its pattern set) is caught.
 */
export function scrubSecrets(text: string): string {
  let out = scrubSharedSecrets(text);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Root on-disk directory for the knowledge index: ~/.ashlr/knowledge */
export function knowledgeDir(): string {
  return path.join(homedir(), '.ashlr', 'knowledge');
}

/** A caller-selected agent namespace, never inferred from chat text. */
export interface AgentMemory {
  readonly agentId: string;
  readonly text: string;
  readonly updatedAt: string;
}

/** UTF-8 bytes, before JSON escaping. Replacement is whole-document, last writer wins. */
export const MAX_AGENT_MEMORY_BYTES = 64 * 1024;

function validateAgentId(agentId: string): void {
  if (typeof agentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agentId) ||
      scrubSecrets(agentId) !== agentId) {
    throw new Error('Invalid agent memory identity');
  }
}

function validateMemoryText(text: string): void {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_AGENT_MEMORY_BYTES) {
    throw new Error('Agent memory must be text of at most 65536 UTF-8 bytes');
  }
  // Reject rather than silently changing a user's remembered instructions.
  // Reuse BOTH the shared provider patterns and the stricter knowledge corpus.
  if (scrubSecrets(text) !== text) {
    throw new Error('Agent memory contains a secret pattern; use a Phantom Secrets reference');
  }
}

function agentMemoryPath(agentId: string, create: boolean): string | null {
  validateAgentId(agentId);
  const root = path.join(homedir(), '.ashlr');
  const dirs = [root, knowledgeDir(), path.join(knowledgeDir(), 'agents')];
  for (const dir of dirs) {
    if (create) {
      try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    try {
      // Never follow a redirected store into another agent's or user's files.
      if (!fs.lstatSync(dir).isDirectory()) throw new Error('Unsafe agent memory directory');
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  const id = crypto.createHash('sha256').update(agentId).digest('hex');
  return path.join(dirs[2]!, `${id}.json`);
}

/**
 * Read local memory for exactly one agent. Missing memory returns null; corrupt,
 * secret-bearing or inaccessible storage throws without echoing stored text.
 * No enrollment, source scan, model call, or cross-agent fallback occurs.
 * The caller must authorize the agent identity before exposing this API remotely.
 */
export function readAgentMemory(agentId: string): AgentMemory | null {
  validateAgentId(agentId);
  let fd: number | undefined;
  try {
    const file = agentMemoryPath(agentId, false);
    if (file === null) return null;
    // lstat also covers platforms without O_NOFOLLOW.
    try {
      if (!fs.lstatSync(file).isFile()) throw new Error('Unsafe agent memory file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_AGENT_MEMORY_BYTES * 6 + 1024) {
      throw new Error('Invalid agent memory file');
    }
    const raw = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < raw.length) {
      const count = fs.readSync(fd, raw, size, raw.length - size, size);
      if (count === 0) break;
      size += count;
    }
    if (size !== stat.size) throw new Error('Agent memory changed during read');
    const value: unknown = JSON.parse(raw.subarray(0, size).toString('utf8'));
    if (typeof value !== 'object' || value === null) throw new Error('Invalid agent memory');
    const record = value as Record<string, unknown>;
    if (record['version'] !== 1 || record['agentId'] !== agentId ||
        typeof record['text'] !== 'string' || typeof record['updatedAt'] !== 'string' ||
        !Number.isFinite(Date.parse(record['updatedAt']))) throw new Error('Invalid agent memory');
    validateMemoryText(record['text']);
    return { agentId, text: record['text'], updatedAt: record['updatedAt'] };
  } catch {
    throw new Error('Unable to read agent memory safely');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Replace one agent's local memory atomically (0600). Validate before any I/O;
 * rejected writes preserve existing memory. Empty text explicitly clears it.
 * Failures throw a value-blind error; they are never reported as a saved memory.
 */
export function writeAgentMemory(agentId: string, text: string): AgentMemory {
  validateAgentId(agentId);
  validateMemoryText(text);
  const memory: AgentMemory = { agentId, text, updatedAt: new Date().toISOString() };
  try {
    const file = agentMemoryPath(agentId, true)!;
    writePrivateFileAtomically(path.dirname(file), file, JSON.stringify({ version: 1, ...memory }));
  } catch {
    throw new Error('Unable to write agent memory safely');
  }
  return memory;
}

/**
 * Derive a stable short hash for a repo path.
 * Normalizes to an absolute path first so the write path (listEnrolled()
 * absolute paths) and the read path (`loadChunks('./app')`, trailing slash, etc.)
 * always hash to the same directory.
 * Used as the sub-directory name under knowledgeDir().
 */
function repoHash(repoPath: string): string {
  const abs = path.resolve(repoPath);
  return crypto.createHash('sha1').update(abs).digest('hex').slice(0, 16);
}

/** Path to the JSONL chunks file for a given repo. */
function chunksFile(repoPath: string): string {
  return path.join(knowledgeDir(), repoHash(repoPath), 'chunks.jsonl');
}

/** Path to the metadata file for a given repo (stores last index timestamp). */
function metaFile(repoPath: string): string {
  return path.join(knowledgeDir(), repoHash(repoPath), 'meta.json');
}

// ---------------------------------------------------------------------------
// Incremental metadata
// ---------------------------------------------------------------------------

interface RepoMeta {
  repo: string;
  lastIndexedAt: number; // epoch ms
}

function readMeta(repoPath: string): RepoMeta | null {
  try {
    const raw = fs.readFileSync(metaFile(repoPath), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['lastIndexedAt'] === 'number'
    ) {
      return parsed as RepoMeta;
    }
  } catch {
    // absent or malformed
  }
  return null;
}

function writeMeta(repoPath: string, meta: RepoMeta): void {
  try {
    const dir = path.dirname(metaFile(repoPath));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(metaFile(repoPath), JSON.stringify(meta, null, 2), 'utf8');
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// File walk
// ---------------------------------------------------------------------------

/**
 * Collect all indexable source file paths under a repo directory.
 * Bounded by MAX_FILES_PER_REPO. Read-only — never modifies anything.
 */
function collectFiles(repoPath: string): { files: string[]; complete: boolean } {
  const results: string[] = [];
  let complete = true;

  function walk(dir: string): void {
    if (results.length >= MAX_FILES_PER_REPO) { complete = false; return; }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }

    for (const entry of entries) {
      if (results.length >= MAX_FILES_PER_REPO) { complete = false; break; }

      const name = entry.name;

      // Skip symlinks entirely (files + dirs) so the walk can never escape the
      // enrolled repo boundary via a symlink to ~, /etc, or another repo.
      if (entry.isSymbolicLink()) continue;

      // Skip hidden directories and known skip dirs
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
        walk(path.join(dir, name));
        continue;
      }

      if (!entry.isFile()) continue;

      // Skip lockfiles
      if (LOCKFILE_NAMES.has(name)) continue;

      // Skip secret-named files (pattern + explicit basename set)
      if (SECRET_FILENAME_RE.test(name)) continue;
      if (SECRET_FILES.has(name)) continue;

      // Skip binaries by extension
      const ext = path.extname(name).toLowerCase();
      if (BINARY_EXTS.has(ext)) continue;

      results.push(path.join(dir, name));
    }
  }

  walk(repoPath);
  return { files: results, complete };
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Split file text into chunks of ~CHUNK_LINES lines each.
 * Returns an array of {startLine, endLine, text} objects (1-based lines).
 */
function chunkText(text: string): Array<{ startLine: number; endLine: number; text: string }> {
  const lines = text.split('\n');
  const chunks: Array<{ startLine: number; endLine: number; text: string }> = [];

  for (let i = 0; i < lines.length; i += CHUNK_LINES) {
    const startLine = i + 1; // 1-based
    const slice = lines.slice(i, i + CHUNK_LINES);
    const endLine = startLine + slice.length - 1;
    const chunkText = slice.join('\n').trim();
    if (chunkText.length > 0) {
      chunks.push({ startLine, endLine, text: chunkText });
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Local Ollama embedding (best-effort — never throws, never cloud)
// ---------------------------------------------------------------------------

/**
 * Detect an embedding-capable model at the local Ollama base URL.
 * Mirrors the approach in genome/recall.ts. Never throws.
 */
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

/**
 * Fetch an embedding for `text` from local Ollama.
 * Returns null on any error (network, model unavailable, timeout).
 * NEVER sends to a cloud endpoint — only ever hits ollamaBase (localhost).
 */
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
      body: JSON.stringify({ model, prompt: text.slice(0, EMBED_TEXT_LIMIT) }),
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
    return isValidVector(embedding) ? embedding : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// JSONL persistence
// ---------------------------------------------------------------------------

/** Overwrite the repo's JSONL file with the provided chunks. */
function writeChunks(repoPath: string, chunks: KnowledgeChunk[]): void {
  const file = chunksFile(repoPath);
  const lines = chunks.length === 0 ? '' : chunks.map((c) => JSON.stringify(c)).join('\n') + '\n';
  // Reuse the private store's exclusive-temp/fsync/rename publication. A
  // failed write reaches buildKnowledge's per-repo catch, never advances meta.
  writePrivateFileAtomically(path.dirname(file), file, lines);
}

// ---------------------------------------------------------------------------
// loadChunks — public API
// ---------------------------------------------------------------------------

/**
 * Load persisted knowledge chunks, optionally scoped to one repo (absolute path).
 * Returns [] when nothing is indexed or on any read error.
 * NEVER scans repo source — reads only the persisted index under knowledgeDir().
 */
export function loadChunks(repo?: string): KnowledgeChunk[] {
  const results: KnowledgeChunk[] = [];

  if (repo !== undefined) {
    // Scoped to a single repo
    const file = chunksFile(repo);
    return readChunksFile(file);
  }

  // All repos: enumerate sub-directories under knowledgeDir()
  const root = knowledgeDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'chunks.jsonl');
    const chunks = readChunksFile(file);
    results.push(...chunks);
  }

  return results;
}

/** Parse a single JSONL chunks file. Returns [] on any error. */
function readChunksFile(file: string, onInvalidVector?: () => void): KnowledgeChunk[] {
  const chunks: KnowledgeChunk[] = [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isKnowledgeChunk(parsed)) {
          // Keep searchable text from older or corrupt records, but never expose
          // an invalid vector to retrieval or write it back during indexing.
          if (parsed.vector !== undefined && !isValidVector(parsed.vector)) {
            const { vector: _vector, ...lexicalChunk } = parsed;
            onInvalidVector?.();
            chunks.push(lexicalChunk);
          } else {
            chunks.push(parsed);
          }
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // file absent or unreadable
  }
  return chunks;
}

/** Type guard for KnowledgeChunk. */
function isKnowledgeChunk(v: unknown): v is KnowledgeChunk {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj['repo'] === 'string' && obj['repo'].trim().length > 0 &&
    typeof obj['file'] === 'string' && obj['file'].trim().length > 0 &&
    typeof obj['startLine'] === 'number' && Number.isInteger(obj['startLine']) && obj['startLine'] > 0 &&
    typeof obj['endLine'] === 'number' && Number.isInteger(obj['endLine']) && obj['endLine'] >= obj['startLine'] &&
    typeof obj['text'] === 'string'
  );
}

// ---------------------------------------------------------------------------
// Index a single file — returns new chunks (may have vectors)
// ---------------------------------------------------------------------------

async function indexFile(
  repoPath: string,
  filePath: string,
  embedModel: { available: false } | { available: true; model: string },
  ollamaBase: string,
  dimensions: { value?: number },
  previousChunks: KnowledgeChunk[],
): Promise<KnowledgeChunk[]> {
  // Read file with byte cap
  let raw: string;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) return [];
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }

  // Repo-relative path for citation
  const relFile = path.relative(repoPath, filePath);

  const textChunks = chunkText(raw);
  const result: KnowledgeChunk[] = [];
  const previousVectors = new Map<string, number[][]>();
  for (const chunk of previousChunks) {
    if (!isValidVector(chunk.vector)) continue;
    const vectors = previousVectors.get(chunk.text) ?? [];
    vectors.push(chunk.vector);
    previousVectors.set(chunk.text, vectors);
  }

  for (const tc of textChunks) {
    const scrubbedText = scrubSecrets(tc.text);

    let vector: number[] | undefined;
    if (embedModel.available) {
      const vec = await fetchEmbedding(ollamaBase, embedModel.model, scrubbedText);
      if (vec !== null && (dimensions.value === undefined || vec.length === dimensions.value)) vector = vec;
    }
    // An old embedding is safe to reuse only for exactly the same scrubbed
    // text. Changed text remains searchable without a stale embedding.
    if (vector === undefined) {
      vector = previousVectors.get(scrubbedText)?.find((v) =>
        dimensions.value === undefined || v.length === dimensions.value);
    }
    if (vector !== undefined) dimensions.value ??= vector.length;

    const chunk: KnowledgeChunk = {
      repo: repoPath,
      file: relFile,
      startLine: tc.startLine,
      endLine: tc.endLine,
      text: scrubbedText,
      ...(vector !== undefined ? { vector } : {}),
    };

    result.push(chunk);
  }

  return result;
}

// ---------------------------------------------------------------------------
// buildKnowledge — public API
// ---------------------------------------------------------------------------

/**
 * Build (or incrementally update) the knowledge index for enrolled repos.
 *
 * - `opts.repos`: explicit repo list; defaults to `listEnrolled()` (DEFAULT EMPTY).
 * - `opts.allowCloud`: ignored here — this file is LOCAL-ONLY. Cloud flag is
 *   only meaningful in ask.ts for synthesis; indexing is always local.
 *
 * Guarantees:
 *  - Never mutates any enrolled repo (writes only to knowledgeDir()).
 *  - Skips secret files; scrubs secret tokens from chunk text.
 *  - Incremental: re-indexes only files changed since last run (by mtime).
 *  - Bounded: file count, byte, and time caps per repo.
 *  - Never throws.
 */
/** M32: per-repo progress event emitted by buildKnowledge (best-effort). */
export interface KnowledgeProgress {
  repo: string;
  repoIndex: number;
  repoCount: number;
  newChunks: number;
}

export async function buildKnowledge(
  opts?: {
    repos?: string[];
    allowCloud?: boolean;
    /** M32: called after each repo finishes indexing. Wrapped — a throwing
     * callback can never violate buildKnowledge's never-throws contract. */
    onProgress?: (ev: KnowledgeProgress) => void;
  },
): Promise<{ repos: number; chunks: number }> {
  // ENROLLMENT-SCOPED (docs/contracts/CONTRACT-M25.md invariant 3): listEnrolled() is already
  // enrollment-scoped, but an explicit opts.repos list (forwarded from the CLI's
  // --repo / positional args) must be validated against isEnrolled() so a caller
  // can NEVER index an arbitrary, non-enrolled directory. Resolve to absolute
  // first (listEnrolled() stores resolved paths) and drop any non-enrolled path.
  const repos = (opts?.repos ?? withoutFleetMirrors(listEnrolled())).filter((r) => isEnrolled(r));

  // Default-empty enrollment (or all paths non-enrolled) → nothing to do
  if (repos.length === 0) {
    return { repos: 0, chunks: 0 };
  }

  // Detect local Ollama embedding model once (shared across repos)
  const ollamaBase = localOllamaBase();
  let embedModel: { available: false } | { available: true; model: string };
  try {
    embedModel = await detectEmbeddingModel(ollamaBase);
  } catch {
    embedModel = { available: false };
  }

  let totalChunks = 0;
  let indexedRepos = 0;
  const dimensions: { value?: number } = {};

  for (let i = 0; i < repos.length; i++) {
    const repoPath = repos[i]!;
    let repoChunks = 0;
    try {
      repoChunks = await indexRepo(repoPath, embedModel, ollamaBase, dimensions);
      totalChunks += repoChunks;
      if (repoChunks >= 0) indexedRepos++;
    } catch {
      // one bad repo never crashes the whole run
    }
    try {
      opts?.onProgress?.({ repo: repoPath, repoIndex: i + 1, repoCount: repos.length, newChunks: repoChunks });
    } catch {
      // progress is best-effort — a throwing callback never breaks the build
    }
  }

  return { repos: indexedRepos, chunks: totalChunks };
}

/**
 * Index a single enrolled repo. Returns the number of NEW chunks added.
 * Storage failures reach buildKnowledge's per-repo catch.
 */
async function indexRepo(
  repoPath: string,
  embedModel: { available: false } | { available: true; model: string },
  ollamaBase: string,
  dimensions: { value?: number },
): Promise<number> {
  const deadline = Date.now() + REPO_BUDGET_MS;

  // Load incremental metadata
  const meta = readMeta(repoPath);
  const lastIndexedAt = meta?.lastIndexedAt ?? 0;

  // Collect all eligible files
  const collection = collectFiles(repoPath);
  const allFiles = collection.files;

  // Filter to only files modified since last index (incremental)
  const changedFiles = allFiles.filter((f) => {
    try {
      const st = fs.statSync(f);
      return st.mtimeMs > lastIndexedAt;
    } catch {
      return true; // include if we can't stat
    }
  });

  let invalidVectorFound = false;
  const existingChunks = readChunksFile(chunksFile(repoPath), () => { invalidVectorFound = true; });
  const liveFiles = new Set(allFiles.map((f) => path.relative(repoPath, f)));

  if (changedFiles.length === 0) {
    // Absence proves deletion only after a complete listing, never after an
    // unreadable directory or a capped walk. Preserve survivor values/vectors
    // and the incremental timestamp; deletion itself adds no new chunks.
    const survivors = collection.complete ? existingChunks.filter((c) => liveFiles.has(c.file)) : existingChunks;
    if (invalidVectorFound || survivors.length !== existingChunks.length) writeChunks(repoPath, survivors);
    return 0;
  }

  const reindexedFiles = new Set<string>();

  let newChunks: KnowledgeChunk[] = [];
  let totalRepoBytesRead = 0;
  // Track files we did NOT process this run (budget/time truncation) so we can
  // avoid advancing lastIndexedAt past them — otherwise a skipped changed file
  // would never be re-indexed and would silently vanish from the index.
  let truncated = false;
  const skippedMtimes: number[] = [];

  for (let fi = 0; fi < changedFiles.length; fi++) {
    const filePath = changedFiles[fi]!;

    // Wall-clock budget check — every remaining file is unprocessed.
    if (Date.now() >= deadline) {
      truncated = true;
      for (let j = fi; j < changedFiles.length; j++) {
        try { skippedMtimes.push(fs.statSync(changedFiles[j]!).mtimeMs); } catch { /* ignore */ }
      }
      break;
    }

    // Byte budget check — this file is skipped but later ones may still fit.
    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      continue;
    }
    if (totalRepoBytesRead + size > MAX_REPO_BYTES) {
      truncated = true;
      try { skippedMtimes.push(fs.statSync(filePath).mtimeMs); } catch { /* ignore */ }
      continue;
    }
    totalRepoBytesRead += size;

    const relFile = path.relative(repoPath, filePath);
    const fileChunks = await indexFile(repoPath, filePath, embedModel, ollamaBase, dimensions,
      existingChunks.filter((c) => c.file === relFile));
    reindexedFiles.add(relFile);
    newChunks = newChunks.concat(fileChunks);
  }

  // Write all chunks (kept + new) back atomically
  const keptChunks = existingChunks.filter(
    (c) => !reindexedFiles.has(c.file) && (!collection.complete || liveFiles.has(c.file)),
  );
  const allChunks = [...keptChunks, ...newChunks];
  writeChunks(repoPath, allChunks);

  // Update metadata. On truncation, hold lastIndexedAt just below the oldest
  // un-processed changed file so it is retried on the next run (don't strand it).
  let nextIndexedAt = Date.now();
  if (truncated && skippedMtimes.length > 0) {
    const oldestSkipped = Math.min(...skippedMtimes);
    nextIndexedAt = Math.min(nextIndexedAt, oldestSkipped - 1);
  }
  // An incomplete listing may omit changed files whose mtimes we never saw.
  // Keep the prior timestamp so a later complete scan can still index them.
  if (collection.complete) writeMeta(repoPath, { repo: repoPath, lastIndexedAt: nextIndexedAt });

  return newChunks.length;
}
