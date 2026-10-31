/** Solver contract for the pacing core. No solver ships here; callers inject one. */
export type SolverStatus = 'optimal' | 'infeasible' | 'failed' | 'timeout';

/** Extended solver result with objective value (used by MILP solvers). */
export interface SolverOutcome {
  status: SolverStatus;
  /** Variable name to primal value. Present for an optimal solve. */
  values: Readonly<Record<string, number>>;
  objective: number | null;
}

/** MILP solver contract — returns extended outcome with objective. */
export type MilpSolver = (lp: string, budgetMs: number) => Promise<SolverOutcome>;

/** Legacy pacing solver outcome (backward-compatible; subset of SolverOutcome). */
export interface PaceSolverOutcome {
  status: SolverStatus;
  values: Readonly<Record<string, number>>;
}

/** Legacy pacing solver contract — used by existing test suites. */
export type PaceSolver = (lp: string, budgetMs: number) => Promise<PaceSolverOutcome>;
