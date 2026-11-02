import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { routingDir } from './budget-store.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';
import { LEARNED_ROUTING_MIN_SAMPLES, type EngineScore } from '../run/learned-router.js';

/** A distinct execution choice. Model and effort are explicit, even for local models. */
export interface ArmKey { provider: string; model: string; effort: string }
export interface ArmPosterior {
  /** Beta distribution for the probability of a realized merge. */
  merge: { alpha: number; beta: number };
  /** Gamma distribution (shape, rate) for the inverse cost per allowance unit. */
  cost: { shape: number; rate: number };
}
export type ArmRegistry = Map<string, ArmPosterior>;

const PART = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_BYTES = 1024 * 1024;

export function armKey(arm: ArmKey): string {
  if (![arm.provider, arm.model, arm.effort].every((part) => typeof part === 'string' && PART.test(part))) {
    throw new Error('Invalid arm key');
  }
  return `${arm.provider}:${arm.model}:${arm.effort}`;
}

export function parseArmKey(key: string): ArmKey | null {
  if (typeof key !== 'string') return null;
  const parts = key.split(':');
  if (parts.length !== 3 || !parts.every((part) => PART.test(part))) return null;
  return { provider: parts[0]!, model: parts[1]!, effort: parts[2]! };
}

/** Seed once for a matching engine/model. Sub-threshold scores contain no observed rate. */
export function armPrior(score?: EngineScore): ArmPosterior {
  if (score && (!Number.isFinite(score.samples) || score.samples < 0 || !Number.isFinite(score.score) || score.score < 0 || score.score > 1)) {
    throw new Error('Invalid engine score');
  }
  const samples = score && score.samples >= LEARNED_ROUTING_MIN_SAMPLES ? score.samples : 0;
  const rate = score?.score ?? 0.5;
  const prior = { merge: { alpha: 1 + samples * rate, beta: 1 + samples * (1 - rate) }, cost: { shape: 1, rate: 1 } };
  if (!validPosterior(prior)) throw new Error('Arm prior overflow');
  return prior;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
function validPosterior(value: unknown): value is ArmPosterior {
  if (!value || typeof value !== 'object') return false;
  const p = value as ArmPosterior;
  return !!p.merge && !!p.cost && positive(p.merge.alpha) && positive(p.merge.beta) && positive(p.cost.shape) && positive(p.cost.rate);
}

/** One independent outcome and its cost per plan-allowance unit, modeled exponentially.
 * Gamma uses a rate parameter: observing cost x adds one to shape and x to rate.
 */
export function updateArm(posterior: ArmPosterior, merged: boolean, costPerUnit: number): ArmPosterior {
  if (!validPosterior(posterior) || typeof merged !== 'boolean' || !Number.isFinite(costPerUnit) || costPerUnit < 0) {
    throw new Error('Invalid arm observation');
  }
  const next = {
    merge: { alpha: posterior.merge.alpha + (merged ? 1 : 0), beta: posterior.merge.beta + (merged ? 0 : 1) },
    cost: { shape: posterior.cost.shape + 1, rate: posterior.cost.rate + costPerUnit },
  };
  if (!validPosterior(next)) throw new Error('Arm posterior overflow');
  return next;
}

export function armRegistryPath(): string { return join(routingDir(), 'arms.json'); }

/** Missing registry is empty. Invalid or unreadable data is rejected to prevent data loss. */
export function loadArmRegistry(file = armRegistryPath()): ArmRegistry {
  try { lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  const read = readPrivateFileCapped(file, MAX_BYTES);
  if (!read || read.truncated) throw new Error('Arm registry is unreadable');
  let raw: unknown;
  try { raw = JSON.parse(read.text) as unknown; } catch { throw new Error('Arm registry is unreadable'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid arm registry');
  const data = raw as Record<string, unknown>;
  if (data['v'] !== 1 || !Array.isArray(data['arms'])) throw new Error('Invalid arm registry');
  const registry: ArmRegistry = new Map();
  for (const row of data['arms'] as unknown[]) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !parseArmKey(row[0]) || !validPosterior(row[1]) || registry.has(row[0])) {
      throw new Error('Invalid arm registry entry');
    }
    registry.set(row[0], row[1]);
  }
  return registry;
}

/** Atomic private snapshot. Callers must serialize read-modify-write operations. */
export function saveArmRegistry(registry: ReadonlyMap<string, ArmPosterior>, file = armRegistryPath()): void {
  for (const [key, posterior] of registry) {
    if (!parseArmKey(key) || !validPosterior(posterior)) throw new Error('Invalid arm registry entry');
  }
  const content = `${JSON.stringify({ v: 1, arms: [...registry.entries()] }, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Arm registry exceeds its byte limit');
  // Refuse to replace an unreadable existing snapshot.
  loadArmRegistry(file);
  ensurePrivateDirectory(dirname(file));
  writePrivateFileAtomic(file, content);
}
