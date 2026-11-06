/** Explicit operator preferences for the Leader. Model IDs are configuration,
 * never provider-family guesses; admission and funding remain the router's job. */
import type { AshlrConfig } from '../types.js';
import type { LeaderRunMode } from './leader-types.js';

export const LEADER_MODEL_TIERS = ['elite', 'workhorse', 'fast', 'local'] as const;
export type LeaderModelTier = typeof LEADER_MODEL_TIERS[number];
export type LeaderTaskKind = LeaderRunMode | 'reply';
export interface LeaderModelPreferences {
  modelTiers: Readonly<Record<LeaderModelTier, readonly string[]>>;
  taskTier: Readonly<Record<LeaderTaskKind, LeaderModelTier>>;
}
export type LeaderModelPreferencesResult =
  | { status: 'absent' }
  | { status: 'invalid'; reason: string }
  | { status: 'configured'; preferences: LeaderModelPreferences };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function tier(value: unknown): value is LeaderModelTier {
  return LEADER_MODEL_TIERS.some(candidate => candidate === value);
}

export function resolveLeaderModelPreferences(cfg: AshlrConfig): LeaderModelPreferencesResult {
  const foundry = cfg.foundry as Record<string, unknown> | undefined;
  const leader = foundry?.leader;
  if (!record(leader) || (!Object.hasOwn(leader, 'modelTiers') && !Object.hasOwn(leader, 'taskTier'))) return { status: 'absent' };
  const invalid = { status: 'invalid' as const, reason: 'Invalid foundry.leader modelTiers or taskTier configuration.' };
  if (!record(leader.modelTiers) || Object.keys(leader.modelTiers).some(key => !tier(key))) return invalid;
  const models = new Set<string>();
  const modelTiers: Record<LeaderModelTier, string[]> = { elite: [], workhorse: [], fast: [], local: [] };
  for (const name of LEADER_MODEL_TIERS) {
    const values = leader.modelTiers[name] ?? [];
    if (!Array.isArray(values) || values.length > 256) return invalid;
    for (const model of values) {
      if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model) || models.has(model)) return invalid;
      models.add(model);
      modelTiers[name].push(model);
    }
  }
  const taskTier: Record<LeaderTaskKind, LeaderModelTier> = { full: 'elite', checkin: 'workhorse', reply: 'workhorse' };
  if (leader.taskTier !== undefined) {
    if (!record(leader.taskTier) || Object.keys(leader.taskTier).some(key => !Object.hasOwn(taskTier, key))) return invalid;
    for (const key of ['full', 'checkin', 'reply'] as const) {
      const value = leader.taskTier[key];
      if (value === undefined) continue;
      if (!tier(value)) return invalid;
      taskTier[key] = value;
    }
  }
  return { status: 'configured', preferences: { modelTiers, taskTier } };
}

export function leaderModelTier(preferences: LeaderModelPreferences, engine: string, model: string): LeaderModelTier | null {
  // A remote model label cannot turn a host-local runtime into paid capacity,
  // or move the physical local backstop ahead of admitted subscription seats.
  if (engine === 'local') return 'local';
  return LEADER_MODEL_TIERS.find(name => preferences.modelTiers[name].includes(model)) ?? null;
}

/** Start at the task's requested rung, descend, then try stronger rungs.
 * Unclassified models precede the host-local backstop. Explicit local tasks
 * are local-only; the caller removes remote accounts before ranking. */
export function leaderTierRank(preferences: LeaderModelPreferences, task: LeaderTaskKind, engine: string, model: string): number {
  const wanted = preferences.taskTier[task];
  if (wanted === 'local') return engine === 'local' ? 0 : Number.MAX_SAFE_INTEGER;
  const remote = LEADER_MODEL_TIERS.filter(name => name !== 'local');
  const start = remote.indexOf(wanted as Exclude<LeaderModelTier, 'local'>);
  const order: LeaderModelTier[] = start < 0 ? [...remote, 'local'] : [...remote.slice(start), ...remote.slice(0, start), 'local'];
  const modelTier = leaderModelTier(preferences, engine, model);
  if (engine === 'local' || modelTier === 'local') return order.length;
  return modelTier === null ? order.length - 1 : order.indexOf(modelTier);
}
