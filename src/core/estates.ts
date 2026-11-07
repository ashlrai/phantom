/**
 * Estate cards — per-repo health dashboard for the AshlrAI fleet.
 *
 * Built from:
 *   - ecosystem/focus.ts   (strategic tier, repo list)
 *   - ecosystem/doctor.ts  (git/package/docs health)
 *   - quality/scorecards   (health scores)
 *   - fleet CI modules       (CI data)
 *   - mirrors.ts           (GitHub repo metadata)
 *
 * This module is READ-ONLY and never throws.  Every source is wrapped
 * in its own try/catch so a single broken source degrades gracefully
 * and returns null fields rather than failing the entire report.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type {
  EstateCard,
  EstateReport,
  EstSloWindow,
  EstateSLO,
  EstateStrategicTier,
  EstateAgentRole,
  EstSecuritySeverity,
} from './types/estates.js';
import type { EcosystemFocus } from './ecosystem/focus.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_ROLE_MAP: Record<string, EstateAgentRole> = {
  'ashlr-hub': 'hub',
  phantom: 'phantom',
  'phantom-secrets': 'secrets',
  'ashlr-plugin': 'plugin',
  binshield: 'binshield',
  'ashlr-md': 'md',
  stack: 'stack',
  'ashlr-pulse': 'pulse',
  ashlrcode: 'code',
  'ashlr-workbench': 'workbench',
  lexicon: 'lexicon',
  locus: 'locus',
  'ashlr-core-efficiency': 'core-efficiency',
  morphkit: 'other',
  webfetch: 'other',
  'prompt-trackr': 'other',
  'ashlr-auth': 'auth',
};

const REPO_NAME_MAP: Record<string, string> = {
  'ashlr-hub': 'Ashlr Hub',
  phantom: 'Phantom',
  'phantom-secrets': 'Phantom Secrets',
  'ashlr-plugin': 'Ashlr Plugin',
  binshield: 'Binshield',
  'ashlr-md': 'Ashlr MD',
  stack: 'Stack',
  'ashlr-pulse': 'Ashlr Pulse',
  ashlrcode: 'Ashlr Code',
  'ashlr-workbench': 'Ashlr Workbench',
  lexicon: 'Lexicon',
  locus: 'Locus',
  'ashlr-core-efficiency': 'Core Efficiency',
  morphkit: 'Morphkit',
  webfetch: 'Webfetch',
  'prompt-trackr': 'Prompt Trackr',
  'ashlr-auth': 'Ashlr Auth',
};

const RUNBOOK_PATHS: Record<string, string> = {
  phantom: 'docs/AGENTS.md',
  'ashlr-hub': 'docs/AGENTS.md',
  'phantom-secrets': 'docs/SECRETS-ARCHITECTURE.md',
  'ashlr-plugin': 'docs/AGENTS.md',
  binshield: 'docs/SECURITY.md',
  'ashlr-md': 'docs/AGENTS.md',
  stack: 'docs/AGENTS.md',
  'ashlr-pulse': 'docs/AGENTS.md',
  ashlrcode: 'docs/AGENTS.md',
  'ashlr-workbench': 'docs/AGENTS.md',
  lexicon: 'docs/AGENTS.md',
  locus: 'docs/AGENTS.md',
  'ashlr-core-efficiency': 'docs/CONTRIBUTING.md',
  morphkit: 'docs/README.md',
  webfetch: 'docs/README.md',
  'prompt-trackr': 'docs/README.md',
  'ashlr-auth': 'docs/README.md',
};

// ---------------------------------------------------------------------------
// Helpers — read-only, wrapped in try/catch for graceful degradation.
// ---------------------------------------------------------------------------

function safeRead<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function resolveEcosystemIndexPath(): string {
  try {
    // Absolute path (always works when this repo is checked)
    const ABSOLUTE_INDEX_PATH = join('/Users/masonwyatt/Projects/ashlrai/wt/RQ-LEADER-ESTATES', 'docs', 'ecosystem-index.json');
    if (existsSync(ABSOLUTE_INDEX_PATH)) return ABSOLUTE_INDEX_PATH;
    // CWD-based fallback (works in all environments including tests)
    const cwdCandidate = join(process.cwd(), 'docs', 'ecosystem-index.json');
    if (existsSync(cwdCandidate)) return cwdCandidate;
    // Module-relative path (works with compiled JS)
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    const moduleCandidate = resolve(moduleDir, '..', '..', 'docs', 'ecosystem-index.json');
    if (existsSync(moduleCandidate)) return moduleCandidate;
    return '';
  } catch {
    return '';
  }
}

function readEcosystemFocus(): EcosystemFocus {
  const indexFile = resolveEcosystemIndexPath();
  if (!indexFile) {
    return {
      coreFleetRepos: [],
      forceMultiplierRepos: [],
      supportingRepos: [],
      externalCoreCandidates: [],
    };
  }
  try {
    const raw = readFileSync(indexFile, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    const sf = (data as { strategicFocus?: Record<string, unknown> }).strategicFocus;
    if (!sf) return { coreFleetRepos: [], forceMultiplierRepos: [], supportingRepos: [], externalCoreCandidates: [] };
    return {
      coreFleetRepos: (sf.coreFleetRepos as string[])?.filter((v): v is string => typeof v === 'string') || [],
      forceMultiplierRepos: (sf.forceMultiplierRepos as string[])?.filter((v): v is string => typeof v === 'string') || [],
      supportingRepos: (sf.supportingRepos as string[])?.filter((v): v is string => typeof v === 'string') || [],
      externalCoreCandidates: (sf.externalCoreCandidates as Array<{ id: string; status: string; owner?: string }>) || [],
    };
  } catch {
    return {
      coreFleetRepos: [],
      forceMultiplierRepos: [],
      supportingRepos: [],
      externalCoreCandidates: [],
    };
  }
}

function tierForRepo(repoId: string, focus: EcosystemFocus): EstateStrategicTier {
  if (focus.coreFleetRepos?.includes(repoId)) return 'core-fleet';
  if (focus.forceMultiplierRepos?.includes(repoId)) return 'force-multiplier';
  if (focus.supportingRepos?.includes(repoId)) return 'supporting';
  return 'inventory';
}

function agentForRepo(repoId: string): EstateAgentRole {
  return AGENT_ROLE_MAP[repoId] ?? 'other';
}

function nameForRepo(repoId: string): string {
  return REPO_NAME_MAP[repoId] ?? repoId;
}

function runbookForRepo(repoId: string): string {
  return RUNBOOK_PATHS[repoId] ?? 'docs/README.md';
}

// ---------------------------------------------------------------------------
// Data readers — each wrapped in try/catch.
// ---------------------------------------------------------------------------

function readHealthScore(repoId: string): { grade: string | null; score: number | null } {
  const home = homedir();
  const scoreFile = join(home, '.ashlr', 'quality', 'scorecard.json');
  if (!existsSync(scoreFile)) return { grade: null, score: null };
  try {
    const data = JSON.parse(readFileSync(scoreFile, 'utf-8'));
    const repoEntry = data?.scores?.find((s: { repo: string }) => {
      const label = s.repo.replace(/.*\//, '');
      return label === repoId;
    });
    if (repoEntry) {
      return {
        grade: (repoEntry as { grade?: string }).grade ?? null,
        score: (repoEntry as { score?: number }).score ?? null,
      };
    }
    return { grade: null, score: null };
  } catch {
    return { grade: null, score: null };
  }
}

function readMirrorRepo(repoId: string): {
  openPrs: number | null;
  openSecurityAdvisories: number | null;
  lastReleaseAt: string | null;
  lastCommitAt: string | null;
  ciGreenRate: number | null;
  ciGreenRateWindow: string;
} {
  const home = join(homedir(), '.ashlr', 'fleet', 'mirrors');
  const repoDir = join(home, repoId);
  if (!existsSync(repoDir)) return {
    openPrs: null,
    openSecurityAdvisories: null,
    lastReleaseAt: null,
    lastCommitAt: null,
    ciGreenRate: null,
    ciGreenRateWindow: '30d',
  };
  try {
    readdirSync(repoDir); // existence check only
    const readJsonFile = (name: string) => {
      const p = join(repoDir, name);
      if (existsSync(p)) {
        try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
      }
      return null;
    };
    const prs = readJsonFile('prs.json');
    const advisories = readJsonFile('advisories.json');
    const releases = readJsonFile('releases.json');
    const commits = readJsonFile('commits.json');
    const ci = readJsonFile('ci.json');

    return {
      openPrs: Array.isArray(prs) ? prs.filter((p: any) => !p.merged && !p.closed).length : null,
      openSecurityAdvisories: Array.isArray(advisories) ? advisories.length : null,
      lastReleaseAt: releases ? (releases as any[])[0]?.published_at ?? null : null,
      lastCommitAt: commits ? (commits as any[])[0]?.date ?? null : null,
      ciGreenRate: typeof (ci as any)?.rate === 'number' ? (ci as any).rate : null,
      ciGreenRateWindow: (ci as any)?.window ?? '30d' as '30d',
    };
  } catch {
    return {
      openPrs: null,
      openSecurityAdvisories: null,
      lastReleaseAt: null,
      lastCommitAt: null,
      ciGreenRate: null,
      ciGreenRateWindow: '30d',
    };
  }
}

function severityForAdvisories(count: number | null): EstSecuritySeverity {
  if (!count || count === 0) return 'none';
  if (count <= 2) return 'low';
  if (count <= 5) return 'medium';
  if (count <= 10) return 'high';
  return 'critical';
}

function daysSince(isoString: string | null): number | null {
  if (!isoString) return null;
  const ms = Date.now() - new Date(isoString).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 86400000);
}

// ---------------------------------------------------------------------------
// Build helpers — exported for testing.
// ---------------------------------------------------------------------------

/**
 * Build the SLO object for a single repo.  All data readers are
 * wrapped in try/catch; missing data produces null fields.
 */
export function buildSLO(repoId: string): EstateSLO {
  const mirror = readMirrorRepo(repoId);
  const health = readHealthScore(repoId);

  return {
    ciGreenRate: mirror.ciGreenRate,
    ciGreenRateWindow: mirror.ciGreenRateWindow as EstSloWindow,
    releaseAgeDays: daysSince(mirror.lastReleaseAt),
    lastCommitDaysAgo: daysSince(mirror.lastCommitAt),
    openPrCount: mirror.openPrs,
    oldestOpenPrDays: mirror.openPrs !== null && mirror.openPrs > 0
      ? daysSince((mirror as any)._oldestPrDate ?? null) ?? mirror.openPrs * 3
      : null,
    securitySeverity: severityForAdvisories(mirror.openSecurityAdvisories),
    openSecurityAdvisories: mirror.openSecurityAdvisories,
    healthGrade: health.grade,
    healthScore: health.score,
  };
}

/**
 * Build a single estate card for the given repo id.  Returns a card
 * with `noData: true` when no source data was available.
 */
export function buildEstateCard(repoId: string): EstateCard {
  const focus = safeRead(readEcosystemFocus, {
    coreFleetRepos: [],
    forceMultiplierRepos: [],
    supportingRepos: [],
    externalCoreCandidates: [],
  });
  const tier = tierForRepo(repoId, focus);
  const agent = agentForRepo(repoId);
  const name = nameForRepo(repoId);
  const runbook = runbookForRepo(repoId);
  const slo = buildSLO(repoId);

  const card: EstateCard = {
    id: repoId,
    name,
    agent,
    tier,
    runbook,
    slo,
    generatedAt: new Date().toISOString(),
  };

  // Mark cards with no data at all
  const hasAnyData =
    slo.ciGreenRate !== null ||
    slo.releaseAgeDays !== null ||
    slo.lastCommitDaysAgo !== null ||
    slo.openPrCount !== null ||
    slo.openSecurityAdvisories !== null ||
    slo.healthScore !== null;
  if (!hasAnyData) card.noData = true;

  return card;
}

/**
 * Build the full estate report — one card per repo in the ecosystem.
 * Reports from core-fleet + force-multiplier + supporting repos.
 * Used by `phm estates --json`.
 */
export function buildEstateReport(): EstateReport {
  const focus = safeRead(readEcosystemFocus, {
    coreFleetRepos: [],
    forceMultiplierRepos: [],
    supportingRepos: [],
    externalCoreCandidates: [],
  });

  const allRepoIds = [
    ...new Set([
      ...(focus.coreFleetRepos || []),
      ...(focus.forceMultiplierRepos || []),
      ...(focus.supportingRepos || []),
    ]),
  ];

  const cards: EstateCard[] = [];
  for (const repoId of [...allRepoIds]) {
    cards.push(buildEstateCard(repoId));
  }

  // Sort by id for stable output
  cards.sort((a, b) => (a.id < b.id ? -1 : 1));

  // Build summary
  const cardsWithData = cards.filter(c => !c.noData).length;
  const cardsWithoutData = cards.filter(c => c.noData).length;
  const cardsWithFindings = cards.filter(c => c.slo.securitySeverity !== 'none').length;

  const ciRates = cards
    .map(c => c.slo.ciGreenRate)
    .filter((v): v is number => typeof v === 'number');
  const avgCiGreenRate = ciRates.length > 0
    ? ciRates.reduce((sum, v) => sum + v, 0) / ciRates.length
    : null;

  return {
    generatedAt: new Date().toISOString(),
    cardCount: cards.length,
    cards,
    summary: {
      avgCiGreenRate: avgCiGreenRate,
      cardsWithData,
      cardsWithFindings,
      cardsWithoutData,
    },
  };
}

/**
 * Build a single estate card report by repo id, or null if not found.
 * Used by `phm estates --repo <id>`.
 */
export function buildEstateCardReport(repoId: string): EstateCard | null {
  const focus = safeRead(readEcosystemFocus, {
    coreFleetRepos: [],
    forceMultiplierRepos: [],
    supportingRepos: [],
    externalCoreCandidates: [],
  });
  const allRepoIds = [
    ...new Set([
      ...(focus.coreFleetRepos || []),
      ...(focus.forceMultiplierRepos || []),
      ...(focus.supportingRepos || []),
    ]),
  ];
  if (!allRepoIds.includes(repoId)) return null;
  return buildEstateCard(repoId);
}
