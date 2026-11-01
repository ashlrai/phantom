import type { FleetRuns } from '../ops/ops-runs-model.js';

export const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;
type State = 'running' | 'published' | 'archived' | 'unknown';
type Source = 'healthy' | 'missing' | 'degraded';

/** Local wire contract: older producers may omit any field other than the schema. */
export interface FleetJobDetailV1 {
  schema: 'fleet.job.v1';
  generatedAt?: string | null; job?: string | null; state?: State | null;
  lane?: string | null; tier?: string | null; model?: string | null; pid?: number | null;
  launchedAt?: string | null; baseSha?: string | null; branch?: string | null; promptBytes?: number | null;
  publish?: { prUrl?: string | null; autoMerge?: boolean | null; testLine?: string | null; sensitive?: string[] | null } | null;
  notes?: { hasNotes?: boolean | null; hasBody?: boolean | null; notesBytes?: number | null } | null;
  log?: { source?: 'live' | 'archived' | 'missing' | null; bytes?: number | null; tail?: string[] | null; truncated?: boolean | null } | null;
  sources?: Partial<Record<'launch' | 'base' | 'meta' | 'publish' | 'log', Source | null>> | null;
}

type Check = (v: unknown) => boolean;
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const optional = (check: Check): Check => v => v == null || check(v);
const string: Check = v => typeof v === 'string';
const number: Check = v => typeof v === 'number' && Number.isFinite(v);
const boolean: Check = v => typeof v === 'boolean';
const strings: Check = v => Array.isArray(v) && v.every(string);
const oneOf = (...values: string[]): Check => v => typeof v === 'string' && values.includes(v);
const shape = (fields: Record<string, Check>): Check => v => obj(v) && Object.entries(fields).every(([key, check]) => optional(check)(v[key]));
const source = oneOf('healthy', 'missing', 'degraded');
const detailShape = shape({
  generatedAt: string, job: string, state: oneOf('running', 'published', 'archived', 'unknown'),
  lane: string, tier: string, model: string, pid: number, launchedAt: string, baseSha: string, branch: string, promptBytes: number,
  publish: shape({ prUrl: string, autoMerge: boolean, testLine: string, sensitive: strings }),
  notes: shape({ hasNotes: boolean, hasBody: boolean, notesBytes: number }),
  log: shape({ source: oneOf('live', 'archived', 'missing'), bytes: number, tail: strings, truncated: boolean }),
  sources: shape({ launch: source, base: source, meta: source, publish: source, log: source }),
});
export function isJobDetail(value: unknown): value is FleetJobDetailV1 {
  return obj(value) && value.schema === 'fleet.job.v1' && detailShape(value);
}

export function publishFacts(value: unknown): { testLine: string | null; sensitive: string[] | null } {
  const publish = obj(value) ? value : {};
  return {
    testLine: typeof publish.testLine === 'string' ? publish.testLine : null,
    sensitive: Array.isArray(publish.sensitive) && publish.sensitive.length > 0 && publish.sensitive.every(string)
      ? publish.sensitive as string[] : null,
  };
}

function age(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'age unknown';
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}

export function jobOptions(runs: FleetRuns | null | undefined): { job: string; label: string }[] {
  return [...(runs?.workers ?? [])].filter(w => JOB_ID_RE.test(w.job))
    .sort((a, b) => (b.ageSeconds ?? -1) - (a.ageSeconds ?? -1) || a.job.localeCompare(b.job))
    .map(w => ({ job: w.job, label: [w.job, w.lane, age(w.ageSeconds)].filter(Boolean).join(' · ') }));
}
export function stateTone(state: State | null | undefined): 'running' | 'success' | 'neutral' | 'unknown' {
  return state === 'running' ? 'running' : state === 'published' ? 'success' : state === 'archived' ? 'neutral' : 'unknown';
}
export function safePrUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null; } catch { return null; }
}
export function prLabel(url: string): string {
  const number = new URL(url).pathname.match(/\/pull\/(\d+)\/?$/)?.[1];
  return number ? `PR #${number}` : 'Pull request';
}
export function metaLine(detail: FleetJobDetailV1, nowMs: number): string {
  const launched = detail.launchedAt ? Date.parse(detail.launchedAt) : NaN;
  const url = safePrUrl(detail.publish?.prUrl);
  return [detail.state ?? 'unknown', [detail.lane, detail.tier].filter(Boolean).join(' ') || null,
    detail.model, Number.isFinite(launched) ? `launched ${age((nowMs - launched) / 1000)} ago` : null,
    url ? prLabel(url) : null].filter(Boolean).join(' · ');
}
export function pollMs(detail: FleetJobDetailV1 | null | undefined): number {
  return detail?.state === 'running' ? 4_000 : 15_000;
}
