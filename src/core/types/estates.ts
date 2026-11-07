/**
 * Estate management types — per-repo health / SLI dashboard for the
 * AshlrAI fleet.  Every estate card is a lightweight "replica" of its
 * source repo's observable state (CI, releases, PRs, security).
 *
 * SAFETY: estate data is built from read-only sources only.  No tokens,
 * credentials, or private repository URLs are ever included.
 *
 * Commands:
 *   phm estates --json              List estate cards (one per ash lai repo).
 *   phm estates --repo <repo-id>    Show a single estate card.
 */

// ---------------------------------------------------------------------------
// Estate SLO types — measurable indicators per repo.
// ---------------------------------------------------------------------------

/** CI green-rate window: "7d", "30d", or "all". */
export type EstSloWindow = '7d' | '30d' | 'all';

/** Security finding severity levels (metadata only). */
export type EstSecuritySeverity = 'none' | 'low' | 'medium' | 'high' | 'critical';

/**
 * SLI — the five dimensions an estate card measures.
 * All numeric fields carry metadata only; zero/minus means
 * "insufficient data" or "no findings".
 */
export interface EstateSLO {
  /** CI green-rate over the window (0..1), or null when unknown. */
  ciGreenRate: number | null;
  /** CI green-rate window label. */
  ciGreenRateWindow: EstSloWindow;
  /** Days since last release (published tag), or null. */
  releaseAgeDays: number | null;
  /** Days since last commit (last activity), or null. */
  lastCommitDaysAgo: number | null;
  /** Number of open PRs (metadata-only, no URLs), or null. */
  openPrCount: number | null;
  /** Days since the oldest open PR (if any), or null. */
  oldestOpenPrDays: number | null;
  /** Highest security finding severity (metadata only). */
  securitySeverity: EstSecuritySeverity;
  /** Number of open security advisories, or null. */
  openSecurityAdvisories: number | null;
  /** Health grade (A..F) from the quality scanner, or null. */
  healthGrade: string | null;
  /** Health score 0..100, or null. */
  healthScore: number | null;
}

// ---------------------------------------------------------------------------
// Estate card — one per repo.
// ---------------------------------------------------------------------------

/**
 * Source role: who/what maintains this repo.  Values are descriptive
 * only and carry no executable authority.
 */
export type EstateAgentRole =
  | 'phantom'
  | 'hub'
  | 'secrets'
  | 'plugin'
  | 'stack'
  | 'lexicon'
  | 'locus'
  | 'pulse'
  | 'md'
  | 'binshield'
  | 'workbench'
  | 'code'
  | 'core-efficiency'
  | 'morphkit'
  | 'webfetch'
  | 'prompt-trackr'
  | 'auth'
  | 'personal'
  | 'other';

/**
 * Strategic tier (from ecosystem/focus.ts), included in every card. */
export type EstateStrategicTier =
  | 'core-fleet'
  | 'force-multiplier'
  | 'supporting'
  | 'inventory'
  | 'unknown';

/**
 * An estate card is a lightweight snapshot of a single repo's health
 * as viewed by the fleet.  The card carries METADATA ONLY — never
 * credentials, tokens, or private information.
 */
export interface EstateCard {
  /** Stable repo id (e.g. "phantom", "ashlr-hub"). */
  id: string;
  /** Human-readable repo name (e.g. "Phantom"). */
  name: string;
  /** Owner agent/role that maintains this repo. */
  agent: EstateAgentRole;
  /** Strategic tier from the ecosystem focus config. */
  tier: EstateStrategicTier;
  /** Runbook link (relative path to README or guide). */
  runbook: string;
  /** Current SLI measurements. */
  slo: EstateSLO;
  /** ISO timestamp this card was generated. */
  generatedAt: string;
  /** Present when the repo exists but no data is yet available. */
  noData?: boolean;
}

// ---------------------------------------------------------------------------
// Portfolio report — list of all estate cards.
// ---------------------------------------------------------------------------

/**
 * The portfolio-level estate report (one estate card per repo).
 * Used by `phm estates --json` and the desktop app.
 */
export interface EstateReport {
  /** ISO timestamp the report was generated. */
  generatedAt: string;
  /** Number of estate cards in the report. */
  cardCount: number;
  /** All estate cards, sorted by id (stable order). */
  cards: EstateCard[];
  /** Optional summary statistics (when computed). */
  summary?: {
    /** Mean CI green-rate across all cards (0..1), or null. */
    avgCiGreenRate: number | null;
    /** Number of cards with data (not just noData). */
    cardsWithData: number;
    /** Number of cards with security findings > "none". */
    cardsWithFindings: number;
    /** Number of cards marked "noData". */
    cardsWithoutData: number;
  };
}
