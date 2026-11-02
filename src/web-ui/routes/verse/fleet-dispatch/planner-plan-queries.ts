import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export interface PlannerHealthRow {
  provider: string | null;
  status: string;
  failingSince: string | null;
  lastGoodPassAt: string | null;
  resetAt: string | null;
  reason: string | null;
}
export interface PlannerLimitedRow { provider: string; status: string; until: string | null }
export interface PlannerPlanView {
  v: 1;
  generatedAt: string;
  path: string;
  source: 'ok' | 'missing' | 'invalid' | 'unavailable';
  choice: { provider: string; reason: string } | null;
  nextResetAt: string | null;
  limited: PlannerLimitedRow[];
  health: PlannerHealthRow[];
}

const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const nullableString = (x: unknown): x is string | null => x === null || typeof x === 'string';
const sources: readonly string[] = ['ok', 'missing', 'invalid', 'unavailable'];

export function narrowPlannerPlan(x: unknown): PlannerPlanView | null {
  if (!record(x) || x.v !== 1 || typeof x.generatedAt !== 'string' || typeof x.path !== 'string'
    || !sources.includes(String(x.source)) || !nullableString(x.nextResetAt)
    || !(x.choice === null || (record(x.choice) && typeof x.choice.provider === 'string' && typeof x.choice.reason === 'string'))
    || !Array.isArray(x.limited)
    || !x.limited.every(row => record(row) && typeof row.provider === 'string' && typeof row.status === 'string' && nullableString(row.until))
    || !Array.isArray(x.health)
    || !x.health.every(row => record(row) && nullableString(row.provider) && typeof row.status === 'string'
      && nullableString(row.failingSince) && nullableString(row.lastGoodPassAt) && nullableString(row.resetAt) && nullableString(row.reason))) return null;
  return x as unknown as PlannerPlanView;
}

// A hub without the route answers 404 → null (the pane shows no planner line),
// not an error; every other failure still throws into the query entry.
export const plannerPlanQuery: QueryDef<PlannerPlanView | null> = {
  key: 'verse-leader-planner-plan',
  fetch: async signal => {
    try {
      return narrowPlannerPlan(await apiGet<unknown>('/api/verse/leader/planner/plan', signal));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
