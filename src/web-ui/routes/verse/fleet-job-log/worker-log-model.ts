import type { FleetRuns } from '../ops/ops-runs-model.js';
import { JOB_ID_RE } from './job-id.js';

export { JOB_ID_RE };
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

/** One labelled fact in the session header. A null value is a fact nobody recorded; `missing` is the word shown for it. */
export interface SessionFact { label: string; value: string | null; missing: string; href?: string; at?: string }
const known = (value: string | null | undefined): string | null => (typeof value === 'string' && value.trim() !== '' && value !== 'unknown' ? value : null);
/**
 * The session header's facts, in reading order: who is working (lane, tier, model), where (repo, branch), since when
 * and the pull request. Only what the job detail holds; `repo` comes from the running-worker list or the PR link,
 * because the detail does not carry it. Nothing is guessed: a fact that is not recorded stays null.
 */
export function sessionFacts(detail: FleetJobDetailV1, repo: string | null | undefined, nowMs: number): SessionFact[] {
  const launched = detail.launchedAt ? Date.parse(detail.launchedAt) : NaN;
  const url = safePrUrl(detail.publish?.prUrl);
  const fact = (label: string, value: string | null | undefined): SessionFact => ({ label, value: known(value), missing: 'unknown' });
  return [
    fact('Lane', detail.lane), fact('Tier', detail.tier), fact('Model', detail.model), fact('Repo', repo),
    { ...fact('Launched', Number.isFinite(launched) ? `${age((nowMs - launched) / 1000)} ago` : null), ...(Number.isFinite(launched) ? { at: new Date(launched).toISOString() } : {}) },
    fact('Branch', detail.branch),
    // No link is not an unknown: a job that has not published has none.
    { label: 'Pull request', value: url ? prLabel(url) : null, missing: 'none recorded', ...(url ? { href: url } : {}) },
  ];
}
/** The job one step before or after `job` in the worker list, wrapping at the ends. A job that is not listed steps onto the list's first or last. Null when there is nowhere else to go. */
export function stepJob(options: readonly { job: string }[], job: string, dir: 1 | -1): string | null {
  if (options.length === 0) return null;
  const at = options.findIndex(option => option.job === job);
  if (at === -1) return options[dir === 1 ? 0 : options.length - 1]!.job;
  return options.length === 1 ? null : options[(at + dir + options.length) % options.length]!.job;
}
/** Where `job` sits in the worker list, in words. A finished job is no longer in it, and says so instead of a number. */
export function stepLabel(options: readonly { job: string }[], job: string): string {
  const at = options.findIndex(option => option.job === job);
  return at === -1 ? `not listed · ${options.length} running` : `${at + 1} of ${options.length}`;
}
