/**
 * Service-tier classification for local model evidence. Pure: no subprocess,
 * no filesystem, no host state — safe to import from probe and planning paths.
 * Capability thresholds, not a claim about model quality.
 */
export type ModelTier = 'fast' | 'work' | 'frontier';

export const MODEL_TIER_TABLE: ReadonlyArray<{
  tier: ModelTier; decode: number; prefill: number; context: number; minimumBits: number;
}> = Object.freeze([
  { tier: 'fast', decode: 40, prefill: 100, context: 8192, minimumBits: 4 },
  { tier: 'work', decode: 15, prefill: 50, context: 32768, minimumBits: 4 },
  { tier: 'frontier', decode: 8, prefill: 25, context: 65536, minimumBits: 8 },
]);

export interface ModelTierInput {
  contextLength: number | null; quantization: string | null;
  decodeTokensPerSecond: number | null; prefillTokensPerSecond: number | null;
  status: 'measured' | 'unavailable' | 'refused' | 'unsupported';
}

function bits(quant: string | null): number {
  if (/^MXFP4$/i.test(quant ?? '')) return 4;
  const match = /(?:^q|^iq|\b)(\d+)(?:[_. -]|bit|$)/i.exec(quant ?? '');
  if (match) return Number(match[1]);
  return /^(?:bf16|fp16|f16)$/i.test(quant ?? '') ? 16 : 0;
}

export function modelTiers(row: ModelTierInput): ModelTier[] {
  if (row.status !== 'measured') return [];
  return MODEL_TIER_TABLE.filter(rule => (row.contextLength ?? 0) >= rule.context &&
    bits(row.quantization) >= rule.minimumBits && (row.decodeTokensPerSecond ?? 0) >= rule.decode &&
    (row.prefillTokensPerSecond ?? 0) >= rule.prefill).map(rule => rule.tier);
}
