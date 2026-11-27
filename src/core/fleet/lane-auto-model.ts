import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { checkModelsAgainstDocs, loadVerifiedRegistry, MODEL_ALIASES, readDocsRecords, type DocsModelRecord, type VerifiedModelRegistryEntry } from './model-verify.js';
import { readLaneModelConfig, resolveLaneModel } from './lane-models.js';
import type { FleetEngine } from './fleet-types.js';
import { readRouterOutcomes } from '../router/outcomes.js';
import { indexLaneAutoScores, LANE_AUTO_MIN_SAMPLES, rankLaneAutoScores, type LaneAutoScore } from '../router/lane-auto-score.js';
import { catalogFor, DEFAULT_CLAUDE_MODEL_ID, DEFAULT_LOCAL_MODEL_TAG, GROK_CLI_DEFAULT_MODEL, GROK_CLI_FAST_MODEL, type ModelRoutingTier } from '../run/model-catalog.js';
import { codexModelForTier } from '../run/learned-router.js';
import { subscriptionOnlyCurrent } from '../routing/subscription-only.js';
import { HEADROOM_READING_MAX_AGE_MS, type SeatCapacity } from '../routing/headroom.js';
import { resolveNativeSeatLaunch } from '../resources/native-profile.js';
import { resolveAccountsRoot } from '../verse/seats.js';
import { claudeModelOptions, cliVersionFromExecutable, readCodexCatalog, readGrokCatalog } from '../verse/model-windows.js';
import type { AshlrConfig } from '../types.js';

export interface LaneAutoReceipt {
  schema: 'route.lane-auto.v1';
  lane: FleetEngine;
  tier: ModelRoutingTier;
  via: string;
  model: string | null;
  reason: 'scored' | 'threshold-fallback' | 'held';
  minimumSamples: number;
  candidates: LaneAutoScore[];
}

export interface LaneAutoEvidence {
  models: ReadonlyMap<string, string>;
  registry: readonly VerifiedModelRegistryEntry[];
  docs: readonly DocsModelRecord[];
  score: ReturnType<typeof indexLaneAutoScores>;
  workClassFor?: (jobId: string) => string | null;
  nativeModels: (seat: SeatCapacity) => ReadonlySet<string> | null;
}

const providerOf = { codex: 'openai', 'claude-cli': 'anthropic', 'grok-cli': 'xai', local: null, 'devin-cli': 'devin' } as const;

export function laneAutoBillingAllows(seat: SeatCapacity, nowMs: number): boolean {
  if (seat.onDemandEnabled === true) return false;
  if (seat.engine === 'local') return seat.free && (seat.costBasis === undefined || seat.costBasis === 'free');
  if (seat.free || (seat.costBasis !== undefined && seat.costBasis !== 'subscription')) return false;
  if (seat.engine === 'grok') {
    const observedAt = Date.parse(seat.observedAt ?? '');
    return seat.onDemandEnabled === false && observedAt <= nowMs && nowMs - observedAt < HEADROOM_READING_MAX_AGE_MS
      && (seat.staleAfter == null || Date.parse(seat.staleAfter) > nowMs);
  }
  return subscriptionOnlyCurrent(seat, nowMs);
}

export function chooseLaneAuto(
  evidence: LaneAutoEvidence, lane: FleetEngine, backend: string, tier: ModelRoutingTier,
  seat: SeatCapacity, nowMs: number, localDefault: string | null, builtinEngine: boolean, jobId: string,
): LaneAutoReceipt | null {
  const modelLane = lane === 'codex' && /^codex-[a-z0-9-]+$/.test(seat.seatId) && seat.seatId !== 'codex-local'
    ? seat.seatId : lane;
  const configured = resolveLaneModel(evidence.models, modelLane, tier);
  if (configured?.model !== 'auto') return null;
  const receipt: LaneAutoReceipt = { schema: 'route.lane-auto.v1', lane, tier, via: configured.via, model: null,
    reason: 'held', minimumSamples: LANE_AUTO_MIN_SAMPLES, candidates: [] };
  if (!builtinEngine || !laneAutoBillingAllows(seat, nowMs)) return receipt;
  if (lane === 'codex' && (seat.engine !== 'codex' || backend !== 'codex')
    || lane === 'claude-cli' && (seat.engine !== 'claude' || backend !== 'claude')
    || lane === 'grok-cli' && (seat.engine !== 'grok' || backend !== 'grok-cli')
    || lane === 'local' && seat.engine !== 'local' || lane === 'devin-cli') return receipt;
  const prior = lane === 'codex' ? codexModelForTier(tier) : lane === 'claude-cli' ? DEFAULT_CLAUDE_MODEL_ID
    : lane === 'grok-cli' ? (tier === 'fast' ? GROK_CLI_FAST_MODEL : GROK_CLI_DEFAULT_MODEL) : localDefault;
  const offered = evidence.nativeModels(seat);
  const provider = providerOf[lane];
  const catalog = new Map(catalogFor(backend).map(entry => [entry.id.slice(backend.length + 1), entry]));
  if (lane === 'local' && backend === 'llama-server') {
    const shared = catalogFor('local-coder').find(row => row.id === `local-coder:${DEFAULT_LOCAL_MODEL_TAG}`);
    if (shared) catalog.set(DEFAULT_LOCAL_MODEL_TAG, shared);
  }
  const registry = new Map(evidence.registry.map(entry => [entry.id, entry]));
  const workClass = evidence.workClassFor?.(jobId) ?? null;
  const score = (id: string) => evidence.score(modelLane, tier, id, workClass);
  const ids = new Set([...catalog.keys(), ...evidence.registry.filter(entry => provider && entry.provider === provider).map(entry => entry.id)]);
  const tierLimit = tier === 'frontier' ? 5 : tier === 'work' ? 3 : 2;
  const eligible = [...ids].filter(id => {
    const entry = catalog.get(id), verified = registry.get(id);
    if (MODEL_ALIASES.has(id) || entry?.historical || entry?.explicitOnly || (entry?.seatRouted && lane !== 'grok-cli')) return false;
    if (verified && (verified.status !== 'verified' || provider && verified.provider !== provider)) return false;
    if (verified?.lanes?.length && !verified.lanes.includes(lane) && !verified.lanes.includes(modelLane)) return false;
    if (!entry && (verified?.status !== 'verified' || id !== prior
      && (!offered?.has(id) || score(id).samples < LANE_AUTO_MIN_SAMPLES))) return false;
    if (lane === 'local') return id === prior && (!offered || offered.has(id)) && entry?.costPerMTokIn === 0 && entry.costPerMTokOut === 0;
    if (offered ? !offered.has(id) : id !== prior) return false;
    return !entry || id === prior || entry.minEffort <= tierLimit
      && (tier !== 'frontier' || (entry.tier === 'large' && entry.capabilities.includes('reasoning')));
  });
  const docs = checkModelsAgainstDocs(eligible.flatMap(id => {
    const docsProvider = provider ?? registry.get(id)?.provider;
    return docsProvider ? [{ id, provider: docsProvider }] : evidence.docs.filter(row => row.id === id);
  }), evidence.docs);
  const blocked = new Set(docs.models.filter(row => row.verdict === 'deprecated' || row.verdict === 'retired').map(row => row.id));
  receipt.candidates = eligible.filter(id => !blocked.has(id)).sort().map(score);
  const quality = (row: LaneAutoScore) => ({ ...row, usdPerHeldMerge: null });
  const ranked = receipt.candidates.filter(row => row.samples >= LANE_AUTO_MIN_SAMPLES)
    .sort((left, right) => rankLaneAutoScores(quality(left), quality(right)));
  const tied = ranked.filter(row => rankLaneAutoScores(quality(ranked[0]!), quality(row)) === 0);
  const knownCost = tied.every(row => row.usdPerHeldMerge !== null);
  tied.sort((left, right) => (knownCost ? rankLaneAutoScores(left, right) : 0)
    || Number(right.model === prior) - Number(left.model === prior) || left.model.localeCompare(right.model));
  const picked = tied[0]?.model ?? (receipt.candidates.some(row => row.model === prior) ? prior : null);
  return { ...receipt, model: picked, reason: ranked.length ? 'scored' : picked ? 'threshold-fallback' : 'held' };
}

/** Empty set = unqualified or unreadable profile/catalog; null = no provider catalog yet. */
export function readLaneAutoNativeModels(cfg: AshlrConfig, seat: SeatCapacity): ReadonlySet<string> | null {
  if (seat.engine !== 'codex' && seat.engine !== 'claude' && seat.engine !== 'grok') return null;
  const provider = seat.engine;
  const result = resolveNativeSeatLaunch({ accountsRoot: resolveAccountsRoot(cfg), provider, seatId: seat.seatId,
    requireClaudeBrokerSafety: provider === 'claude' });
  if (!result.ok) return new Set();
  const { nativeStatePath, executable } = result.launch;
  if (provider === 'claude') {
    const version = cliVersionFromExecutable(executable);
    return version !== null && claudeModelOptions(version).some(model => model.id === DEFAULT_CLAUDE_MODEL_ID && !model.unavailableReason)
      ? null : new Set();
  }
  try { lstatSync(join(nativeStatePath, 'models_cache.json')); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : new Set(); }
  return new Set(provider === 'codex'
    ? (readCodexCatalog(nativeStatePath) ?? []).filter(model => model.visibility !== 'hide').map(model => model.slug)
    : (readGrokCatalog(nativeStatePath) ?? []).filter(model => !model.hidden).map(model => model.id));
}

export async function loadLaneAutoEvidence(runsDir: string, cfg: AshlrConfig): Promise<LaneAutoEvidence | null> {
  const models = await readLaneModelConfig(runsDir);
  if (![...models.values()].includes('auto')) return null;
  const workClasses = new Map<string, string>();
  const [registry, docs, outcomes] = await Promise.all([
    loadVerifiedRegistry().catch(() => []), readDocsRecords().catch(() => null),
    readRouterOutcomes({ runsDir, onRecordedWorkClasses: classes => {
      for (const [id, workClass] of classes) workClasses.set(id, workClass);
    } }).catch(() => null),
  ]);
  const catalogs = new Map<string, ReadonlySet<string> | null>();
  for (const row of outcomes?.outcomes ?? []) if (row.work_class) workClasses.set(row.job_id, row.work_class);
  return { models, registry, docs: docs ?? [], score: indexLaneAutoScores(outcomes?.outcomes ?? []),
    workClassFor: jobId => workClasses.get(jobId) ?? null,
    nativeModels(seat) {
      const key = JSON.stringify([seat.engine, seat.seatId, seat.accountHint]);
      if (!catalogs.has(key)) catalogs.set(key, readLaneAutoNativeModels(cfg, seat));
      return catalogs.get(key) ?? null;
    } };
}
