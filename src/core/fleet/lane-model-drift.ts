/**
 * lane-model-drift.ts — RQ-PHX-LANEMODELDRIFT18: read-only
 * `fleet.lane-model-drift.v1` projection backing `phm fleet lane-model-drift`.
 * Classifies every model a lane resolves to (via getLaneModelSnapshot on
 * <runsDir>/models.json) against the model catalog, so a typo, a retired id,
 * or a model the catalog has not caught up with is visible in one command.
 * Pure apart from reading the snapshot; never writes.
 */
import type { LaneModelSnapshot } from './lane-models.js';

/** The catalog fields classification needs — KNOWN_MODELS satisfies it. */
export interface DriftCatalogEntry { id: string; apiModelId?: string; historical?: boolean }
export type LaneModelStatus = 'known' | 'historical' | 'unknown';
export interface LaneModelDriftRow {
  lane: string; tier: string; model: string; via: string; status: LaneModelStatus;
}
export interface LaneModelDriftReport {
  schema: 'fleet.lane-model-drift.v1'; generatedAt: string;
  rows: LaneModelDriftRow[];
  counts: Record<LaneModelStatus, number>;
  /** Passed through from the lane-models snapshot unchanged. */
  sources: LaneModelSnapshot['sources'];
}

/** `claude-opus-5-5[1m]` → `claude-opus-5-5`: a context-window tag, not another model. */
const CONTEXT_TAG_RE = /\[[^\]]*\]\s*$/;
/** `gpt-6.1-terra-xhigh` → `gpt-6.1-terra`: Codex-style effort suffix. */
const EFFORT_SUFFIX_RE = /-(?:low|medium|high|xhigh|max)$/;

/** Every spelling the configured string may stand for, itself first. */
function modelSpellings(model: string): string[] {
  const spellings = new Set<string>();
  let s = model.trim().toLowerCase();
  while (s && !spellings.has(s)) {
    spellings.add(s);
    s = s.replace(CONTEXT_TAG_RE, '').replace(EFFORT_SUFFIX_RE, '').trim();
  }
  return [...spellings];
}

/**
 * Classify a configured lane model against the catalog. A match is the model
 * (or a stripped spelling of it) equalling an entry's `id`, its `apiModelId`,
 * or the tag after the engine prefix of its `id` — case-insensitive. `known`
 * beats `historical` when a spelling hits both.
 */
export function classifyLaneModel(
  model: string,
  catalog: readonly DriftCatalogEntry[],
): LaneModelStatus {
  const spellings = new Set(modelSpellings(model));
  let historical = false;
  for (const entry of catalog) {
    const names = [entry.id, entry.apiModelId, entry.id.slice(entry.id.indexOf(':') + 1)];
    if (!names.some(name => typeof name === 'string' && spellings.has(name.toLowerCase()))) continue;
    if (entry.historical === true) historical = true;
    else return 'known';
  }
  return historical ? 'historical' : 'unknown';
}

/**
 * Fold a lane-models snapshot into the drift report: one row per distinct
 * model each lane resolves to (first resolving tier wins), with per-status
 * counts. Source states pass through so a missing or degraded models.json is
 * visible next to an empty or partial row set.
 */
export function laneModelDrift(
  snapshot: LaneModelSnapshot,
  catalog: readonly DriftCatalogEntry[],
): LaneModelDriftReport {
  const rows: LaneModelDriftRow[] = [];
  const counts: Record<LaneModelStatus, number> = { known: 0, historical: 0, unknown: 0 };
  for (const lane of snapshot.lanes) {
    const seen = new Set<string>();
    for (const cell of lane.tiers) {
      if (cell.model === null || cell.via === null || seen.has(cell.model)) continue;
      seen.add(cell.model);
      const status = classifyLaneModel(cell.model, catalog);
      rows.push({ lane: lane.lane, tier: cell.tier, model: cell.model, via: cell.via, status });
      counts[status]++;
    }
  }
  return {
    schema: 'fleet.lane-model-drift.v1', generatedAt: snapshot.generatedAt,
    rows, counts, sources: snapshot.sources,
  };
}
