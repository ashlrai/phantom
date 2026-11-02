/** Usage-only wire contract. No account, device, path, or authentication data. */
export interface GrokUltraReading {
  source: 'manual' | 'app-local';
  timestamp: string;
  remainingPoints: number;
  totalPoints: number;
}

export interface GrokUltraRunway {
  v: 1;
  state: 'manual-required' | 'current' | 'stale' | 'unavailable';
  checkedAt: string;
  targetAt: string;
  collection: { mode: 'manual'; reason: 'safe-local-source-unavailable' };
  latest: GrokUltraReading | null;
  burnPointsPerHour: { h1: number | null; h6: number | null; h24: number | null };
  projectedRemainingPoints: { h1: number | null; h6: number | null; h24: number | null };
  idealPointsPerHour: number | null;
}
