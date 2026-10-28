/**
 * flag.ts — the bandit's feature flag and file configuration.
 *
 * The flag is deliberately a tiny self-contained file, not a new key in
 * ~/.ashlr/config.json: this module is a bridge seam — the host queue calls
 * it at admission, and growing the shared config surface for it is not part
 * of this change. Resolution order, highest first:
 *
 *   1. `PHM_ROUTER_BANDIT_MODE` environment override (off|shadow|enforce)
 *   2. `mode` in <root>/router-bandit.json
 *   3. DEFAULT: 'shadow' — the spec's default. Shadow logs the bandit's pick
 *      on every decision while the static route is applied; nothing the
 *      bandit says takes effect until an operator promotes the flag.
 *
 * The same file carries the bandit's tunables (creditFloor, reward weights,
 * size edges, minCellSamples, seed, lanes). A malformed file fails CLOSED:
 * the mode resolves to 'off', not to a guessed configuration — a router that
 * cannot read its own flag is not consulted at all.
 *
 * Reads happen here only; every caller passes an explicit root directory so
 * tests never touch a real home.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  BANDIT_MODES,
  DEFAULT_BANDIT_CONFIG,
  type BanditConfig,
  type BanditLane,
  type BanditMode,
} from './types.js';

export const BANDIT_FLAG_ENV = 'PHM_ROUTER_BANDIT_MODE';
export const BANDIT_FLAG_FILE = 'router-bandit.json';

export interface BanditFileConfig {
  readonly mode?: BanditMode;
  readonly creditFloor?: number;
  readonly minCellSamples?: number;
  readonly priorAlpha?: number;
  readonly priorBeta?: number;
  readonly sizeEdges?: readonly number[];
  readonly reward?: Partial<BanditConfig['reward']>;
  readonly lanes?: readonly BanditLane[];
  readonly seed?: number;
}

export interface ResolvedBanditFlag {
  readonly mode: BanditMode;
  /** Where the mode came from, for honest logging. */
  readonly source: 'env' | 'file' | 'default' | 'invalid';
  /** The parsed file config; absent when the file was missing or malformed. */
  readonly file: BanditFileConfig | null;
  /** Non-null when a file existed but could not be used. */
  readonly error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;

/**
 * Parse the flag file. Any malformed field fails the whole file (returns
 * null + error) rather than silently mixing valid fields with defaults.
 */
export function parseBanditFileConfig(text: string): { config: BanditFileConfig | null; error: string | null } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { config: null, error: 'router-bandit.json is not valid JSON' };
  }
  if (!isRecord(value)) return { config: null, error: 'router-bandit.json must be a JSON object' };
  const error = (field: string) => ({ config: null, error: `router-bandit.json: invalid ${field}` });
  if (value['mode'] !== undefined && !BANDIT_MODES.includes(value['mode'] as BanditMode)) return error('mode');
  if (value['creditFloor'] !== undefined && (!finiteNumber(value['creditFloor']) || value['creditFloor'] < 0)) return error('creditFloor');
  if (value['minCellSamples'] !== undefined && (!Number.isSafeInteger(value['minCellSamples']) || (value['minCellSamples'] as number) < 0)) return error('minCellSamples');
  for (const field of ['priorAlpha', 'priorBeta'] as const) {
    if (value[field] !== undefined && (!finiteNumber(value[field]) || (value[field] as number) <= 0)) return error(field);
  }
  if (value['sizeEdges'] !== undefined && (!Array.isArray(value['sizeEdges']) || value['sizeEdges'].length !== 4 ||
    !value['sizeEdges'].every((e, i, a) => finiteNumber(e) && e > 0 && (i === 0 || e > (a[i - 1] as number))))) return error('sizeEdges');
  if (value['seed'] !== undefined && !finiteNumber(value['seed'])) return error('seed');
  if (value['reward'] !== undefined) {
    const reward = value['reward'];
    if (!isRecord(reward)) return error('reward');
    for (const [field, fieldValue] of Object.entries(reward)) {
      if (!['success', 'cost', 'wall', 'costNormUsd', 'wallNormMs'].includes(field)) return error(`reward.${field}`);
      if (!finiteNumber(fieldValue) || (field === 'costNormUsd' || field === 'wallNormMs' ? fieldValue <= 0 : fieldValue < 0)) return error(`reward.${field}`);
    }
  }
  let lanes: BanditLane[] | undefined;
  if (value['lanes'] !== undefined) {
    if (!Array.isArray(value['lanes'])) return error('lanes');
    lanes = [];
    const seen = new Set<string>();
    for (const entry of value['lanes']) {
      if (!isRecord(entry) || typeof entry['id'] !== 'string' || !ID_TOKEN.test(entry['id']) ||
          typeof entry['pool'] !== 'string' || !ID_TOKEN.test(entry['pool']) || seen.has(entry['id'])) return error('lanes');
      seen.add(entry['id']);
      lanes.push({ id: entry['id'], pool: entry['pool'] });
    }
  }
  return {
    config: {
      ...(value['mode'] !== undefined ? { mode: value['mode'] as BanditMode } : {}),
      ...(value['creditFloor'] !== undefined ? { creditFloor: value['creditFloor'] as number } : {}),
      ...(value['minCellSamples'] !== undefined ? { minCellSamples: value['minCellSamples'] as number } : {}),
      ...(value['priorAlpha'] !== undefined ? { priorAlpha: value['priorAlpha'] as number } : {}),
      ...(value['priorBeta'] !== undefined ? { priorBeta: value['priorBeta'] as number } : {}),
      ...(value['sizeEdges'] !== undefined ? { sizeEdges: value['sizeEdges'] as number[] } : {}),
      ...(value['reward'] !== undefined ? { reward: value['reward'] as Partial<BanditConfig['reward']> } : {}),
      ...(lanes !== undefined ? { lanes } : {}),
      ...(value['seed'] !== undefined ? { seed: value['seed'] as number } : {}),
    },
    error: null,
  };
}

export function banditFlagRoot(home: string | undefined = undefined): string {
  const base = process.env['ASHLR_HOME'] ?? join(home ?? homedir(), '.ashlr');
  return base;
}

/** Resolve the mode: env > file > default shadow. A malformed file ⇒ off. */
export function resolveBanditFlag(options: {
  root?: string;
  env?: Readonly<Record<string, string | undefined>>;
} = {}): ResolvedBanditFlag {
  const env = options.env ?? process.env;
  const root = options.root ?? banditFlagRoot();
  const path = join(root, BANDIT_FLAG_FILE);
  let file: BanditFileConfig | null = null;
  let error: string | null = null;
  if (existsSync(path)) {
    const parsed = parseBanditFileConfig(readFileSync(path, 'utf8'));
    file = parsed.config;
    error = parsed.error;
  }
  const envMode = env[BANDIT_FLAG_ENV];
  if (envMode !== undefined) {
    if (BANDIT_MODES.includes(envMode as BanditMode)) {
      return { mode: envMode as BanditMode, source: 'env', file, error };
    }
    return { mode: 'off', source: 'invalid', file, error: `invalid ${BANDIT_FLAG_ENV}=${envMode}` };
  }
  if (error !== null) return { mode: 'off', source: 'invalid', file, error };
  if (file?.mode !== undefined) return { mode: file.mode, source: 'file', file, error };
  return { mode: 'shadow', source: 'default', file, error };
}

/** Merge a file config over the defaults into a complete BanditConfig. */
export function banditConfigFrom(file: BanditFileConfig | null | undefined): BanditConfig {
  const reward = { ...DEFAULT_BANDIT_CONFIG.reward, ...(file?.reward ?? {}) };
  return {
    minCellSamples: file?.minCellSamples ?? DEFAULT_BANDIT_CONFIG.minCellSamples,
    priorAlpha: file?.priorAlpha ?? DEFAULT_BANDIT_CONFIG.priorAlpha,
    priorBeta: file?.priorBeta ?? DEFAULT_BANDIT_CONFIG.priorBeta,
    creditFloor: file?.creditFloor ?? DEFAULT_BANDIT_CONFIG.creditFloor,
    sizeEdges: file?.sizeEdges ?? DEFAULT_BANDIT_CONFIG.sizeEdges,
    reward,
  };
}
