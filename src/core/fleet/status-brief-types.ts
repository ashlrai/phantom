export const FLEET_BRIEF_SCHEMA = 'fleet.brief.v1' as const;

export interface FleetBrief {
  whyIdle?: string[];
  schema: typeof FLEET_BRIEF_SCHEMA;
  v: 1;
  asOf: string;
  merged: { lastHour: number | null; last24h: number | null };
  /** Minutes from PR opened to merged, median over the last 24 hours. */
  medianMergeMinutes: number | null;
  /** Main branches that are green out of all repos the guardian watches. */
  main: { green: number | null; total: number | null; red: string[] };
  /**
   * The plan that runs out soonest. `known`: pool and hoursLeft are set. `steady`: plans are read
   * and none is running down. `unknown`: no plan could be read.
   */
  runway: { state: 'known' | 'steady' | 'unknown'; pool: string | null; hoursLeft: number | null; beforeReset: boolean | null };
}
