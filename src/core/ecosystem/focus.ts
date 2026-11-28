/**
 * Strategic ecosystem focus.
 *
 * Reads docs/ecosystem-index.json as a read-only product/strategy input so the
 * runtime can prioritize the few repos that compound the autonomous fleet.
 * Never throws; unknown repos fall back to neutral inventory treatment.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type StrategicTier = 'core-fleet' | 'force-multiplier' | 'supporting' | 'inventory';

export interface EcosystemFocus {
  coreFleetRepos: string[];
  forceMultiplierRepos: string[];
  supportingRepos: string[];
  externalCoreCandidates: Array<{ id: string; status: string; owner?: string }>;
}

interface EcosystemIndexRepo {
  id?: unknown;
  directory?: unknown;
  displayName?: unknown;
  strategicTier?: unknown;
}

interface EcosystemIndexShape {
  strategicFocus?: {
    coreFleetRepos?: unknown;
    forceMultiplierRepos?: unknown;
    supportingRepos?: unknown;
    externalCoreCandidates?: unknown;
  };
  repositories?: unknown;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

const UNICODE_DASH_RE = /[\u2010-\u2015]/g;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeUnicodeDashes(value: string, replacement = '-'): string {
  return value.replace(UNICODE_DASH_RE, replacement);
}

/**
 * Walk up from `startDir` looking for the nearest directory that contains
 * package.json. Returns that directory, or null if none is found.
 */
export function findPackageRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  const root = resolve('/');
  while (dir !== root) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return existsSync(join(root, 'package.json')) ? root : null;
}

export function resolveRepoDocPath(moduleUrl: string, ...segments: string[]): string | null {
  try {
    let baseDir: string;
    try {
      baseDir = dirname(fileURLToPath(moduleUrl));
    } catch {
      baseDir = process.cwd();
    }
    const repoRoot = findPackageRepoRoot(baseDir) ?? process.cwd();
    const candidate = join(repoRoot, ...segments);
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

const DEFAULT_ECOSYSTEM_FOCUS: EcosystemFocus = {
  coreFleetRepos: [
    'ashlr-hub',
    'phantom-secrets',
    'ashlr-plugin',
    'binshield',
    'ashlr-md',
    'stack',
    'ashlr-pulse',
    'ashlrcode',
    'ashlr-workbench',
    'lexicon',
    'locus',
  ],
  forceMultiplierRepos: [
    'ashlr-core-efficiency',
    'morphkit',
    'webfetch',
    'prompt-trackr',
  ],
  supportingRepos: [
    'ashlr-auth',
    'ashlr-cli-common',
    'ashlr-config',
    'ashlr-cost',
    'ashlr-mcp-kit',
    'homebrew-ashlr',
    'homebrew-phantom',
    'openclaw-setup',
  ],
  externalCoreCandidates: [{
    id: 'ashlr-mux',
    status: 'not-in-local-dev-tools-inventory',
    owner: 'cofounder',
  }],
};

export const STRATEGIC_TIER_RANK: Readonly<Record<StrategicTier, number>> = {
  'core-fleet': 0,
  'force-multiplier': 1,
  inventory: 2,
  supporting: 3,
};

const TIER_MULTIPLIER: Record<StrategicTier, number> = {
  'core-fleet': 1.35,
  'force-multiplier': 1.12,
  inventory: 1.0,
  supporting: 0.85,
};

let focusCache: {
  focus: EcosystemFocus;
  byName: Map<string, StrategicTier>;
} | null = null;

function ecosystemIndexPath(): string | null {
  return resolveRepoDocPath(import.meta.url, 'docs', 'ecosystem-index.json');
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function externalCandidates(value: unknown): EcosystemFocus['externalCoreCandidates'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isPlainRecord(entry)) return [];
    if (typeof entry['id'] !== 'string' || typeof entry['status'] !== 'string') return [];
    return [{
      id: entry['id'],
      status: entry['status'],
      ...(typeof entry['owner'] === 'string' ? { owner: entry['owner'] } : {}),
    }];
  });
}

function isStrategicTier(value: unknown): value is StrategicTier {
  return value === 'core-fleet' ||
    value === 'force-multiplier' ||
    value === 'supporting' ||
    value === 'inventory';
}

function addAliases(byName: Map<string, StrategicTier>, name: unknown, tier: StrategicTier): void {
  if (typeof name !== 'string' || name.length === 0) return;
  byName.set(name, tier);
  if (name.startsWith('ashlr-')) byName.set(name.slice('ashlr-'.length), tier);
  else byName.set(`ashlr-${name}`, tier);
  if (name.startsWith('@ashlr/')) byName.set(name.slice('@ashlr/'.length), tier);
}

function populateTierAliases(byName: Map<string, StrategicTier>, focus: EcosystemFocus): void {
  for (const id of focus.coreFleetRepos) addAliases(byName, id, 'core-fleet');
  for (const id of focus.forceMultiplierRepos) addAliases(byName, id, 'force-multiplier');
  for (const id of focus.supportingRepos) addAliases(byName, id, 'supporting');
}

function buildFromDefault(): { focus: EcosystemFocus; byName: Map<string, StrategicTier> } {
  const byName = new Map<string, StrategicTier>();
  populateTierAliases(byName, DEFAULT_ECOSYSTEM_FOCUS);
  return { focus: DEFAULT_ECOSYSTEM_FOCUS, byName };
}

function loadFocus(): { focus: EcosystemFocus; byName: Map<string, StrategicTier> } {
  if (focusCache) return focusCache;
  const fallback = buildFromDefault();
  try {
    const path = ecosystemIndexPath();
    if (!path) {
      focusCache = fallback;
      return focusCache;
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as EcosystemIndexShape;
    const rawFocus = parsed.strategicFocus ?? {};
    const focus: EcosystemFocus = {
      coreFleetRepos: stringArray(rawFocus.coreFleetRepos),
      forceMultiplierRepos: stringArray(rawFocus.forceMultiplierRepos),
      supportingRepos: stringArray(rawFocus.supportingRepos),
      externalCoreCandidates: externalCandidates(rawFocus.externalCoreCandidates),
    };
    if (focus.coreFleetRepos.length === 0) focus.coreFleetRepos = fallback.focus.coreFleetRepos;
    if (focus.forceMultiplierRepos.length === 0) focus.forceMultiplierRepos = fallback.focus.forceMultiplierRepos;
    if (focus.supportingRepos.length === 0) focus.supportingRepos = fallback.focus.supportingRepos;
    if (focus.externalCoreCandidates.length === 0) focus.externalCoreCandidates = fallback.focus.externalCoreCandidates;

    const byName = new Map<string, StrategicTier>();
    populateTierAliases(byName, focus);
    const repos = Array.isArray(parsed.repositories) ? parsed.repositories as EcosystemIndexRepo[] : [];
    for (const repo of repos) {
      const tier = isStrategicTier(repo.strategicTier) ? repo.strategicTier : 'inventory';
      addAliases(byName, repo.id, tier);
      addAliases(byName, repo.directory, tier);
      addAliases(byName, repo.displayName, tier);
    }

    focusCache = { focus, byName };
    return focusCache;
  } catch {
    focusCache = fallback;
    return focusCache;
  }
}

export function loadEcosystemFocus(): EcosystemFocus {
  return loadFocus().focus;
}

export function strategicTierOfRepo(repo: string): StrategicTier {
  try {
    const base = basename(resolve(repo));
    return loadFocus().byName.get(base) ?? 'inventory';
  } catch {
    return 'inventory';
  }
}

function strategicTierMultiplier(tier: StrategicTier): number {
  return TIER_MULTIPLIER[tier] ?? 1.0;
}

export function strategicRepoMultiplier(repo: string): number {
  return strategicTierMultiplier(strategicTierOfRepo(repo));
}

export function compareReposByStrategicFocus(a: string, b: string): number {
  return STRATEGIC_TIER_RANK[strategicTierOfRepo(a)] - STRATEGIC_TIER_RANK[strategicTierOfRepo(b)];
}
