/** Offline synthetic contracts only. No model success or effect-authority verdict. */
import type { MemoryContextPack, MemoryExclusion } from '../memory/types.js';
export const MEMORY_EVAL_FAMILIES = ['temporal', 'delayed-import', 'conflicts', 'project-scope', 'owner-audience',
  'review-authority', 'malformed', 'tombstones', 'lineage', 'replay-concurrency', 'utf8-budget', 'none-refusal'] as const;
export type MemoryEvalFamily = typeof MEMORY_EVAL_FAMILIES[number];
export interface MemoryEvalGold {
  status: MemoryContextPack['status']; selectedEventIds: string[]; sourceIds: string[];
  mustContain: string[]; mustNotContain: string[]; exclusions: MemoryExclusion[];
}
export interface MemoryEvalCase {
  id: string; family: MemoryEvalFamily; variant: number; why: string;
  snapshot: unknown; query: unknown; gold: MemoryEvalGold;
}
export interface MemoryEvalCorpus {
  schemaVersion: 1; protocol: 'phantom-memory-offline-v1'; seed: number; license: 'CC0-1.0';
  source: 'synthetic-authored-no-private-history'; accessPolicy: string; families: MemoryEvalFamily[]; cases: MemoryEvalCase[];
}
export interface MemoryEvalSourceBinding {
  /** Caller-observed checkout identity; the pure harness cannot attest installed bytes. */
  sha: string; tree: string; dirty: boolean; workingSourceDigest: string;
}
export interface MemoryEvalCaseResult {
  caseId: string; family: MemoryEvalFamily; verdict: 'pass' | 'fail' | 'unknown'; failures: string[];
  status: MemoryContextPack['status'] | null; selectedEventIds: string[]; sourceIds: string[];
  exclusions: MemoryExclusion[]; packBytes: number | null; observationDigest: string | null;
  firstCallMs: number; repeatMs: number[];
}
export interface MemoryEvalArmResult {
  arm: 'governed' | 'flat-latest-record-diagnostic'; assigned: number; passed: number; failed: number; unknown: number;
  cases: MemoryEvalCaseResult[];
  timing: { clock: 'performance.now'; firstCall: MemoryEvalDistribution; repeats: MemoryEvalDistribution };
}
export interface MemoryEvalDistribution { count: number; minMs: number; medianMs: number; p95Ms: number; maxMs: number }
export interface MemoryEvalReport {
  schemaVersion: 1; protocol: 'phantom-memory-offline-v1'; corpusDigest: string; seed: number; sourceBinding: MemoryEvalSourceBinding;
  environment: { node: string; platform: string; arch: string; osRelease: string; cpuModels: string[] };
  accessPolicy: string; temporalInterpretation: 'valid-time-and-explicit-knowledge-cutoff-with-current-tombstones'; modelTaskSuccess: 'not-evaluated';
  executionAuthority: false; timingsScope: 'in-process-first-call-and-repeated-pure-kernel-not-cold-process-or-fleet';
  arms: MemoryEvalArmResult[];
}
