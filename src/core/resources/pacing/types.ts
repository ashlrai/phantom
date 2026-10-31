/** Solver contract for the pacing core. No solver ships here; callers inject one. */
export type SolverStatus = 'optimal' | 'infeasible' | 'failed' | 'timeout';

export interface SolverOutcome {
  status: SolverStatus;
  objective: number | null;
  /** Variable name to primal value. Present for an optimal solve. */
  values: Readonly<Record<string, number>>;
}

export type MilpSolver = (lp: string, budgetMs: number) => Promise<SolverOutcome>;
