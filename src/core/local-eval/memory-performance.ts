/** Bounded synthetic CPU profile. Repeated calls are not cache hits or fleet/HTTP latency measurements. */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { canonicalJson } from '../authority/canonical-json.js';
import { buildMemoryContextPack } from '../memory/pack.js';
import { immutableMemorySnapshot, memoryUtf8Bytes } from '../memory/validate.js';
import type { MemoryFactEvent, MemoryPackQuery, MemorySnapshot } from '../memory/types.js';
import { memoryEvalDistribution } from './memory-evaluation.js';
import type { MemoryEvalDistribution } from './memory-evaluation-types.js';
const AT = '2026-10-01T00:00:00.000Z';
const hash = (text: string) => 'sha256_' + createHash('sha256').update(text, 'utf8').digest('hex');
export interface MemoryPerformanceProfile {
  schemaVersion: 1; protocol: 'phantom-memory-kernel-profile-v1'; seed: number; events: number; corpusDigest: string;
  sourceLicense: 'CC0-1.0'; firstCallMs: number; repeats: MemoryEvalDistribution; samplesMs: number[];
  packBytes: number; selected: number; omitted: number; packDigest: string;
  scope: 'in-process-kernel-validation-selection-framing-no-model-io-cache-or-fleet'; authority: false;
}
export interface MemoryPreparedPairedProfile {
  schemaVersion: 1; protocol: 'phantom-memory-prepared-paired-profile-v1'; seed: number; events: number; corpusDigest: string;
  sourceLicense: 'CC0-1.0'; preparationMs: number; pairs: number;
  schedule: 'alternating-raw-first-prepared-first'; preparedSnapshotReused: true;
  arms: Array<{ arm: 'raw' | 'prepared'; samplesMs: number[]; distribution: MemoryEvalDistribution;
    packDigest: string; packBytes: number; selected: number; omitted: number }>;
  scope: 'in-process-owned-snapshot-reuse-every-query-recomputes-no-runtime-cache-or-slo'; authority: false;
}
/** Explicit LCG and UTC time make the synthetic history reproducible across machines. */
export function syntheticMemoryProfile(seed: number, count: number): { snapshot: MemorySnapshot; query: MemoryPackQuery } {
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > 0xffffffff || !Number.isSafeInteger(count) || count < 1 || count > 4096) throw new Error('Memory profile bounds refused.');
  let state = seed >>> 0;
  const events: MemoryFactEvent[] = [];
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const eventId = 'profile:event:' + String(i).padStart(4, '0');
    const text = 'Synthetic build observation ' + state.toString(36) + ': retain complete cited evidence.';
    events.push({ schemaVersion: 1, eventId, factId: 'profile:fact:' + i, revision: 1, kind: 'fact', projectId: 'profile:project',
      ownerId: 'profile:owner', audienceIds: ['profile:audience'], subjectKey: 'build', slotKey: 'slot:' + i, text,
      sourceRefs: [{ id: 'profile:source:' + i, digest: hash(text), locator: 'synthetic-row:' + i, quote: text, observedAt: AT }],
      observedAt: AT, validFrom: AT, validUntil: null, recordedAt: AT, reviewState: 'approved', reviewedAt: AT,
      reviewerDecisionId: 'profile:review:' + i, supersedes: [], derivedFrom: [], tombstones: [], authority: false });
  }
  return { snapshot: { schemaVersion: 1, snapshotId: 'profile:snapshot:' + seed + ':' + count, revision: count,
    recordedThrough: AT, sourceState: 'available', complete: true, events, authority: false },
    query: { schemaVersion: 1, projectId: 'profile:project', ownerId: 'profile:owner', audienceId: 'profile:audience',
      time: { mode: 'current', at: AT }, knownAt: null, query: 'build observation', maxBytes: 6144, maxFacts: 64, authority: false } };
}
export function profileMemoryKernel(seed = 20261014, count = 1024, repeats = 10): MemoryPerformanceProfile {
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 30) throw new Error('Memory profile repetition bounds refused.');
  const input = syntheticMemoryProfile(seed, count); const corpus = canonicalJson(input); const corpusDigest = hash(corpus);
  let firstCallMs = 0; const samples: number[] = []; let packDigest: string | null = null; let packBytes = 0; let selected = 0; let omitted = 0;
  for (let run = 0; run <= repeats; run++) {
    const start = performance.now(); const pack = buildMemoryContextPack(input.snapshot, input.query); const elapsed = performance.now() - start;
    if (run === 0) firstCallMs = elapsed; else samples.push(elapsed);
    const next = hash(canonicalJson(pack));
    if (pack.status !== 'ready' || pack.bytes > input.query.maxBytes || pack.authority !== false
      || packDigest !== null && packDigest !== next) throw new Error('Memory kernel profile output refused.');
    packDigest = next; packBytes = pack.bytes; selected = pack.items.length; omitted = pack.receipt.exclusions.length;
  }
  if (hash(canonicalJson(input)) !== corpusDigest) throw new Error('Memory kernel profile input changed.');
  return { schemaVersion: 1, protocol: 'phantom-memory-kernel-profile-v1', seed, events: count, corpusDigest, sourceLicense: 'CC0-1.0',
    firstCallMs, repeats: memoryEvalDistribution(samples), samplesMs: samples, packBytes, selected, omitted, packDigest: packDigest!,
    scope: 'in-process-kernel-validation-selection-framing-no-model-io-cache-or-fleet', authority: false };
}
/** Separate paired experiment: original raw profile and all its samples remain unchanged. */
export function profilePreparedMemoryKernel(seed = 20261014, count = 1024, pairs = 10): MemoryPreparedPairedProfile {
  if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 30) throw new Error('Memory paired profile repetition bounds refused.');
  const input = syntheticMemoryProfile(seed, count); const corpusDigest = hash(canonicalJson(input));
  const started = performance.now(); const prepared = immutableMemorySnapshot(input.snapshot); const preparationMs = performance.now() - started;
  if (!prepared || prepared === input.snapshot || !Object.isFrozen(prepared) || immutableMemorySnapshot(prepared) !== prepared)
    throw new Error('Memory paired profile preparation refused.');
  const samples: Record<'raw' | 'prepared', number[]> = { raw: [], prepared: [] };
  let packDigest: string | null = null; let packBytes = 0; let selected = 0; let omitted = 0;
  for (let pair = 0; pair < pairs; pair++) {
    // Alternate which arm runs first, retaining every observation without a
    // selective warmup. Both arms use the same complete history and query.
    const order: Array<'raw' | 'prepared'> = pair % 2 ? ['prepared', 'raw'] : ['raw', 'prepared'];
    for (const arm of order) {
      const start = performance.now(); const pack = buildMemoryContextPack(arm === 'raw' ? input.snapshot : prepared, input.query);
      samples[arm].push(performance.now() - start);
      const next = hash(canonicalJson(pack));
      if (pack.status !== 'ready' || pack.bytes !== memoryUtf8Bytes(pack.text) || pack.bytes > input.query.maxBytes
        || pack.items.length > input.query.maxFacts || pack.authority !== false || packDigest !== null && packDigest !== next)
        throw new Error('Memory paired profile output mismatch.');
      packDigest = next; packBytes = pack.bytes; selected = pack.items.length; omitted = pack.receipt.exclusions.length;
    }
  }
  if (hash(canonicalJson(input)) !== corpusDigest || canonicalJson(prepared) !== canonicalJson(input.snapshot))
    throw new Error('Memory paired profile history changed.');
  return { schemaVersion: 1, protocol: 'phantom-memory-prepared-paired-profile-v1', seed, events: count, corpusDigest,
    sourceLicense: 'CC0-1.0', preparationMs, pairs, schedule: 'alternating-raw-first-prepared-first', preparedSnapshotReused: true,
    arms: (['raw', 'prepared'] as const).map(arm => ({ arm, samplesMs: samples[arm], distribution: memoryEvalDistribution(samples[arm]),
      packDigest: packDigest!, packBytes, selected, omitted })),
    scope: 'in-process-owned-snapshot-reuse-every-query-recomputes-no-runtime-cache-or-slo', authority: false };
}
