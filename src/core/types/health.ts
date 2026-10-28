/** Shared health contracts. Public entry point: ../types.ts. */
import type { WorkItem } from './backlog.js';
import type { ProposalKind } from './proposals.js';

// ---------------------------------------------------------------------------
// M27: QUALITY & STANDARDS ENFORCEMENT - `ashlr health`.
//
// SAFE BY CONSTRUCTION. `ashlr health` is a READ-ONLY, continuous portfolio
// quality review. It READS enrolled repos (via the M22 read-only scanners +
// lightweight FS convention probes) and WRITES only under ~/.ashlr/quality/
// (score snapshots) and - only on an explicit `propose` action - PENDING M23
// Approval Inbox proposals. It NEVER mutates a user repo working tree, NEVER
// pushes/opens-PRs/deploys, operates ONLY over listEnrolled() repos (DEFAULT
// EMPTY => reports nothing, no disk scan), and uses NO LLM by default. These
// types carry METADATA ONLY - never secret values.
// ---------------------------------------------------------------------------

/**
 * M27: the quality dimensions a HealthScore is decomposed into. Each maps
 * naturally onto one M22 scanner (tests/docs/deps/security/code-debt/issues-CI)
 * plus a `conventions` dimension fed by the read-only convention probes.
 */
export type HealthDimension =
  | 'tests'        // scanTests: test-script presence + CI state
  | 'docs'         // scanDocs: README/LICENSE/CONTRIBUTING presence + thinness
  | 'deps'         // scanDeps: dependency freshness + npm-audit vulnerabilities
  | 'security'     // scanSecurity: security findings (binshield)
  | 'codeDebt'     // scanTodos: TODO/FIXME/HACK/XXX code-debt markers
  | 'issuesCi'     // scanIssues: open GitHub issues + CI signal
  | 'conventions'; // conventions.ts: project-standards probes (lockfile, .gitignore, CI config, …)

/** A letter grade derived deterministically from a 0..100 score. */
export type HealthGrade = 'A' | 'B' | 'C' | 'D' | 'F';

/** Typed scoring error emitted when health math produces a non-finite score. */
export interface HealthScoreError {
  code: 'invalid-health-score';
  context: string;
  raw: string;
  detail: string;
}

/** Result of normalizing an internal health score candidate to the public 0..100 range. */
export interface ClampedHealthScore {
  score: number;
  error?: HealthScoreError;
}

/**
 * M27: a single read-only project-standards probe result for one repo.
 * Produced by conventions.ts via pure FS reads (presence/size checks). Carries
 * NO secrets and NEVER implies a mutation was performed.
 */
export interface ConventionFinding {
  /** Stable probe key, e.g. 'license' | 'gitignore' | 'lockfile' | 'ci' | 'readme' | 'testdir'. */
  key: string;
  /** Short human-readable label for the probe (e.g. 'LICENSE file'). */
  label: string;
  /** True when the convention is satisfied (e.g. the file/dir/script exists). */
  ok: boolean;
  /** Severity weight of a MISS (1 low .. 5 high); ignored when ok=true. */
  weight: number;
  /** Longer detail / remediation hint (no secrets). */
  detail: string;
}

/**
 * M27: the per-dimension contribution to a repo's HealthScore. Deterministic.
 */
export interface HealthDimensionScore {
  /** Which dimension this entry scores. */
  dimension: HealthDimension;
  /** Normalized dimension score, 0 (worst) .. 100 (best). */
  score: number;
  /** Relative weight of this dimension in the overall 0..100 roll-up. */
  weight: number;
  /** Count of underlying findings (WorkItems / failed convention probes) feeding it. */
  findingCount: number;
  /** Short, deterministic human-readable summary line (no secrets). */
  summary: string;
  /** Present when invalid score math was coerced to a valid 0..100 score. */
  error?: HealthScoreError;
}

/**
 * M27: the per-repo HEALTH SCORE. Produced by computeHealth(repo) from the six
 * M22 scanners + conventions probes. Deterministic, READ-ONLY, NO LLM.
 * METADATA ONLY - never carries secret values.
 */
export interface HealthScore {
  /** Absolute path of the enrolled repo this score belongs to. */
  repo: string;
  /** Weighted overall score, 0 (worst) .. 100 (best). */
  score: number;
  /** Letter grade derived from `score` (A>=90, B>=80, C>=70, D>=60, else F). */
  grade: HealthGrade;
  /** Per-dimension breakdown (one entry per HealthDimension). */
  dimensions: HealthDimensionScore[];
  /** Convention probe results for this repo (read-only FS probes). */
  conventions: ConventionFinding[];
  /**
   * The worst offenders - the highest-priority WorkItems (by WorkItem.score)
   * dragging this repo's grade down, bounded to a small cap. METADATA ONLY.
   */
  worstOffenders: WorkItem[];
  /** ISO timestamp this score was computed. */
  ts: string;
  /** Present when any underlying health score path had to coerce invalid math. */
  errors?: HealthScoreError[];
}

/**
 * M27: the portfolio-wide HEALTH REPORT. Produced by computeReport({ repos? })
 * over enrolled repos (default listEnrolled(); explicit repos filtered through
 * isEnrolled()). Persisted under ~/.ashlr/quality/ for trend tracking.
 * METADATA ONLY - never carries secret values.
 */
export interface HealthReport {
  /** ISO timestamp the report was generated. */
  generatedAt: string;
  /** Absolute paths of the enrolled repos that were scored. */
  repos: string[];
  /** Per-repo scores, ranked worst-first (lowest score first) by default. */
  scores: HealthScore[];
  /** Mean overall score across all scored repos (0..100), or 0 when empty. */
  averageScore: number;
  /** Letter grade derived from `averageScore`. */
  averageGrade: HealthGrade;
  /**
   * Per-repo overall-score delta vs the previous persisted report
   * (loadPreviousReport), keyed by absolute repo path. Positive = improved.
   * Absent entries have no prior snapshot to compare against.
   */
  delta: Record<string, number>;
  /**
   * Optional LLM-assisted narrative summary. ABSENT on the default path
   * (deterministic-only). Populated ONLY when narrative generation is requested
   * and a provider is reachable (local unless --allow-cloud + key). When set,
   * `narrativeLocal` records whether it was produced by a local model.
   */
  narrative?: string;
  /** True when `narrative` was produced by a LOCAL model; absent when no narrative. */
  narrativeLocal?: boolean;
  /** Present when any underlying health score path had to coerce invalid math. */
  errors?: HealthScoreError[];
}

/**
 * M27: a single deterministic, advisory SAFE FIX derived from a HealthScore's
 * findings (e.g. "add a LICENSE", "add .gitignore", "pin/upgrade vulnerable dep
 * X", "add a test for Y"). emitFixProposals() routes each to the M23 Approval
 * Inbox as a PENDING proposal (kind 'note' by default - a no-op advisory record
 * that mutates nothing; origin 'manual'). M27 NEVER auto-applies a fix and NEVER
 * mutates a repo. METADATA ONLY.
 */
export interface SafeFix {
  /** Absolute path of the repo this fix targets. */
  repo: string;
  /** The dimension this fix improves. */
  dimension: HealthDimension;
  /** Stable fix key (e.g. 'docs.add-license', 'conventions.add-gitignore'). */
  key: string;
  /** Short human-readable title for the inbox / report. */
  title: string;
  /** Longer rationale grounded in the repo's deterministic findings (no secrets). */
  rationale: string;
  /**
   * Whether this fix is purely advisory ('note') or could carry a deterministic
   * sandbox-generated diff ('patch'). Default 'note'; 'patch' is a documented
   * STRETCH only - any diff MUST be produced in an M21 sandbox worktree and
   * attached as a PENDING proposal, NEVER written to the real tree.
   */
  proposalKind: Extract<ProposalKind, 'note' | 'patch'>;
}

/** Options accepted by `computeReport` (the deterministic health engine). */
export interface HealthOptions {
  /**
   * Explicit repo list. When provided, EACH entry MUST be filtered through
   * isEnrolled() (resolve() first) - non-enrolled paths HARD-ERROR. When
   * omitted, defaults to listEnrolled() (DEFAULT EMPTY => empty report).
   */
  repos?: string[];
  /** Hard cap on how many repos to score in one run (bounds work). */
  maxRepos?: number;
}
