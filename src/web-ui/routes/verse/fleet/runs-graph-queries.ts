import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { RunsData } from './runs-graph-model.js';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const objects = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(record) : [];
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function narrowRuns(data: unknown): RunsData | null {
  if (!record(data) || data.v !== 1 || !Array.isArray(data.workers) || !data.workers.every(w => record(w) && typeof w.job === 'string')
    || !Array.isArray(data.leaders) || !record(data.mergesLastHour) || !(data.mergesLastHour.count === null || natural(data.mergesLastHour.count))
    || !Array.isArray(data.switches) || !data.switches.every(s => typeof s === 'string')) return null;
  return { v: 1, workers: objects(data.workers).map(w => ({ job: w.job as string, lane: str(w.lane), model: str(w.model) ?? str(w.tier), startedAt: str(w.startedAt), repo: str(w.repo) })),
    leaders: data.leaders.map(value => { const l = record(value) ? value : {}; return { name: str(l.name) ?? str(l.label), lane: str(l.lane), model: str(l.model) }; }),
    lanes: objects(data.lanes).flatMap(l => { const id = str(l.lane) ?? str(l.id); return id !== undefined && natural(l.running) && natural(l.target) ? [{ id, running: l.running, target: l.target }] : []; }),
    mergesLastHour: { count: data.mergesLastHour.count as number | null, items: objects(data.mergesLastHour.items).map(i => ({ repo: str(i.repo), ...(natural(i.number) ? { number: i.number } : {}) })) }, switches: data.switches };
}
let missing = false;
export const runsGraphQuery: QueryDef<RunsData | null> = {
  key: 'verse-fleet-runs-graph',
  fetch: async signal => {
    if (missing) return null;
    try {
      const value = narrowRuns(await apiGet<unknown>('/api/verse/fleet/runs', signal));
      if (!value) throw new Error('Invalid fleet runs response');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) { missing = true; return null; }
      throw error;
    }
  },
};
