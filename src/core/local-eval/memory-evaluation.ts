/** Offline synthetic evidence evaluation. No files, processes, providers, application state or model judging. */
import { createHash } from 'node:crypto';
import { arch, cpus, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { canonicalJson } from '../authority/canonical-json.js';
import { buildMemoryContextPack } from '../memory/pack.js';
import { memoryUtf8Bytes, validMemoryPackQuery } from '../memory/validate.js';
import type { MemoryContextPack, MemoryFactEvent, MemoryPackQuery } from '../memory/types.js';
import { buildFlatLatestMemoryDiagnostic } from './memory-evaluation-baseline.js';
import { MEMORY_EVAL_FAMILIES, type MemoryEvalArmResult, type MemoryEvalCase, type MemoryEvalCaseResult,
  type MemoryEvalCorpus, type MemoryEvalDistribution, type MemoryEvalReport, type MemoryEvalSourceBinding } from './memory-evaluation-types.js';

export const MEMORY_EVAL_CAPS = Object.freeze({ corpusBytes: 1024 * 1024, cases: 72, eventsPerCase: 8,
  nodes: 100_000, depth: 32, repeats: 5 });
const hash = (value: string) => 'sha256_' + createHash('sha256').update(value, 'utf8').digest('hex');
const statuses = ['ready', 'none', 'unknown', 'unavailable', 'refused'];
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const list = (value: unknown, max: number, check: (item: unknown) => boolean): value is unknown[] => Array.isArray(value) && value.length <= max && value.every(check);
const strings = (value: unknown, max = 64): value is string[] => list(value, max, item => typeof item === 'string' && item.length <= 16384);
const object = (value: unknown, keys: string[]): value is Record<string, unknown> => Boolean(value) && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value as object).sort().join('\0') === [...keys].sort().join('\0');
function boundedGraph(value: unknown): boolean {
  const queue: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (queue.length) {
    const next = queue.pop()!;
    if (++nodes > MEMORY_EVAL_CAPS.nodes || next.depth > MEMORY_EVAL_CAPS.depth) return false;
    if (next.value && typeof next.value === 'object') for (const child of Object.values(next.value)) queue.push({ value: child, depth: next.depth + 1 });
  }
  return true;
}
/** Parses only the fixed synthetic protocol. Malformed *memory inputs* are retained as assigned refusal cases. */
export function parseMemoryEvalCorpus(text: string): MemoryEvalCorpus {
  if (typeof text !== 'string' || memoryUtf8Bytes(text) > MEMORY_EVAL_CAPS.corpusBytes) throw new Error('Memory evaluation corpus refused.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Memory evaluation corpus refused.'); }
  if (!boundedGraph(value) || !object(value, ['schemaVersion', 'protocol', 'seed', 'license', 'source', 'accessPolicy', 'families', 'cases'])
    || value.schemaVersion !== 1 || value.protocol !== 'phantom-memory-offline-v1' || value.license !== 'CC0-1.0'
    || value.source !== 'synthetic-authored-no-private-history' || value.accessPolicy !== 'identical-complete-case-snapshot-and-query; oracle-withheld-from-both-arms'
    || !Number.isSafeInteger(value.seed) || (value.seed as number) < 1 || (value.seed as number) > 0xffffffff
    || !Array.isArray(value.families) || canonicalJson(value.families) !== canonicalJson(MEMORY_EVAL_FAMILIES)
    || !Array.isArray(value.cases) || value.cases.length !== MEMORY_EVAL_CAPS.cases) throw new Error('Memory evaluation corpus refused.');
  const seen = new Set<string>(); const groups = new Map<string, Set<number>>();
  for (const entry of value.cases) {
    if (!object(entry, ['id', 'family', 'variant', 'why', 'snapshot', 'query', 'gold']) || !id(entry.id) || seen.has(entry.id)
      || !MEMORY_EVAL_FAMILIES.includes(entry.family as typeof MEMORY_EVAL_FAMILIES[number]) || !Number.isSafeInteger(entry.variant)
      || (entry.variant as number) < 1 || (entry.variant as number) > 6 || typeof entry.why !== 'string' || entry.why.length > 512
      || !entry.snapshot || typeof entry.snapshot !== 'object' || !Array.isArray((entry.snapshot as { events?: unknown }).events)
      || ((entry.snapshot as { events: unknown[] }).events.length > MEMORY_EVAL_CAPS.eventsPerCase)
      || !entry.query || typeof entry.query !== 'object') throw new Error('Memory evaluation corpus refused.');
    const gold = entry.gold;
    if (!object(gold, ['status', 'selectedEventIds', 'sourceIds', 'mustContain', 'mustNotContain', 'exclusions']) || !statuses.includes(gold.status as string)
      || !list(gold.selectedEventIds, 64, id) || !list(gold.sourceIds, 512, id) || !strings(gold.mustContain) || !strings(gold.mustNotContain)
      || !list(gold.exclusions, 8, item => object(item, ['eventId', 'reason']) && id(item.eventId) && typeof item.reason === 'string' && item.reason.length <= 64)) throw new Error('Memory evaluation corpus refused.');
    seen.add(entry.id); const variants = groups.get(entry.family as string) ?? new Set<number>();
    if (variants.has(entry.variant as number)) throw new Error('Memory evaluation corpus refused.');
    variants.add(entry.variant as number); groups.set(entry.family as string, variants);
  }
  if (groups.size !== 12 || [...groups.values()].some(group => group.size !== 6)) throw new Error('Memory evaluation corpus refused.');
  return value as unknown as MemoryEvalCorpus;
}
export function memoryEvalDistribution(values: readonly number[]): MemoryEvalDistribution {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return { count: 0, minMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0 };
  const middle = Math.floor(sorted.length / 2);
  return { count: sorted.length, minMs: sorted[0]!, medianMs: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!, maxMs: sorted[sorted.length - 1]! };
}
function judge(entry: MemoryEvalCase, pack: MemoryContextPack): string[] {
  const failures: string[] = []; const expect = (ok: boolean, reason: string) => { if (!ok) failures.push(reason); };
  const selected = pack.items.map(item => item.eventId).sort();
  const sources = pack.items.flatMap(item => item.sourceRefs.map(ref => ref.id)).sort();
  expect(pack.status === entry.gold.status, 'status');
  expect(canonicalJson(selected) === canonicalJson([...entry.gold.selectedEventIds].sort()), 'selected-events');
  expect(canonicalJson(sources) === canonicalJson([...entry.gold.sourceIds].sort()), 'source-citations');
  expect(pack.authority === false && pack.contentSafety === 'screened-with-shared-patterns', 'authority-content-boundary');
  expect(pack.bytes === memoryUtf8Bytes(pack.text), 'byte-accounting');
  if (validMemoryPackQuery(entry.query)) {
    expect(pack.bytes <= entry.query.maxBytes, 'framing-byte-budget'); expect(pack.items.length <= entry.query.maxFacts, 'fact-budget');
  }
  expect(canonicalJson([...pack.receipt.selectedEventIds].sort()) === canonicalJson(selected), 'receipt-selection');
  const events = (entry.snapshot as { events: MemoryFactEvent[] }).events;
  // Compare literal fixture provenance; never ask the selector/formatter for gold.
  for (const item of pack.items) {
    const expected = events.find(event => event.eventId === item.eventId);
    expect(Boolean(expected) && expected!.factId === item.factId && expected!.revision === item.revision, 'fact-identity');
    expect(Boolean(expected) && canonicalJson(expected!.sourceRefs) === canonicalJson(item.sourceRefs), 'citation-payload');
  }
  // Receipts alone do not prove evidence reached the model-facing text. Both
  // declared arms emit one JSON evidence object per line; parse independently.
  const emitted: Array<{ eventId?: unknown; text?: unknown; sourceRefs?: unknown; sources?: unknown; observedAt?: unknown; validFrom?: unknown; validUntil?: unknown }> = [];
  for (const line of pack.text.split('\n')) if (line.startsWith('{')) {
    try { emitted.push(JSON.parse(line)); } catch { failures.push('evidence-text-json'); }
  }
  expect(emitted.length === selected.length, 'emitted-evidence-count');
  expect(canonicalJson(emitted.map(row => row.eventId).sort()) === canonicalJson(selected), 'emitted-event-identities');
  for (const row of emitted) {
    const expected = events.find(event => event.eventId === row.eventId);
    expect(Boolean(expected) && expected!.text === row.text, 'emitted-fact-text');
    // Either the complete fixture citations, or references to them: exact ID and digest for every fixture source,
    // with the quote present unless it is byte-identical to the fact text. Computed here from fixture literals.
    const references = expected?.sourceRefs.map(ref => ref.quote === expected.text ? { id: ref.id, digest: ref.digest } : { id: ref.id, digest: ref.digest, quote: ref.quote });
    expect(Boolean(expected) && (row.sources === undefined ? canonicalJson(expected!.sourceRefs) === canonicalJson(row.sourceRefs)
      : row.sourceRefs === undefined && canonicalJson(references) === canonicalJson(row.sources)), 'emitted-citation-payload');
    // Time fields may be left out only where the boundary tag declares the default they take.
    const declared = pack.text.includes(' omitted="observedAt=validFrom validUntil=null"');
    const observedAt = 'observedAt' in row ? row.observedAt : declared ? row.validFrom : undefined;
    const validUntil = 'validUntil' in row ? row.validUntil : declared ? null : undefined;
    expect(Boolean(expected) && expected!.validFrom === row.validFrom && expected!.observedAt === observedAt && expected!.validUntil === validUntil,
      'emitted-time-fields');
  }
  // Nothing in the pack may identify an event outside the admitted scope. Checked against literal fixture fields,
  // even for invalid queries (then no fixture event counts as visible).
  const q = (entry.query ?? {}) as Partial<MemoryPackQuery>;
  const visible = (event: MemoryFactEvent) => validMemoryPackQuery(entry.query) && event.projectId === q.projectId && event.ownerId === q.ownerId
    && Array.isArray(event.audienceIds) && event.audienceIds.includes(q.audienceId!);
  const named = [...pack.receipt.exclusions.map(item => item.eventId), ...pack.receipt.selectedEventIds];
  expect(named.every(eventId => events.some(event => event.eventId === eventId && visible(event))), 'receipt-scope-leak');
  const hidden = events.filter(event => !visible(event) && !events.some(other => other !== event && other.eventId === event.eventId && visible(other)));
  const surfaces = [pack.text, ...pack.receipt.stopReasons];
  expect(!hidden.some(event => surfaces.some(surface => (typeof event.eventId === 'string' && surface.includes(event.eventId))
    || (typeof event.text === 'string' && event.text.trim().length > 0 && surface.includes(event.text)
      && !events.some(other => visible(other) && typeof other.text === 'string' && other.text.includes(event.text))))), 'out-of-scope-content');
  for (const expected of entry.gold.exclusions) expect(pack.receipt.exclusions.some(actual => actual.eventId === expected.eventId && actual.reason === expected.reason), 'exclusion:' + expected.eventId);
  const quoted = (text: string) => JSON.stringify(text).slice(1, -1).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  for (const text of entry.gold.mustContain) expect(pack.text.includes(quoted(text)), 'missing-gold-text');
  for (const text of entry.gold.mustNotContain) expect(!pack.text.includes(quoted(text)), 'forbidden-source-text');
  return [...new Set(failures)];
}
export type MemoryEvalPackBuilder = (snapshot: unknown, query: unknown) => MemoryContextPack;
export function runMemoryEvaluation(corpusText: string, sourceBinding: MemoryEvalSourceBinding,
  options: { repeats?: number; governed?: MemoryEvalPackBuilder; baseline?: MemoryEvalPackBuilder } = {}): MemoryEvalReport {
  // Only bounded JSON bytes enter the harness, not arbitrary objects/getters.
  const corpus = parseMemoryEvalCorpus(corpusText);
  if (!object(sourceBinding, ['sha', 'tree', 'dirty', 'workingSourceDigest']) || !/^[a-f0-9]{40}$/.test(sourceBinding.sha)
    || !/^[a-f0-9]{40}$/.test(sourceBinding.tree) || typeof sourceBinding.dirty !== 'boolean'
    || !/^sha256_[a-f0-9]{64}$/.test(sourceBinding.workingSourceDigest)) throw new Error('Memory evaluation source binding refused.');
  const repeats = options.repeats ?? 3;
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > MEMORY_EVAL_CAPS.repeats) throw new Error('Memory evaluation repetition budget refused.');
  const arms: MemoryEvalArmResult[] = [];
  for (const [arm, builder] of [['governed', options.governed ?? buildMemoryContextPack], ['flat-latest-record-diagnostic', options.baseline ?? buildFlatLatestMemoryDiagnostic]] as const) {
    const results: MemoryEvalCaseResult[] = [];
    for (const entry of corpus.cases) {
      const result: MemoryEvalCaseResult = { caseId: entry.id, family: entry.family, verdict: 'unknown', failures: [], status: null,
        selectedEventIds: [], sourceIds: [], exclusions: [], packBytes: null, observationDigest: null, firstCallMs: 0, repeatMs: [] };
      try {
        let first: MemoryContextPack | null = null;
        for (let run = 0; run <= repeats; run++) {
          // Both arms receive identical complete bytes, with no oracle or shared mutable history.
          const inputs = JSON.parse(canonicalJson({ snapshot: entry.snapshot, query: entry.query })) as { snapshot: unknown; query: unknown };
          const start = performance.now();
          let pack: MemoryContextPack;
          try { pack = builder(inputs.snapshot, inputs.query); }
          finally { const elapsed = performance.now() - start; if (run === 0) result.firstCallMs = elapsed; else result.repeatMs.push(elapsed); }
          const observation = hash(canonicalJson(pack));
          if (run === 0) { first = pack; result.observationDigest = observation; }
          else if (result.observationDigest !== observation) result.failures.push('repeat-output-changed');
        }
        if (!first) throw new Error('No observation');
        result.status = first.status; result.selectedEventIds = first.items.map(item => item.eventId);
        result.sourceIds = first.items.flatMap(item => item.sourceRefs.map(ref => ref.id)).sort(); result.exclusions = first.receipt.exclusions;
        result.packBytes = first.bytes; result.failures.push(...judge(entry, first)); result.failures = [...new Set(result.failures)];
        result.verdict = result.failures.length ? 'fail' : 'pass';
      } catch { result.verdict = 'unknown'; result.failures = ['runner-error']; }
      results.push(result);
    }
    arms.push({ arm, assigned: results.length, passed: results.filter(result => result.verdict === 'pass').length,
      failed: results.filter(result => result.verdict === 'fail').length, unknown: results.filter(result => result.verdict === 'unknown').length, cases: results,
      timing: { clock: 'performance.now', firstCall: memoryEvalDistribution(results.map(result => result.firstCallMs)),
        repeats: memoryEvalDistribution(results.flatMap(result => result.repeatMs)) } });
  }
  return { schemaVersion: 1, protocol: corpus.protocol, corpusDigest: hash(canonicalJson(corpus)), seed: corpus.seed,
    sourceBinding: { ...sourceBinding }, environment: { node: process.version, platform: platform(), arch: arch(), osRelease: release(),
      cpuModels: [...new Set(cpus().map(cpu => cpu.model))].slice(0, 10) }, accessPolicy: corpus.accessPolicy,
    temporalInterpretation: 'valid-time-and-explicit-knowledge-cutoff-with-current-tombstones', modelTaskSuccess: 'not-evaluated', executionAuthority: false,
    timingsScope: 'in-process-first-call-and-repeated-pure-kernel-not-cold-process-or-fleet', arms };
}
