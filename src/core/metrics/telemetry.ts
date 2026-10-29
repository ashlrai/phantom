/**
 * Phantom telemetry (docs/architecture/metrics.md). Local-first, append-only
 * JSONL at $ASHLR_HOME/metrics/events.jsonl; sharing is opt-in. Secret-shaped
 * values are refused, never recorded.
 */
import { appendFileSync, closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ashlrHome } from '../cloud/store.js';
import { assertNoSecrets } from '../teams/store.js';
import { ensurePrivateDirectory, readPrivateFileCapped } from '../verse/preferences.js';

export const TELEMETRY_SCHEMA_VERSION = 1 as const;

/** Dimensions every event is attributed to. */
export interface Attribution { sessionId: string; agent: string; model?: string; resource?: string; strategy?: string; process?: string; taskType?: string; repo?: string; owner?: 'personal' | 'company' | `client:${string}` }

export type TelemetryEvent =
  | ({ kind: 'session.started' } & Base)
  | ({ kind: 'session.ended'; outcome: 'success' | 'failure' | 'abandoned'; wallMs: number } & Base)
  | ({ kind: 'usage'; inputTokens: number; outputTokens: number; cachedTokens?: number; costUsd?: number; wallMs?: number } & Base)
  | ({ kind: 'tool.called'; tool: string; ok: boolean; ms?: number } & Base)
  | ({ kind: 'pr.opened' | 'pr.merged' | 'pr.reverted'; pr: PrRef } & Base)
  | ({ kind: 'pr.rated'; pr: PrRef; rater: 'human' | 'llm-judge'; rating: number /* 1..5 */; rubric?: string } & Base);

interface Base extends Attribution { v: typeof TELEMETRY_SCHEMA_VERSION; id: string; ts: string }
export interface PrRef { repo: string; number: number; additions?: number; deletions?: number; files?: number; areas?: string[]; userFacing?: boolean; risk?: 'low' | 'medium' | 'high'; ciPassedFirstTry?: boolean; reviewFindings?: number; followUpFixes?: number; coverageDelta?: number; deployedToProduction?: boolean }

export function metricsFile(): string { return join(ashlrHome(), 'metrics', 'events.jsonl'); }

// Distribute over event variants so callers retain each kind's required fields.
type InputOf<T> = T extends Base ? Omit<T, 'v' | 'id' | 'ts'> & { ts?: string } : never;
export type TelemetryInput = InputOf<TelemetryEvent>;

const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 500;
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const attribution = ['sessionId', 'agent', 'model', 'resource', 'strategy', 'process', 'taskType', 'repo', 'owner'];
const fields: Record<string, string[]> = {
  'session.started': [], 'session.ended': ['outcome', 'wallMs'],
  usage: ['inputTokens', 'outputTokens', 'cachedTokens', 'costUsd', 'wallMs'],
  'tool.called': ['tool', 'ok', 'ms'],
  'pr.opened': ['pr'], 'pr.merged': ['pr'], 'pr.reverted': ['pr'],
  'pr.rated': ['pr', 'rater', 'rating', 'rubric'],
};

/** Validate CLI JSON and saved records before they can affect storage or scores. */
function validInput(v: unknown): v is TelemetryInput {
  if (!object(v) || !text(v.kind) || !Object.hasOwn(fields, v.kind) || !text(v.sessionId) || !text(v.agent)) return false;
  const allowed = new Set([...attribution, 'kind', 'ts', ...fields[v.kind]!]);
  if (Object.keys(v).some((k) => !allowed.has(k))) return false;
  if (attribution.some((k) => v[k] !== undefined && !text(v[k]))) return false;
  if (v.owner !== undefined && v.owner !== 'personal' && v.owner !== 'company' && !/^client:[a-z0-9._-]+$/i.test(String(v.owner))) return false;
  if (v.ts !== undefined && (!text(v.ts) || !/^\d{4}-\d{2}-\d{2}T/.test(v.ts) || !Number.isFinite(Date.parse(v.ts)))) return false;
  for (const k of ['inputTokens', 'outputTokens', 'cachedTokens', 'costUsd', 'wallMs', 'ms']) {
    if (v[k] !== undefined && !nonnegative(v[k])) return false;
  }
  if (v.kind === 'usage' && (!nonnegative(v.inputTokens) || !nonnegative(v.outputTokens))) return false;
  if (v.kind === 'session.ended' && (!['success', 'failure', 'abandoned'].includes(String(v.outcome)) || !nonnegative(v.wallMs))) return false;
  if (v.kind === 'tool.called' && (!text(v.tool) || typeof v.ok !== 'boolean')) return false;
  if (v.kind.startsWith('pr.')) {
    const p = v.pr;
    if (!object(p) || !text(p.repo) || !/^[a-z0-9-]+\/[a-z0-9._-]+$/i.test(p.repo) || !nonnegative(p.number) || !Number.isInteger(p.number) || p.number < 1) return false;
    const counts = ['additions', 'deletions', 'files', 'reviewFindings', 'followUpFixes'];
    const flags = ['userFacing', 'ciPassedFirstTry', 'deployedToProduction'];
    if (Object.keys(p).some((k) => !['repo', 'number', ...counts, ...flags, 'areas', 'risk', 'coverageDelta'].includes(k))) return false;
    if (counts.some((k) => p[k] !== undefined && (!nonnegative(p[k]) || !Number.isInteger(p[k])))) return false;
    if (flags.some((k) => p[k] !== undefined && typeof p[k] !== 'boolean')) return false;
    if (p.areas !== undefined && (!Array.isArray(p.areas) || p.areas.length > 50 || !p.areas.every(text))) return false;
    if (p.risk !== undefined && !['low', 'medium', 'high'].includes(String(p.risk))) return false;
    if (p.coverageDelta !== undefined && (typeof p.coverageDelta !== 'number' || !Number.isFinite(p.coverageDelta) || Math.abs(p.coverageDelta) > 100)) return false;
  }
  if (v.kind === 'pr.rated' && (!['human', 'llm-judge'].includes(String(v.rater)) || typeof v.rating !== 'number' || !Number.isFinite(v.rating) || v.rating < 1 || v.rating > 5 || (v.rubric !== undefined && !text(v.rubric)))) return false;
  return true;
}

export function recordEvent(input: TelemetryInput): TelemetryEvent {
  assertNoSecrets(input);
  if (!validInput(input)) throw new Error('Invalid telemetry event.');
  const ev = { ...input, v: TELEMETRY_SCHEMA_VERSION, id: `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`, ts: input.ts ? new Date(input.ts).toISOString() : new Date().toISOString() } as TelemetryEvent;
  ensurePrivateDirectory(ashlrHome());
  ensurePrivateDirectory(join(ashlrHome(), 'metrics'));
  const fd = openSync(metricsFile(), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe telemetry file.');
    fchmodSync(fd, 0o600);
    appendFileSync(fd, JSON.stringify(ev) + '\n');
  } finally { closeSync(fd); }
  return ev;
}

export function readTelemetry(): TelemetryEvent[] {
  const file = readPrivateFileCapped(metricsFile(), 64 * 1024 * 1024);
  if (!file) return [];
  if (file.truncated) throw new Error('Telemetry exceeds the local read limit.');
  return file.text.split('\n').flatMap((line) => {
    try {
      const e: unknown = JSON.parse(line);
      if (!object(e) || e.v !== TELEMETRY_SCHEMA_VERSION || !text(e.id) || !text(e.ts)) return [];
      const { v: _v, id: _id, ...input } = e;
      if (!validInput(input)) return [];
      assertNoSecrets(e);
      return [{ ...input, v: TELEMETRY_SCHEMA_VERSION, id: e.id, ts: e.ts } as TelemetryEvent];
    } catch { return []; }
  });
}
