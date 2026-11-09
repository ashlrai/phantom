const SEEDS = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-plugin', 'ashlr-stack', 'ashlr-md'];

export interface RepoRankRow { repo: string; score: number; weight: number; recency: number; leverage: number }
export interface RepoRankState {
  generatedAt: string;
  weights: { prior: number; recency: number; leverage: number };
  rankings: RepoRankRow[];
  proposals: RepoRankRow[];
}

export function scoreParts(state: RepoRankState, row: RepoRankRow) {
  const seed = SEEDS.indexOf(row.repo);
  const maxRecency = Math.max(1, ...state.rankings.map(item => item.recency));
  const maxLeverage = Math.max(1, ...state.rankings.map(item => item.leverage));
  return {
    prior: state.weights.prior * (seed < 0 ? 0 : (SEEDS.length - seed) / SEEDS.length),
    recency: state.weights.recency * row.recency / maxRecency,
    leverage: state.weights.leverage * row.leverage / maxLeverage,
  };
}
