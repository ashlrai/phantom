/**
 * Pre-registered comparison of governed memory with and without a local embedding signal, on the bundled benchmark.
 * The threshold is chosen on tuning sets only (authored, held-out A, absent, the non-retrieval dimensions and the
 * agent-written tuning histories); ties go to the higher, more conservative threshold. Validation sets (unseen B, fresh C,
 * second-fresh D, agent-written validation) are reported once, at the chosen threshold, and never shape the choice.
 */
import { canonicalJson } from '../authority/canonical-json.js';
import { buildMemoryContextPack } from '../memory/pack.js';
import { memoryBenchmarkCases, runMemoryBenchmark, type MemoryBenchmarkBuilder, type MemoryBenchmarkReport } from './memory-benchmark.js';
import { memoryEmbeddingTexts, memorySemanticOption, type MemoryEmbedder } from './memory-embeddings.js';

export const MEMORY_EMBED_THRESHOLDS: readonly number[] = Object.freeze(Array.from({ length: 15 }, (_, index) => Math.round((0.2 + index * 0.05) * 100) / 100));
const VALIDATION = /^retrieval:(unseen|fresh|second-fresh)/;

/** Which side of the protocol a case is on. */
export function memoryEmbedCaseSet(id: string): 'tuning' | 'validation' {
  if (id.startsWith('agent-writes:')) return id.split(':')[1] === 'tuning' ? 'tuning' : 'validation';
  return VALIDATION.test(id) ? 'validation' : 'tuning';
}
/** Report group for a case: authored, absent, held-out, unseen, fresh, second-fresh (with -absent), other dimensions, agent writes. */
export function memoryEmbedCaseGroup(id: string, dimension: string): string {
  if (dimension === 'agent-writes') return 'agent-writes:' + id.split(':')[1];
  if (dimension !== 'retrieval') return dimension;
  const kind = id.split(':')[1];
  return /^\d+$/.test(kind) ? 'authored' : kind;
}
function groups(report: MemoryBenchmarkReport): Record<string, Record<string, [number, number]>> {
  const out: Record<string, Record<string, [number, number]>> = {};
  for (const arm of report.arms) {
    const table: Record<string, [number, number]> = out[arm.arm] = {};
    for (const entry of arm.cases) {
      if (entry.pendingDecision) continue;
      const cell = table[memoryEmbedCaseGroup(entry.id, entry.dimension)] ??= [0, 0]; cell[1]++; if (entry.pass) cell[0]++;
    }
  }
  return out;
}
export function memoryEmbedBuilder(vectors: ReadonlyMap<string, readonly number[]>, minScore: number): MemoryBenchmarkBuilder {
  return (snapshot, query, options) => {
    const semantic = memorySemanticOption(snapshot, query, vectors, minScore);
    const base = (options ?? { changedSourceIds: [] }) as Record<string, unknown>;
    return buildMemoryContextPack(snapshot, query, semantic ? { ...base, semantic } : base);
  };
}
export interface MemoryEmbedComparison {
  protocol: 'phantom-memory-embedding-comparison-v1'; model: string; casesDigest: string; thresholds: number[];
  tuningPassesByThreshold: Record<string, number>; chosenThreshold: number;
  groups: Record<string, Record<string, [number, number]>>; overall: Record<string, MemoryBenchmarkReport['arms'][number]['overall']>;
}
/** Embeds every distinct benchmark text once, then scores. Returns null when the embedder fails (callers fall back). */
export async function compareMemoryEmbeddings(embedder: MemoryEmbedder, batch = 64): Promise<MemoryEmbedComparison | null> {
  const texts = new Set<string>();
  for (const entry of memoryBenchmarkCases()) for (const step of entry.steps) {
    const inputs = JSON.parse(canonicalJson({ snapshot: step.snapshot, query: step.query })) as { snapshot: unknown; query: unknown };
    memoryEmbeddingTexts(inputs.snapshot, inputs.query).forEach(text => texts.add(text));
  }
  const ordered = [...texts].sort(); const vectors = new Map<string, number[]>();
  for (let start = 0; start < ordered.length; start += batch) {
    const chunk = ordered.slice(start, start + batch); const result = await embedder.embed(chunk);
    if (!result || result.length !== chunk.length) return null;
    chunk.forEach((text, index) => vectors.set(text, result[index]));
  }
  const tuningPassesByThreshold: Record<string, number> = {};
  let chosen = MEMORY_EMBED_THRESHOLDS[0], best = -1;
  for (const threshold of MEMORY_EMBED_THRESHOLDS) {
    const report = runMemoryBenchmark([{ arm: 'embed', builder: memoryEmbedBuilder(vectors, threshold) }]);
    const passes = report.arms[0].cases.filter(entry => !entry.pendingDecision && entry.pass && memoryEmbedCaseSet(entry.id) === 'tuning').length;
    tuningPassesByThreshold[threshold.toFixed(2)] = passes;
    if (passes >= best) { best = passes; chosen = threshold; }
  }
  const report = runMemoryBenchmark([{ arm: 'governed', builder: buildMemoryContextPack }, { arm: 'governed+embedding', builder: memoryEmbedBuilder(vectors, chosen) }]);
  return { protocol: 'phantom-memory-embedding-comparison-v1', model: embedder.model, casesDigest: report.casesDigest, thresholds: [...MEMORY_EMBED_THRESHOLDS],
    tuningPassesByThreshold, chosenThreshold: chosen, groups: groups(report), overall: Object.fromEntries(report.arms.map(arm => [arm.arm, arm.overall])) };
}
