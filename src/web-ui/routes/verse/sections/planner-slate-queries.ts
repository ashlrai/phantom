import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseControlLockedError } from '../autonomy/control-queries.js';

export interface PlannerSlateView {
  v: 1; generatedAt: string; source: 'ok' | 'missing' | 'invalid'; path: string;
  candidates: { provider: string; preset: string | null; argvLength: number }[];
  promptPath: string | null; promptExists: boolean; promptAgeSeconds: number | null;
  presets: { id: string; provider: string; available: boolean; binary: string | null; dropDir: string }[];
  briefCandidates: { path: string; exists: boolean; ageSeconds: number | null }[];
}
export interface PlannerSlateResult {
  v: 1; status: 'written' | 'unchanged' | 'refused'; candidateCount: number; promptPath: string;
}
const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const nullableString = (x: unknown): x is string | null => x === null || typeof x === 'string';
const nullableNumber = (x: unknown): x is number | null => x === null || (typeof x === 'number' && Number.isFinite(x) && x >= 0);

export function narrowPlannerSlate(x: unknown): PlannerSlateView | null {
  if (!record(x) || x.v !== 1 || typeof x.generatedAt !== 'string' || typeof x.path !== 'string'
    || !['ok', 'missing', 'invalid'].includes(String(x.source)) || !nullableString(x.promptPath)
    || typeof x.promptExists !== 'boolean' || !nullableNumber(x.promptAgeSeconds)
    || !Array.isArray(x.candidates) || !x.candidates.every(row => record(row) && typeof row.provider === 'string'
      && nullableString(row.preset) && Number.isInteger(row.argvLength) && (row.argvLength as number) >= 0)
    || !Array.isArray(x.presets) || !x.presets.every(row => record(row) && typeof row.id === 'string'
      && typeof row.provider === 'string' && typeof row.available === 'boolean' && nullableString(row.binary) && typeof row.dropDir === 'string')
    || !Array.isArray(x.briefCandidates) || !x.briefCandidates.every(row => record(row) && typeof row.path === 'string'
      && typeof row.exists === 'boolean' && nullableNumber(row.ageSeconds))) return null;
  return x as unknown as PlannerSlateView;
}

const path = '/api/verse/leader/planner/slate';
export const plannerSlateQuery: QueryDef<PlannerSlateView | null> = {
  key: 'verse-leader-planner-slate',
  fetch: async signal => {
    try { return narrowPlannerSlate(await apiGet<unknown>(path, signal)); }
    catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
  },
};

export async function postPlannerSlate(presets: string[], promptPath?: string): Promise<PlannerSlateResult> {
  const token = getMutationToken();
  if (!token) throw new VerseControlLockedError();
  const result = await apiPost<unknown>(path, { presets, ...(promptPath === undefined ? {} : { promptPath }) }, token);
  touchMutationHold();
  if (!record(result) || result.v !== 1 || !['written', 'unchanged', 'refused'].includes(String(result.status))
    || !Number.isInteger(result.candidateCount) || (result.candidateCount as number) < 0 || typeof result.promptPath !== 'string') {
    throw new Error('The server returned an invalid planner response.');
  }
  return result as unknown as PlannerSlateResult;
}
