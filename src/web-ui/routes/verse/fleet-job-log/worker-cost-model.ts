/** Local wire contract, independent of the server build. */
export interface FleetJobCostV1 {
  schema: 'fleet.job.cost.v1';
  generatedAt: string;
  job: string;
  calls: Array<{
    at: string | null;
    model: string | null;
    lane: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    estimated: boolean;
    error: boolean;
  }>;
  totals: {
    calls: number;
    errors: number;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    reported: { inputTokens: number; outputTokens: number; costUsd: number };
  };
  jobTotals: { finishes: number; tokensTotal: number | null };
  sources: { apiSpend: 'healthy' | 'missing' | 'degraded'; jobs: 'healthy' | 'missing' | 'degraded' };
  truncated: boolean;
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const nullableCount = (v: unknown) => v === null || count(v);
const nullableText = (v: unknown) => v === null || typeof v === 'string';

export function isJobCost(value: unknown): value is FleetJobCostV1 {
  if (!obj(value) || !obj(value.totals) || !obj(value.totals.reported) || !obj(value.jobTotals) || !obj(value.sources)) return false;
  const totals = value.totals;
  const reported = value.totals.reported;
  const jobTotals = value.jobTotals;
  const sources = value.sources;
  return value.schema === 'fleet.job.cost.v1' && typeof value.generatedAt === 'string' && typeof value.job === 'string'
    && Array.isArray(value.calls) && value.calls.every(call => obj(call)
      && nullableText(call.at) && nullableText(call.model) && nullableText(call.lane)
      && nullableCount(call.inputTokens) && nullableCount(call.outputTokens) && nullableCount(call.costUsd)
      && typeof call.estimated === 'boolean' && typeof call.error === 'boolean')
    && count(totals.calls) && count(totals.errors)
    && nullableCount(totals.inputTokens) && nullableCount(totals.outputTokens) && nullableCount(totals.costUsd)
    && ['inputTokens', 'outputTokens', 'costUsd'].every(key => count(reported[key]))
    && count(jobTotals.finishes) && nullableCount(jobTotals.tokensTotal)
    && ['apiSpend', 'jobs'].every(key => ['healthy', 'missing', 'degraded'].includes(String(sources[key])))
    && typeof value.truncated === 'boolean';
}

const text = (v: number | null): string => (v === null ? 'unknown' : v.toLocaleString('en-US'));
const money = (v: number | null): string => (v === null ? 'unknown' : `$${v.toFixed(4)}`);

export function costHeadline(cost: FleetJobCostV1): string {
  const { totals } = cost;
  const priced = totals.calls > 0 && totals.reported.costUsd < totals.calls
    ? ` across ${totals.reported.costUsd} of ${totals.calls} calls` : '';
  const errored = totals.errors > 0 ? ` · ${totals.errors} errored` : '';
  return `Cost · ${totals.calls} ${totals.calls === 1 ? 'call' : 'calls'} · ${text(totals.inputTokens)} in / ${text(totals.outputTokens)} out · ${money(totals.costUsd)}${priced}${errored}`;
}
