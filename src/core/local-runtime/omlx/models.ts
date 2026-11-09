/**
 * Small-Mac oMLX lane planning (RQ-OMLX-DISTILL-1).
 *
 * The recorded candidate catalog below mirrors benchmarks/omlx-model-candidates.json
 * (a test pins them identical — change both together). Every number is either
 * oMLX-measured, vendor-reported with a source, or a conservative estimate that
 * is labelled as such. `null` means unmeasured, never a guess.
 *
 * Ranking: reach the best service tier the evidence supports, then quality,
 * then decode speed. Fit is against a RAM envelope of half physical memory —
 * the other half is the host's, and oMLX's memguard re-admits at run time.
 */
import { modelTiers, type ModelTier } from '../../resources/model-tiers.js';
import { assessHostHeadroom, type HostHeadroom } from '../../run/host-headroom.js';

const MIB = 1024 ** 2;
export const LANE_MODEL_ENVELOPE_FRACTION = 0.5;
/** Resident runtime beyond weights + KV: server process, activations, scratch. */
export const LANE_PROCESS_OVERHEAD_BYTES = 1024 ** 3;
export const LANE_MAX_SLOTS = 4;
export const LANE_DEFAULT_SLOTS = 2;

/** Caps a node may advertise; anything else named omlx-* is not ours. */
export const LOCAL_MODEL_CAPS = ['omlx', 'omlx-fast', 'omlx-work', 'omlx-frontier'] as const;
export const isLocalModelCap = (cap: string): boolean => (LOCAL_MODEL_CAPS as readonly string[]).includes(cap);

export interface OmlxModelQuality {
  humaneval: number | null; mbpp: number | null; livecodebench: number | null; bfcl: number | null;
  source: string;
}
export interface OmlxModelEvidence {
  /** oMLX-measured rates; null when only vendor-reported. */
  decodeTokPerSec: number | null;
  prefillTokPerSec: number | null;
  peakBytes: number | null;
  bench: { suite: string; host: string; date: string; url: string } | null;
  quality: OmlxModelQuality;
  /** Fleet merge-rate evidence for this model; null = unmeasured locally. */
  mergeRate: number | null;
}
export interface OmlxModelCandidate {
  id: string;
  /** Hugging Face repo under a protected model cache root; weights never enter git. */
  repo: string;
  engine: 'omlx';
  paramsBillion: number;
  kind: 'coder' | 'instruct' | 'distill-reasoning' | 'moe';
  quantization: string;
  /** Native context; the lane may serve less. */
  contextLength: number;
  /** Context this lane actually serves; kvSlotBytes is measured at this length. */
  servedContext: number;
  weightsBytes: number;
  kvSlotBytes: number;
  evidence: OmlxModelEvidence;
  notes?: string;
}
export interface OmlxModelCatalog { schemaVersion: 1; recordedAt: string; candidates: OmlxModelCandidate[] }

const GIB = 1024 ** 3;
const QWEN_BENCH = 'qwen2.5-coder technical report (arXiv:2409.12186)';
export const OMLX_MODEL_CANDIDATES: OmlxModelCandidate[] = [
  {
    id: 'qwen2.5-coder-7b-instruct-4bit', repo: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit',
    engine: 'omlx', paramsBillion: 7.6, kind: 'coder', quantization: '4bit',
    contextLength: 131_072, servedContext: 32_768,
    weightsBytes: 4_300_000_000, kvSlotBytes: 500_000_000,
    evidence: {
      decodeTokPerSec: 23.3, prefillTokPerSec: 257.8, peakBytes: 5_370_000_000,
      bench: { suite: 'omlx community performance', host: 'M4 16GB, oMLX v0.5.8', date: '2026', url: 'https://omlx.ai/benchmarks/performance/o21qlz68' },
      quality: { humaneval: 88.4, mbpp: 83.5, livecodebench: 55.3, bfcl: null, source: QWEN_BENCH },
      mergeRate: null,
    },
    notes: 'Work-tier pick on 16 GB: measured 23.3 TG/s decode at 5.4 GB peak leaves room for a second slot (batch 4x: 76.7 TG/s aggregate).',
  },
  {
    id: 'qwen3-4b-instruct-2507-4bit', repo: 'mlx-community/Qwen3-4B-Instruct-2507-4bit',
    engine: 'omlx', paramsBillion: 4.0, kind: 'instruct', quantization: '4bit',
    contextLength: 262_144, servedContext: 16_384,
    weightsBytes: 2_400_000_000, kvSlotBytes: 600_000_000,
    evidence: {
      decodeTokPerSec: 10.8, prefillTokPerSec: null, peakBytes: 2_400_000_000,
      bench: { suite: 'ondevice-bench (MLX)', host: 'M3 16GB MacBook Air', date: '2026', url: 'https://github.com/robertlangdonn/ondevice-bench' },
      quality: { humaneval: 77.56, mbpp: null, livecodebench: 31.74, bfcl: 53.0, source: 'Qwen3-4B-Instruct-2507 model card / hf-model-benchmarks' },
      mergeRate: null,
    },
    notes: 'The 8 GB pick: ~2.4 GB weights, serves 16k context under the half-RAM envelope. BFCL 53 is the best small-model tool-calling evidence recorded.',
  },
  {
    id: 'qwen3-8b-4bit', repo: 'mlx-community/Qwen3-8B-4bit',
    engine: 'omlx', paramsBillion: 8.2, kind: 'instruct', quantization: '4bit',
    contextLength: 131_072, servedContext: 32_768,
    weightsBytes: 4_620_000_000, kvSlotBytes: 1_200_000_000,
    evidence: {
      decodeTokPerSec: 16.6, prefillTokPerSec: 219.0, peakBytes: null,
      bench: { suite: 'llamaperf community reports (2 runs)', host: 'M4 16GB', date: '2026-11', url: 'https://llamaperf.com/model/qwen3' },
      quality: { humaneval: null, mbpp: null, livecodebench: null, bfcl: null, source: 'no consistent coding-suite record' },
      mergeRate: null,
    },
    notes: 'Reaches work tier on speed, but its coding evidence is unrecorded, so it ranks below the coder pick at equal RAM.',
  },
  {
    id: 'deepseek-r1-distill-qwen-7b-4bit', repo: 'mlx-community/DeepSeek-R1-Distill-Qwen-7B-4bit',
    engine: 'omlx', paramsBillion: 7.6, kind: 'distill-reasoning', quantization: '4bit',
    contextLength: 131_072, servedContext: 32_768,
    weightsBytes: 4_400_000_000, kvSlotBytes: 500_000_000,
    evidence: {
      decodeTokPerSec: null, prefillTokPerSec: null, peakBytes: null,
      bench: null,
      quality: { humaneval: null, mbpp: null, livecodebench: 37.6, bfcl: null, source: 'DeepSeek-R1 paper (distill table)' },
      mergeRate: null,
    },
    notes: 'The evaluated distill path: reasoning traces burn decode budget on tool calls, coding evidence is weaker, and no oMLX-measured rates exist. Rejected by evidence, not by rule.',
  },
  {
    id: 'qwen2.5-coder-14b-instruct-4bit', repo: 'mlx-community/Qwen2.5-Coder-14B-Instruct-4bit',
    engine: 'omlx', paramsBillion: 14.7, kind: 'coder', quantization: '4bit',
    contextLength: 131_072, servedContext: 32_768,
    weightsBytes: 8_300_000_000, kvSlotBytes: 1_600_000_000,
    evidence: {
      decodeTokPerSec: 10.6, prefillTokPerSec: 122.6, peakBytes: 10_630_000_000,
      bench: { suite: 'omlx community performance', host: 'M4 16GB, oMLX v0.5.7', date: '2026-08-15', url: 'https://omlx.ai/benchmarks/wuicyqlf' },
      quality: { humaneval: 89.6, mbpp: 86.2, livecodebench: 23.4, bfcl: null, source: QWEN_BENCH },
      mergeRate: null,
    },
    notes: 'Benchmark-driven exclusion on 16 GB: oMLX measured 10.6 TG/s (below the 15 TG/s work floor) at a 10.6 GB peak that pushed the host to 89% RAM. Bigger is not better once it grazes swap.',
  },
];

export const OMLX_MODEL_CATALOG: OmlxModelCatalog = {
  schemaVersion: 1, recordedAt: '2026-11-05', candidates: OMLX_MODEL_CANDIDATES,
};

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const pos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const optNum = (v: unknown): v is number | null => v === null || pos(v);
const ID = /^[a-z0-9][a-z0-9.-]{0,127}$/;

function parseCandidate(v: unknown): OmlxModelCandidate {
  if (!object(v) || typeof v.id !== 'string' || !ID.test(v.id) || typeof v.repo !== 'string' ||
      !/^[\w.-]+\/[\w.-]+$/.test(v.repo) || v.engine !== 'omlx' || !pos(v.paramsBillion) ||
      !['coder', 'instruct', 'distill-reasoning', 'moe'].includes(String(v.kind)) ||
      v.quantization !== '4bit' || !pos(v.contextLength) || !pos(v.servedContext) ||
      v.servedContext > v.contextLength || !pos(v.weightsBytes) || !pos(v.kvSlotBytes)) {
    throw new Error('Invalid oMLX model candidate');
  }
  const e = v.evidence;
  if (!object(e) || !optNum(e.decodeTokPerSec) || !optNum(e.prefillTokPerSec) ||
      !optNum(e.peakBytes) || !optNum(e.mergeRate)) throw new Error('Invalid oMLX model evidence');
  const q = e.quality;
  if (!object(q) || !optNum(q.humaneval) || !optNum(q.mbpp) || !optNum(q.livecodebench) ||
      !optNum(q.bfcl) || typeof q.source !== 'string') {
    throw new Error('Invalid oMLX model quality evidence');
  }
  const bench = e.bench === null ? null : object(e.bench) ? e.bench : null;
  if (e.bench !== null && (!bench || typeof bench.suite !== 'string' || typeof bench.host !== 'string' ||
      typeof bench.date !== 'string' || typeof bench.url !== 'string' || !/^https:\/\/[\w.-]+\//.test(bench.url))) {
    throw new Error('Invalid oMLX model benchmark reference');
  }
  if (v.notes !== undefined && typeof v.notes !== 'string') throw new Error('Invalid oMLX model candidate');
  return v as unknown as OmlxModelCandidate;
}

export function parseOmlxModelCatalog(value: unknown): OmlxModelCatalog {
  if (!object(value) || value.schemaVersion !== 1 || typeof value.recordedAt !== 'string' ||
      !Array.isArray(value.candidates) || !value.candidates.length) throw new Error('Invalid oMLX model catalog');
  const candidates = value.candidates.map(parseCandidate);
  if (new Set(candidates.map(c => c.id)).size !== candidates.length) throw new Error('Duplicate oMLX model candidate');
  return { schemaVersion: 1, recordedAt: value.recordedAt, candidates };
}

/** Mean of the recorded coding-suite scores; null when nothing is recorded. */
export function qualityScore(candidate: OmlxModelCandidate): number | null {
  const q = candidate.evidence.quality;
  const scores = [q.humaneval, q.mbpp, q.livecodebench].filter((s): s is number => s !== null);
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

/** Tiers the recorded evidence supports; unmeasured rates satisfy nothing. */
export function evidenceTiers(candidate: OmlxModelCandidate): ModelTier[] {
  return modelTiers({
    contextLength: candidate.servedContext, quantization: candidate.quantization,
    prefillTokensPerSecond: candidate.evidence.prefillTokPerSec,
    decodeTokensPerSecond: candidate.evidence.decodeTokPerSec,
    status: 'measured',
  });
}

const MODEL_TIER_ORDER: ModelTier[] = ['fast', 'work', 'frontier'];

/** Rank key: best tier (frontier>work>fast>none), then quality, decode. */
function rank(candidate: OmlxModelCandidate, tiers: ModelTier[]): number {
  const tierRank = Math.max(0, ...tiers.map(t => MODEL_TIER_ORDER.indexOf(t) + 1));
  return tierRank * 1e6 + (qualityScore(candidate) ?? -1) * 1e3 + (candidate.evidence.decodeTokPerSec ?? 0);
}

export interface OmlxLaneConfig { enabled: boolean; model?: string; maxSlots?: number }
export interface OmlxLaneInput {
  /** Physical RAM in bytes (os.totalmem()). */
  totalBytes: number;
  /** Host headroom reading; null when telemetry is unavailable. */
  headroom: HostHeadroom | null;
  /** Parsed local-lanes.json; null or enabled:false disables the lane. */
  config?: OmlxLaneConfig | null;
  catalog?: OmlxModelCatalog;
  /** oMLX only runs on Apple Silicon macOS; anything else never advertises. */
  platform?: string;
}
export interface OmlxLaneRejection { id: string; reason: string }
export interface OmlxLanePlan {
  schemaVersion: 1;
  enabled: boolean;
  ramBytes: number;
  budgetBytes: number;
  /** Why no lane is advertised; null when the node may advertise. */
  backoff: 'disabled' | 'unsupported-platform' | 'telemetry-unavailable' | 'memory-pressure' | 'no-fitting-model' | null;
  backoffReason: string | null;
  slots: number;
  caps: string[];
  model: { id: string; repo: string; quantization: string; servedContext: number; tiers: ModelTier[] } | null;
  rejected: OmlxLaneRejection[];
  /** Ready for `phm node join --caps` (empty when backed off). */
  suggestedCaps: string;
}

/** Deterministic pick: everything is a function of its inputs, never of ambient host state. */
export function planOmlxLocalLanes(input: OmlxLaneInput): OmlxLanePlan {
  const total = input.totalBytes;
  const catalog = input.catalog ?? OMLX_MODEL_CATALOG;
  const base = (partial: Partial<OmlxLanePlan>): OmlxLanePlan => ({
    schemaVersion: 1, enabled: input.config?.enabled === true, ramBytes: total,
    budgetBytes: 0, backoff: null, backoffReason: null, slots: 0, caps: [],
    model: null, rejected: [], suggestedCaps: '', ...partial,
  });
  if ((input.platform ?? process.platform) !== 'darwin') {
    return base({ backoff: 'unsupported-platform', backoffReason: 'oMLX lanes run on Apple Silicon macOS only' });
  }
  if (!Number.isSafeInteger(total) || total <= 0) return base({ backoff: 'telemetry-unavailable', backoffReason: 'Unknown physical RAM' });
  const budget = Math.floor(total * LANE_MODEL_ENVELOPE_FRACTION / MIB) * MIB;
  if (input.config?.enabled !== true) return base({ budgetBytes: budget, backoff: 'disabled', backoffReason: 'Enable with ~/.ashlr/local-lanes.json {"schemaVersion":1,"enabled":true}' });
  const decision = assessHostHeadroom(input.headroom);
  if (!decision.allowed) {
    return base({ budgetBytes: budget,
      backoff: input.headroom === null ? 'telemetry-unavailable' : 'memory-pressure',
      backoffReason: decision.reason ?? 'Host memory telemetry unavailable; lane held' });
  }
  const pinned = input.config.model;
  const rejected: OmlxLaneRejection[] = [];
  let best: { c: OmlxModelCandidate; tiers: ModelTier[]; rank: number } | null = null;
  for (const c of catalog.candidates) {
    if (pinned !== undefined && c.id !== pinned) { rejected.push({ id: c.id, reason: 'not the configured model' }); continue; }
    const need = c.weightsBytes + c.kvSlotBytes + LANE_PROCESS_OVERHEAD_BYTES;
    if (need > budget) { rejected.push({ id: c.id, reason: `needs ${(need / GIB).toFixed(1)} GiB > ${(budget / GIB).toFixed(1)} GiB envelope` }); continue; }
    const tiers = evidenceTiers(c);
    const r = rank(c, tiers);
    if (!best || r > best.rank) best = { c, tiers, rank: r };
  }
  if (!best) {
    const wanted = pinned !== undefined && !catalog.candidates.some(c => c.id === pinned)
      ? `configured model '${pinned}' is not in the catalog` : 'no candidate fits the memory envelope';
    return base({ budgetBytes: budget, backoff: 'no-fitting-model', backoffReason: wanted, rejected });
  }
  const maxSlots = Math.min(input.config.maxSlots ?? LANE_DEFAULT_SLOTS, LANE_MAX_SLOTS);
  const spare = budget - best.c.weightsBytes - LANE_PROCESS_OVERHEAD_BYTES - best.c.kvSlotBytes;
  const slots = Math.max(1, Math.min(maxSlots, 1 + Math.floor(spare / best.c.kvSlotBytes)));
  const caps = ['omlx', ...best.tiers.map(t => `omlx-${t}`)];
  return base({
    budgetBytes: budget, slots, caps,
    model: { id: best.c.id, repo: best.c.repo, quantization: best.c.quantization, servedContext: best.c.servedContext, tiers: best.tiers },
    rejected, suggestedCaps: caps.join(','),
  });
}
