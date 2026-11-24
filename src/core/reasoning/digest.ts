import { DigestBuilder } from './insights.js';
import { DAY_MS, reasoningRoot, scanFeatures, scanSteps, storeGeneration } from './store.js';
import type { ReasoningDigest } from './types.js';

export const DEFAULT_DIGEST_DAYS = 14;

const DIGEST_CACHE_TTL_MS = 60_000;
const DIGEST_MIN_FRESH_MS = 10_000;
const digestCache = new Map<string, { generation: number; atMs: number; digest: ReasoningDigest }>();

export async function computeReasoningDigest(
  days = DEFAULT_DIGEST_DAYS,
  options: { root?: string; nowMs?: number } = {},
): Promise<ReasoningDigest> {
  const nowMs = options.nowMs ?? Date.now();
  const key = `${options.root ?? reasoningRoot()}|${days}`;
  const cached = digestCache.get(key);
  if (options.nowMs === undefined && cached && (
    nowMs - cached.atMs < DIGEST_MIN_FRESH_MS ||
    (cached.generation === storeGeneration() && nowMs - cached.atMs < DIGEST_CACHE_TTL_MS)
  )) {
    return cached.digest;
  }
  const generation = storeGeneration();
  const window = { fromMs: nowMs - days * DAY_MS, toMs: nowMs };
  const builder = new DigestBuilder(window);
  const scanOptions = options.root ? { root: options.root } : {};
  await scanSteps(window, (step) => { builder.addStep(step); }, scanOptions);
  await scanFeatures(window, (feature) => { builder.addFeature(feature); }, scanOptions);
  const digest = builder.build(nowMs);
  if (options.nowMs === undefined) digestCache.set(key, { generation, atMs: nowMs, digest });
  return digest;
}

export function resetReasoningDigestCache(): void {
  digestCache.clear();
}
